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
  pisteByColor: { color: PisteColor | 'unknown'; meters: number }[];
  offPisteM: number;
  /** Range over skiable ground, not over every node - see `resortStats`. */
  lowEle: number;
  highEle: number;
  nodeCount: number;
  edgeCount: number;
}

const COLOR_ORDER: (PisteColor | 'unknown')[] = ['green', 'blue', 'red', 'black', 'unknown'];

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
    pisteByColor: COLOR_ORDER
      .filter((c) => (byColor.get(c) ?? 0) > 0)
      .map((color) => ({ color, meters: byColor.get(color)! })),
    offPisteM,
    lowEle: Number.isFinite(lowEle) ? lowEle : 0,
    highEle: Number.isFinite(highEle) ? highEle : 0,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
  };
}
