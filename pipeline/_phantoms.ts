// False-elevation audit for compiled resort graphs.
// Usage: tsx pipeline/_phantoms.ts [resortId]   (no id = scan every resort)
//
// Piste direction is derived from DEM node elevations (buildGraph orients high->low), so a
// single mis-sampled junction elevation silently reverses a segment. Two signals expose it:
//
//   1. "phantom top": a node that a downhill piste STARTS from, but which no lift reaches
//      and no piste/skiable_down descends into. You could ski away from it but never legitimately
//      arrive — physically impossible, so its (or a neighbour's) elevation is almost certainly wrong.
//   2. "uphill flat": a flat_traverse link whose endpoints actually differ in elevation by more
//      than a few metres (a "flat" that really climbs) — the artefact that lets a reversed segment
//      stay connected so it never trips the reachability checks.
//
// Review the flags and correct the bad node via `setNodeElevation` in pipeline/overrides/<id>.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GraphEdge, ResortGraph } from '../src/types/domain';
import { DEFAULT_GRAPH_CONSTANTS } from '../src/config/graphConstants';
import { loadOverrides } from './lib/overrides';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OVERRIDES_DIR = path.join(ROOT, 'pipeline', 'overrides');

/** Nodes a human signed off as legitimate dead ends, so the audit stops re-reporting them. */
export function acceptedDeadEndNodes(id: string): Set<string> {
  const ov = loadOverrides(id, OVERRIDES_DIR);
  const s = new Set<string>();
  for (const a of ov?.acceptedDeadEnds ?? []) for (const n of a.nodes) s.add(n);
  return s;
}

/** A flat traverse whose ends differ by more than this (m) is suspicious (a "flat" that climbs). */
const UPHILL_FLAT_TOL = 5;

/** Contiguous unrated (orange) "connection" chains longer than this (m) are flagged for review. */
const LONG_CONNECTION_M = 250;

/**
 * A pothole's flat escape must climb MORE than this (m) — the tell that you must rise out of a dip.
 *
 * Derived from `maxTraverseClimb`, which is the pipeline's OWN answer to the question this test is
 * actually asking. `buildGraph.ts` gives a near-flat piste a reverse traverse only when
 * `gradeOk && Math.abs(drop) <= maxTraverseClimb` (line ~615), and calls that constant "more than a
 * skate — that's a real slope". So every escape at or under it is a two-way cat-track the builder
 * already certified a skier can get back up: the graph routes it in both directions, and nothing is
 * broken for a human to look at.
 *
 * This has now been wrong twice in the same way, each time because the checker reached for a
 * constant that measures a DIFFERENT physical quantity:
 *   - a hard-coded 3, below even the merge floor, which accused Madonna's `n6200757170` on Skiweg
 *     Campiglio (1631 m) of a 3 m rise over 33 m of two-way flat onto the 5 Laghi blue — original
 *     data, routed across in both directions for as long as the app has existed;
 *   - then `Vmerge` (4 m), which answers "are these two points THE SAME PLACE?" — a statement about
 *     measurement noise, not about a skier. It left exactly six nodes flagged fleet-wide, and all
 *     six escaped along a builder-certified reverse traverse: total ascent 5.0/8.0/6.7/7.0/5.0/7.0 m
 *     at net grades 3.1/5.6/5.9/4.7/3.1/1.6% — every one inside both `maxTraverseClimb` and
 *     `flatGradeMax`. The detector was reporting the terrain the builder had blessed.
 *
 * The rule to carry forward: before trusting a threshold in a checker, find the constant the BUILDER
 * uses for the same physical quantity and derive from it. Do not pick a number that fits the list.
 */
const POTHOLE_CLIMB_TOL = DEFAULT_GRAPH_CONSTANTS.maxTraverseClimb;

/** Ignore potholes fed only by piste stubs shorter than this (m) — cosmetically irrelevant. */
const POTHOLE_MIN_IN_M = 120;
/**
 * How far a flat walk may go looking for a boardable lift before a node stops counting as a real
 * bottom. A run is very often drawn ending a few metres SHORT of the station it serves, joined by a
 * short flat link, so the "can board a lift here" test has to follow those links or it fires on
 * ordinary lift bases.
 *
 * Pinned by a verified case, not swept to a knee — the sweep is a smooth curve with no structural
 * break (25 m -> 72 flagged, 100 -> 43, 150 -> 37, 250 -> 29, 400 -> 26), so any value here is a
 * judgement about what "at the base" means, and a bigger number just silences more. Passo Tonale's
 * "17 Pegra (bottom)" reaches the Sozzine chair base over 142 m of real flat connector, so 150 is
 * the tightest cap that still clears a lift base a human confirmed is correct. Deliberately NOT
 * wider: at 250 m the exemption starts reaching a different part of the mountain.
 */
