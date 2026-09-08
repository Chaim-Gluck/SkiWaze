import type { ResortGraph, LiftType, PisteColor } from '../types/domain';

/**
 * Resort figures counted from the routing graph we actually ship.
 *
 * These are deliberately NOT the resort's published numbers and must never be presented as such:
 * we drop dead and non-passenger lifts, exclude off-piste, and OSM is incomplete in places. The
 * panel says so. What they are good for is answering "how big is this place, as the app sees it",
 * which is also the honest frame for the node/edge counts that used to sit in the panel footer.
 */
export interface ResortStats {
  liftCount: number;
  liftsByType: { type: LiftType | 'unknown'; count: number }[];
  pisteM: number;
  /** Named runs only - see `countRuns`. Distance covers unnamed segments too, so the two
   *  populations differ on purpose and the panel's caption says so. */
  runCount: number;
  pisteByColor: { color: PisteColor | 'unknown'; meters: number; runs: number }[];
  offPisteM: number;
  /** Range over skiable ground, not over every node - see `resortStats`. */
  lowEle: number;
  highEle: number;
  nodeCount: number;
  edgeCount: number;
}

const COLOR_ORDER: (PisteColor | 'unknown')[] = ['green', 'blue', 'red', 'black', 'unknown'];

/** Hardest-first, and `unknown` is NOT part of it - see `runColor`. */
const HARDNESS: PisteColor[] = ['black', 'red', 'blue', 'green'];

/**
 * A run's colour when its segments disagree (4.3% of runs fleet-wide): the **hardest rated**
 * one. That is how resorts themselves grade - a run is signposted at its most difficult pitch -
 * so it is a domain rule rather than a tiebreak.
 *
 * `unknown` deliberately loses to every rated colour, which is the opposite of `cost.ts`, where
 * unrated is treated as harder than black. There it is a safety gate: refuse terrain we cannot
 * grade. Here it means "no information", and letting no-information outrank a published grade
 * would hide the grade and inflate the Unrated bucket.
 */
function runColor(colors: Set<PisteColor | 'unknown'>): PisteColor | 'unknown' {
  for (const c of HARDNESS) if (colors.has(c)) return c;
  return 'unknown';
}

/**
 * Count RUNS, not piste edges - the same trap as `countLifts`, since a run is split at every
 * junction it shares with another (Madonna: 394 piste edges for 103 runs).
 *
 * A run is identified by its **closure key** (`ref~name`), so "runs" here means precisely "things
 * you could close from the Closed card", and two sectors sharing a name collapse into one exactly
 * as closing that name would. Unnamed ways are excluded rather than counted per way: they are link
 * segments, not runs, and counting them overshoots badly (Val Thorens 386 -> 987). Measured against
 * published figures the named count lands close - alpe-dhuez 135 vs 135, madonna 103 vs 108,
 * les-deux-alpes 87 vs ~89 - which is the evidence for the rule, not proof it can ever match.
 */
function countRuns(graph: ResortGraph): { total: number; byColor: Map<PisteColor | 'unknown', number> } {
  const runs = new Map<string, Set<PisteColor | 'unknown'>>();
  for (const e of graph.edges) {
    if (e.kind !== 'piste' || e.area || e.synthetic || e.offPiste) continue;
    if (!e.pisteRef && !e.pisteName) continue;
    const key = `${e.pisteRef ?? ''}~${e.pisteName ?? ''}`;
    let set = runs.get(key);
    if (!set) { set = new Set(); runs.set(key, set); }
    set.add(e.color ?? 'unknown');
  }
  const byColor = new Map<PisteColor | 'unknown', number>();
  for (const colors of runs.values()) {
    const c = runColor(colors);
    byColor.set(c, (byColor.get(c) ?? 0) + 1);
  }
  return { total: runs.size, byColor };
}