const POTHOLE_LIFT_WALK_M = 150;


function loadGraph(id: string): ResortGraph {
  const p = path.join(ROOT, 'public', 'resorts', id, 'graph.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')) as ResortGraph;
}

function listResorts(): string[] {
  const dir = path.join(ROOT, 'public', 'resorts');
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'graph.json')))
    .map((d) => d.name);
}

const isDescent = (e: GraphEdge): boolean =>
  e.kind === 'piste' || (e.kind === 'connector' && e.connectorKind === 'skiable_down');

function haversineM(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const osmLink = (lat: number, lon: number): string =>
  `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lon.toFixed(6)}#map=18/${lat.toFixed(6)}/${lon.toFixed(6)}`;

export interface PotholeMark {
  id: string;
  lat: number;
  lon: number;
  ele: number;
  kind: string;
  /** Metres a skier must climb to carry on once they have arrived here. */
  climb: number;
  /** Total length of the descending pistes that end here — how much traffic meets the dip. */
  inLen: number;
  /** The node each descending piste arrives from, with its elevation. */
  inFrom: { id: string; lat: number; lon: number; ele: number }[];
}

export interface AuditResult {
  reversal: string[];
  potholes: string[];
  disconnected: string[];
  /**
   * Disconnected tops suppressed because a human signed the node off in `acceptedDeadEnds`.
   * Reported separately rather than silently dropped, so a sign-off stays visible and auditable.
   */
  disconnectedAccepted: string[];
  longConnections: string[];
  uphillFlats: number;
  /**
   * Machine-readable copy of `potholes`, for the map overlay. The text form is for the console and
   * is not parseable; a defect a human has to eyeball needs to be *on the map*, not in a log line.
   */
  potholeMarks: PotholeMark[];
}

/**
 * Audit a compiled resort graph for false-elevation / non-skiable-connection issues.
 *
 * `acceptedDeadEnds` is the same human sign-off `_trapped.ts` already honours, and it must be
 * honoured here too: a DISCONNECTED top is a node nothing can reach, which is precisely what a
 * signed-off dead end IS. Without it a resort whose dead ends are all understood reports REVIEW
 * forever and `check:resort` can never go green — which is exactly what kept Portes du Soleil red,
 * where all three disconnected tops were already signed off.
 *
 * Deliberately NOT done here: warning about stale entries. `acceptedDeadEnds` covers trapped and
 * orphan nodes generally, most of which never surface as disconnected tops (PdS signs off four
 * groups; only three nodes appear here). Judging staleness from this narrower view would report
 * healthy sign-offs as stale. `_trapped.ts` owns that check and sees the full picture.
 */
export function auditGraph(graph: ResortGraph, acceptedDeadEnds?: Set<string>): AuditResult {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const ele = (nid: string): number => Math.round(nodeById.get(nid)?.point.ele ?? 0);

  const out = new Map<string, GraphEdge[]>();
  const inc = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (inc.get(e.to) ?? inc.set(e.to, []).get(e.to)!).push(e);
  }
  const stations = graph.nodes.filter((n) => n.kind === 'lift_station');
  const nearestStationM = (p: { lon: number; lat: number }): number =>
    stations.reduce((best, s) => Math.min(best, haversineM(p, s.point)), Infinity);

  // Phantom tops: a piste STARTS here, but no lift reaches it and no piste descends into it,
  // and no flat traverse arrives from an equal-or-higher node. Split into two classes:
  //   - REVERSAL: reachable via an *uphill* flat (arriving from strictly-lower nodes) → the
  //     node is a false local peak from a mis-sampled elevation → fix with setNodeElevation.
  //   - DISCONNECTED: nothing reaches it at all → a missing connector / OSM mapping gap
  //     (near a lift = unlinked lift top; far = isolated fragment) → a different fix.
  const reversal: string[] = [];
  const disconnected: string[] = [];
  const disconnectedAccepted: string[] = [];
  for (const n of graph.nodes) {
    if (n.kind === 'lift_station') continue;
    const outs = out.get(n.id) ?? [];
    const ins = inc.get(n.id) ?? [];
    if (!outs.some((e) => e.kind === 'piste')) continue;
    if (ins.some((e) => e.kind === 'lift') || ins.some(isDescent)) continue;
    // A synthetic (app-added) connector is a deliberate bridge → legitimate arrival.
    if (ins.some((e) => e.synthetic)) continue;
    const flatIns = ins.filter((e) => e.connectorKind === 'flat_traverse');
    if (flatIns.some((e) => ele(e.from) >= ele(n.id) - UPHILL_FLAT_TOL)) continue; // legit level access
    const emits = outs
      .filter((e) => e.kind === 'piste')
      .map((e) => `${e.pisteRef ? '#' + e.pisteRef + ' ' : ''}${e.pisteName ?? ''}→${e.to}(${ele(e.to)}m)`.trim());
    const p = nodeById.get(n.id)!.point;
    const link = osmLink(p.lat, p.lon);
    if (flatIns.length > 0) {
      const from = flatIns.map((e) => `${e.from}(${ele(e.from)}m)`).join(', ');
      reversal.push(`${n.id} @${ele(n.id)}m [${n.kind}] climbs-in-from [${from}]; skis out [${emits.join(', ')}]\n      ${link}`);
    } else {
      const d = Math.round(nearestStationM(p));
      const line = `${n.id} @${ele(n.id)}m [${n.kind}] nearest-lift ${d}m; skis out [${emits.join(', ')}]\n      ${link}`;
      if (acceptedDeadEnds?.has(n.id)) disconnectedAccepted.push(line);
      else disconnected.push(line);
    }
  }

  // Pothole sinks (false local minima mid-run): a descent ARRIVES at the node, but no descent
  // leaves it and no lift can be boarded here — the only way onward is a flat traverse that
  // CLIMBS to a node where the descent then RESUMES. This is the inverse of a phantom top: a
  // mis-sampled elevation sinks an interior node below its own downstream neighbour, so the
  // segment past it reverses and both neighbouring pistes point INTO it, leaving a dead-looking
  // dip you can only leave by climbing out over a "flat". The climb-out is the tell that separates
  // a real pothole from an ordinary merge-then-continue junction (whose flat link stays level or
  // descends). Fix with setNodeElevation in pipeline/overrides/<id>.json.
  interface Pothole { id: string; text: string; inLen: number; climb: number; mark: PotholeMark }
  const potholeList: Pothole[] = [];
  const flatOutsOf = (id: string): GraphEdge[] =>
    (out.get(id) ?? []).filter((e) => e.connectorKind === 'flat_traverse' && !e.synthetic && !e.skeletonArm);
  for (const n of graph.nodes) {
    if (n.kind === 'lift_station') continue;
    const outs = out.get(n.id) ?? [];
    const ins = inc.get(n.id) ?? [];
    const descentIns = ins.filter(isDescent);
    if (descentIns.length === 0) continue; // no descent arrives → not a sink
    if (outs.some(isDescent)) continue; // has a real downhill exit → fine
    if (outs.some((e) => e.kind === 'lift')) continue; // can board a lift right here → real bottom
    const flatOuts = flatOutsOf(n.id);
    if (flatOuts.length === 0) continue; // truly terminal → genuine bottom / trapped (other checks)
    // ...and a lift a SHORT, GENUINELY FLAT walk away is equally a real bottom. Mappers routinely
    // end a run just short of the station (Passo Tonale's "33 Valena (bottom)" sits 43 m from the
    // Alpe Alta base, "17 Pegra (bottom)" 142 m from the Sozzine base), so testing only this node's
    // own out-edges reported ordinary lift bases as elevation faults.
    //
    // The walk MUST NOT CLIMB. `connectorKind` is assigned by direction alone in buildGraph.ts
    // (`oneWayDown ? 'skiable_down' : 'flat_traverse'`), so every bidirectional link is labelled a
    // flat traverse however steep it really is - trusting that label let the walk gain up to +14 m.
    // Exempting a node by way of a climbing walk is self-defeating: a pothole is DEFINED as a dip
    // you can only leave by climbing out, so that walk is the very symptom, not a refutation. The
    // gain is therefore held to the same POTHOLE_CLIMB_TOL that decides a climb-out, and a climbing
    // route to a lift does not end the search - a flatter one may still exist.
    let liftWalk = false;
    {
      const seenL = new Set<string>([n.id]);
      const q = flatOuts.map((e) => ({ id: e.to, m: e.lengthM ?? 0 }));
      while (q.length > 0) {
        const { id, m } = q.shift()!;
        if (seenL.has(id) || m > POTHOLE_LIFT_WALK_M) continue;
        seenL.add(id);
        const boardable = (out.get(id) ?? []).some((e) => e.kind === 'lift');
        if (boardable && ele(id) - ele(n.id) <= POTHOLE_CLIMB_TOL) { liftWalk = true; break; }
        for (const e of flatOutsOf(id)) q.push({ id: e.to, m: m + (e.lengthM ?? 0) });
      }
    }
    if (liftWalk) continue;
    // Follow flat traverses (bounded); find where the descent resumes and how high above this node.
    //
    // The resume must be found on REAL TERRAIN. A polygon skeleton `arm` is plumbing the app itself
    // invented for connectivity, so letting one prove that "the descent resumes up there" means the
    // app manufactures its own evidence that the mountain is broken. At Les Gets the Piste des
    // Indiens/Trappeurs junction n13535054703 was reported with a 7 m climb-out purely because the
    // arm pair e3141/e3142 hangs off it: the walk climbed e3142 (+7 m) onto n13535054709 and found
    // e3141 "descending" there - and e3141 descends straight back INTO n13535054703. A resume that
    // returns to the dip is not an escape at all, so the origin is excluded explicitly too. With
    // both guards the search takes the honest route instead, down to the Grand Cry station where
    // Piste des Indiens really does continue (1513 -> 1495 m), and the node stops being reported.
    // `spineDuplicate` is deliberately NOT excluded: that flag marks a real piste that merely
    // parallels an adopted spine, and it is still terrain a skier can ski.
    //
    // Take the LOWEST resume in the whole bounded frontier, never the first one BFS happens to
    // reach. This used to `break` on first-found and report that node's height, so the verdict was
    // decided by edge ordering: Paradiski's n1000000002298 (1699 m, end of Route des Espagnols) has
    // two flat outs, and e1892 -> n257077953 @1702 m is simply stored first, giving +3.0 m — exactly
    // the threshold. One slot behind it in the same queue sat e7724, a 2 m link to sn1000000002298
    // @1700 m (+1.0 m), from which La Forêt continues down 35 m and then 179 m for -16 m. The node
    // was plainly connected downhill on the map and was reported anyway. A pothole is by definition
    // a dip you can only leave BY CLIMBING, so the honest measure is the least climb available;
    // stopping early can only ever over-report. Expansion continues past a node that offers a
    // descent, because a lower resume may lie beyond it.
    const seenFlat = new Set<string>([n.id]);
    const queue = flatOuts.map((e) => ({ id: e.to, hops: 1 }));
    let resumeEle: number | null = null;
    while (queue.length > 0) {
      const { id, hops } = queue.shift()!;
      if (seenFlat.has(id) || hops > 6) continue;
      seenFlat.add(id);
      if ((out.get(id) ?? []).some((e) => isDescent(e) && !e.skeletonArm && e.to !== n.id)) {
        const h = ele(id);
        if (resumeEle === null || h < resumeEle) resumeEle = h;
      }
      for (const e of flatOutsOf(id)) queue.push({ id: e.to, hops: hops + 1 });
    }
    if (resumeEle === null) continue; // flat escape never resumes downhill → not an interior dip
    const climb = resumeEle - ele(n.id);
    if (climb <= POTHOLE_CLIMB_TOL) continue; // within the merge floor → ordinary junction, not a dip
    const inLen = descentIns.reduce((s, e) => s + (e.lengthM ?? 0), 0);
    if (inLen < POTHOLE_MIN_IN_M) continue; // only stub pistes point in → cosmetically irrelevant
    const p = nodeById.get(n.id)!.point;
    const inFrom = descentIns.map((e) => `${e.from}(${ele(e.from)}m)`).join(', ');
    potholeList.push({
      id: n.id,
      inLen,
      climb,
      mark: {
        id: n.id,
        lat: p.lat,
        lon: p.lon,
        ele: ele(n.id),
        kind: n.kind,
        climb,
        inLen: Math.round(inLen),
        inFrom: descentIns.map((e) => {
          const q = nodeById.get(e.from)!.point;
          return { id: e.from, lat: q.lat, lon: q.lon, ele: ele(e.from) };
        }),
      },
      text: `${n.id} @${ele(n.id)}m [${n.kind}] climb-out ${climb}m; descent-in ${Math.round(inLen)}m from [${inFrom}]\n      ${osmLink(p.lat, p.lon)}`,
    });
  }
  potholeList.sort((a, b) => b.inLen - a.inLen);
  const potholes = potholeList.map((p) => p.text);
  const potholeMarks = potholeList.map((p) => p.mark);

  // Supplementary: "flat" traverses that actually climb (>tol), excluding app-added override
  // bridges (eovc*) and synthetic pipeline connectors. Noisy on its own — count only.
  const seen = new Set<string>();
  let uphillFlats = 0;
  for (const e of graph.edges) {
    if (e.connectorKind !== 'flat_traverse' || e.synthetic || e.id?.startsWith('eovc')) continue;
    const key = [e.from, e.to].sort().join('~');
    if (seen.has(key)) continue;
    seen.add(key);
    if (Math.abs(ele(e.to) - ele(e.from)) > UPHILL_FLAT_TOL) uphillFlats++;
  }

  // Long "connections": contiguous unrated (orange) piste chains over the length threshold.
  // These are ski-area links; when very long/near-flat they're often roads or ski-bus routes
  // rather than skiable connectors (grade% helps tell them apart — low grade = likely a road).
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    parent.set(x, parent.get(x) ?? x);
    const p = parent.get(x)!;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string): void => {
    parent.set(find(a), find(b));
  };
  const unrated = graph.edges.filter((e) => e.kind === 'piste' && e.color === 'unknown');
  for (const e of unrated) union(e.from, e.to);
  const comps = new Map<string, { len: number; nodes: Set<string>; names: Set<string> }>();
  for (const e of unrated) {
    const r = find(e.from);
    const c = comps.get(r) ?? { len: 0, nodes: new Set<string>(), names: new Set<string>() };
    c.len += e.lengthM;
    c.nodes.add(e.from);
    c.nodes.add(e.to);
    if (e.pisteName) c.names.add(e.pisteName);
    comps.set(r, c);
  }
  const longConns: string[] = [];
  for (const c of comps.values()) {
    if (c.len < LONG_CONNECTION_M) continue;
    const nodes = [...c.nodes].map((id2) => nodeById.get(id2)!.point);
    const eles = nodes.map((p) => p.ele ?? 0);
    const span = Math.round(Math.max(...eles) - Math.min(...eles));
    const grade = Math.round((span / c.len) * 100);
    const cx = nodes.reduce((s, p) => s + p.lon, 0) / nodes.length;
    const cy = nodes.reduce((s, p) => s + p.lat, 0) / nodes.length;
    longConns.push(
      `${Math.round(c.len)}m span ${span}m (~${grade}% grade) — ${[...c.names].join(' / ') || '(unnamed)'}\n      ${osmLink(cy, cx)}`,
    );
  }
  longConns.sort((a, b) => parseInt(b) - parseInt(a));

  return { reversal, potholes, potholeMarks, disconnected, disconnectedAccepted, longConnections: longConns, uphillFlats };
}

/** One-line summary for build output (empty string when nothing actionable). */
export function auditSummary(r: AuditResult): string {
  const parts: string[] = [];
  if (r.reversal.length) parts.push(`${r.reversal.length} reversal candidate(s)`);
  if (r.potholes.length) parts.push(`${r.potholes.length} pothole sink(s)`);
  if (r.longConnections.length) parts.push(`${r.longConnections.length} long connection(s)`);
  return parts.join(', ');
}

function printAudit(id: string, r: AuditResult): void {
  console.log(`\n=== ${id} ===`);
  console.log(`REVERSAL candidates (false-peak, fix via setNodeElevation): ${r.reversal.length}`);
  r.reversal.forEach((s) => console.log('  ⚑ ' + s));
  console.log(`POTHOLE sinks (false local-min mid-run, fix via setNodeElevation): ${r.potholes.length}`);
  r.potholes.forEach((s) => console.log('  ⚑ ' + s));
  console.log(`DISCONNECTED tops (missing connector / mapping gap): ${r.disconnected.length}`);
  r.disconnected.forEach((s) => console.log('  x ' + s));
  if (r.disconnectedAccepted.length) {
    console.log(`  (+ ${r.disconnectedAccepted.length} signed off in acceptedDeadEnds, not counted above)`);
    r.disconnectedAccepted.forEach((s) => console.log('  ✓ ' + s));
  }
  console.log(`LONG connections (>${LONG_CONNECTION_M}m, review skiable vs road/bus): ${r.longConnections.length}`);
  r.longConnections.forEach((s) => console.log('  ↔ ' + s));
  console.log(`(supplementary) uphill "flat" traverses Δ>${UPHILL_FLAT_TOL}m, non-synthetic: ${r.uphillFlats}`);
}