/**
 * Count LIFTS, not lift edges. `segmentWay` cuts a lift at every junction it shares a node with,
 * so a long line arrives as a dozen edges - the same trap that once ran a whole funicular downhill
 * (see AGENTS, "the near-flat test is decided once per lift"). Named edges collapse by name, which
 * also keeps two distinct lifts between one pair of stations apart (Vanoise Express 1 and 2);
 * unnamed ones collapse by connectivity, since that is the only evidence left that they are one
 * line. Download twins are skipped so a gondola is not counted twice.
 */
function countLifts(graph: ResortGraph): { total: number; byType: Map<LiftType | 'unknown', number> } {
  const up = graph.edges.filter((e) => e.kind === 'lift' && !e.isDownload);
  const parent = new Map<string, string>();
  const add = (k: string) => { if (!parent.has(k)) parent.set(k, k); };
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(k) !== r) { const n = parent.get(k)!; parent.set(k, r); k = n; }
    return r;
  };
  const union = (a: string, b: string) => { add(a); add(b); parent.set(find(a), find(b)); };

  for (const e of up) {
    const self = `e:${e.id}`;
    add(self);
    if (e.liftName) union(self, `n:${e.liftName}`);
    else { union(self, `a:${e.from}`); union(`a:${e.to}`, `a:${e.from}`); }
  }

  const byType = new Map<LiftType | 'unknown', number>();
  const seen = new Set<string>();
  for (const e of up) {
    const root = find(`e:${e.id}`);
    if (seen.has(root)) continue;
    seen.add(root);
    const t = e.liftType ?? 'unknown';
    byType.set(t, (byType.get(t) ?? 0) + 1);
  }
  return { total: seen.size, byType };
}

export function resortStats(graph: ResortGraph): ResortStats {
  const { total, byType } = countLifts(graph);
  const { total: runCount, byColor: runsByColor } = countRuns(graph);

  const byColor = new Map<PisteColor | 'unknown', number>();
  let pisteM = 0;
  let offPisteM = 0;
  for (const e of graph.edges) {
    if (e.kind !== 'piste') continue;
    // Areas are polygon fills kept for connectivity and synthetic pistes are the app's own
    // plumbing; counting either as terrain would inflate the distance with things nobody skis.
    if (e.area || e.synthetic) continue;
    if (e.offPiste) { offPisteM += e.lengthM; continue; }
    pisteM += e.lengthM;
    const c = e.color ?? 'unknown';
    byColor.set(c, (byColor.get(c) ?? 0) + e.lengthM);
  }

  let lowEle = Infinity;
  let highEle = -Infinity;
  // Range over SKIABLE ground only. Walking every node lets a valley station you can neither ski
  // to nor ski from set the low point - Madonna's 790 m is the Pinzolo gondola base and Verbier's
  // 483 m is Riddes-Iserables, which is public transport, not a ski lift. A vertical drop is a
  // skiing statistic, so the honest population is nodes touching a real mapped run. Off-piste
  // counts (it is terrain a skier descends, just unpatrolled); areas and the app's own synthetic
  // plumbing do not.
  const skiable = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind !== 'piste' || e.area || e.synthetic) continue;
    skiable.add(e.from);
    skiable.add(e.to);
  }
  for (const n of graph.nodes) {
    if (!skiable.has(n.id)) continue;
    const ele = n.point.ele;
    if (typeof ele !== 'number' || !Number.isFinite(ele)) continue;
    if (ele < lowEle) lowEle = ele;
    if (ele > highEle) highEle = ele;
  }

  return {
    liftCount: total,
    liftsByType: [...byType.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    pisteM,
    runCount,
    pisteByColor: COLOR_ORDER
      .filter((c) => (byColor.get(c) ?? 0) > 0 || (runsByColor.get(c) ?? 0) > 0)
      .map((color) => ({
        color,
        meters: byColor.get(color) ?? 0,
        runs: runsByColor.get(color) ?? 0,
      })),
    offPisteM,
    lowEle: Number.isFinite(lowEle) ? lowEle : 0,
    highEle: Number.isFinite(highEle) ? highEle : 0,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
  };
}