function main(): void {
  const id = process.argv[2];
  const ids = id ? [id] : listResorts();
  let totR = 0;
  let totP = 0;
  let totL = 0;
  const overlay: Record<string, { lines: unknown[]; points: unknown[] }> = {};
  for (const r of ids) {
    const res = auditGraph(loadGraph(r), acceptedDeadEndNodes(r));
    printAudit(r, res);
    totR += res.reversal.length;
    totP += res.potholes.length;
    totL += res.longConnections.length;
    if (res.potholeMarks.length) overlay[r] = potholeOverlay(res.potholeMarks);
  }
  writePotholeOverlay(overlay, ids);
  console.log(
    `\nTOTAL: ${totR} reversal candidates, ${totP} pothole sinks, ${totL} long connections across ${ids.length} resort(s).`,
  );
}

/** Overlay shape for one resort: a marker per dip, plus the descending pistes that feed it. */
function potholeOverlay(marks: PotholeMark[]): { lines: unknown[]; points: unknown[] } {
  const lines: unknown[] = [];
  const points: unknown[] = [];
  for (const m of marks) {
    for (const f of m.inFrom) {
      lines.push({ coords: [[f.lon, f.lat], [m.lon, m.lat]], color: '#16a34a', width: 3 });
      points.push({
        at: [f.lon, f.lat],
        color: '#16a34a',
        r: 7,
        tag: `${f.ele} m`,
        label: `<b>${f.id}</b> ${f.ele} m<br>a descending piste leaves here and ends in the dip`,
      });
    }
    // Severity is the climb-out, because that is what a skier actually feels.
    const hot = m.climb >= 6;
    points.push({
      at: [m.lon, m.lat],
      color: hot ? '#dc2626' : '#f59e0b',
      r: 13,
      tag: `-${m.climb} m`,
      label:
        `<b>${m.id}</b> ${m.ele} m [${m.kind}]<br>` +
        `<b>climb-out ${m.climb} m</b> — you arrive here and must climb to carry on<br>` +
        `${m.inLen} m of descending piste ends here<br>` +
        `both DEMs agree at this node, so only the contours can settle it`,
    });
  }
  return { lines, points };
}

/**
 * MERGES into the committed overlay rather than replacing it: `check:audit <id>` covers one resort,
 * so a plain write would silently drop the other seventeen and take them off the debug map. Only the
 * resorts this run actually examined are touched - a resort whose last dip was fixed is removed, so
 * the file cannot accumulate stale marks either.
 *
 * The empty guard keys on "did we EXAMINE anything", not "did we FIND anything" - the two are not
 * the same claim, and `_areaskel.ts`/`_basins.ts` (which refuse on no-findings) cost us the spine
 * overlay once by conflating them. A run that loaded 18 graphs and found no dip has produced a
 * RESULT, and suppressing it is actively harmful: it pins the reviewer's map to the last non-empty
 * state, so every fixed node keeps its marker and gets clicked again. That is precisely how six
 * already-cleared nodes stayed on screen long enough to be re-reviewed one by one. A broken run,
 * by contrast, examines nothing - so that, and only that, is what refuses to write.
 */
function writePotholeOverlay(overlay: Record<string, unknown>, ids: string[]): void {
  const dir = path.join(ROOT, 'public', 'devtools', 'overlays');
  const file = path.join(dir, 'pothole-sinks.json');
  if (!ids.length) {
    console.log(`\n(no resort examined — overlay left as-is, not truncated)`);
    return;
  }
  let merged: Record<string, unknown> = {};
  try {
    merged = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    merged = {};
  }
  for (const id of ids) delete merged[id];
  Object.assign(merged, overlay);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged));
  console.log(
    `\nwrote overlay: public/devtools/overlays/pothole-sinks.json (${Object.keys(merged).length} resort(s), ${ids.length} refreshed this run)`,
  );
}

// Run as a CLI only (not when imported by the build).
if (process.argv[1] && process.argv[1].includes('_phantoms')) main();
