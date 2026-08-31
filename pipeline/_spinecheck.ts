/**
 * Report-only: does each polygon's spine actually cross its polygon, down the fall line?
 *
 * A spine is supposed to be the centreline a skier follows from the top of an `area=yes` polygon to
 * the bottom. Nothing checks that today: the spine is adopted from whichever OSM way of the same
 * named run happens to touch the ring, so a run that merely clips a corner, or a handful of stubs
 * around one junction, can become the "centreline" of a polygon it never crosses.
 *
 * Three numbers per polygon, and the second is the one that matters:
 *   drop   spine's own descent over the polygon's top-to-bottom drop. Near 0 = it does not descend,
 *          so it is not carrying anyone down the mountain.
 *   angle  between the spine's end-to-end vector and the polygon's fall line. On its own this cries
 *          wolf -- a cat-track ribbon or a flat shelf legitimately runs across the slope -- so it is
 *          reported for context, never used to rank.
 *   span   spine extent over the polygon's length (the existing `spanFrac`).
 *   cover  spine extent over the polygon's extent, both projected onto the polygon's own long axis.
 *          This is the one that catches a spine which is *healthy* but *short*: a 400m spine down a
 *          1400m ribbon descends plenty, so `drop` is happy, yet two thirds of the polygon has no
 *          centreline. Only `cover` sees that. A spine is interior, so it can never reach the ring's
 *          extremes -- a good one lands around 0.8-0.95, not 1.0.
 *
 * Elevations come from the built graph's own nodes, sampled at the ring: the same numbers the router
 * uses, so a complaint here is a complaint about shipped data rather than about a second DEM.
 *
 * TWO YARDSTICKS, because there are two kinds of polygon. Everything above assumes the polygon IS a
 * run, with a top, a bottom and a length to be covered. A CORRIDOR is not: it is the join between
 * its neighbours, and the builder deliberately spines it gateway-to-gateway rather than end-to-end.
 * Judging one on `drop` and axis `cover` marks it down for obeying its own design, so a corridor
 * gets neither test -- it is judged on `gwCover` instead, how much of its gateway-to-gateway span
 * the spine actually covers. See `gatewayCoverage`.
 *
 * Usage: npx tsx pipeline/_spinecheck.ts <resortId|all> [dropThreshold]
 */
import { RESORTS } from '../src/config/resorts';
import { DEFAULT_GRAPH_CONSTANTS } from '../src/config/graphConstants';
import { fetchResortOsm } from './lib/overpass';
import { normalizeLift, normalizePiste } from './lib/normalize';
import { enrichElevations } from './lib/elevation';
import { buildResortGraph } from './lib/buildGraph';
import { buildSkeletons } from './lib/areaSkeleton';
import { SKEL_COLORS } from './lib/skelColors';

const M_PER_DEG = 111_320;

interface Row {
  resort: string;
  wayId: number;
  label: string;
  dropRatio: number;
  spineDropM: number;
  polyDropM: number;
  angleDeg: number;
  spanFrac: number;
  cover: number;
  axisM: number;
  /** Coverage measured gateway-to-gateway instead of end-to-end. Corridors only; 0 elsewhere. */
  coverGw: number;
  /** Distance between the two farthest-apart gateways. Corridors only; 0 elsewhere. */
  gwSpanM: number;
  synth: boolean;
  /** The builder took this spine's termini from the gateway pair, not the extremity sweep. */
  corridor: boolean;
  lenM: number;
  at: [number, number];
}

/**
 * Elevation anywhere inside a polygon, by nearest built-graph node.
 *
 * The spine is synthesised geometry, so its vertices are not graph nodes and have no elevation of
 * their own. Every polygon is ringed by nodes that do, and a spine point is by construction inside
 * that ring, so the nearest one is a fair sample -- and crucially it is the *shipped* elevation,
 * so this measures the data the router actually has.
 */
function nearestEle(pts: { lon: number; lat: number; ele: number }[], lon: number, lat: number): number | null {
  const k = Math.cos((lat * Math.PI) / 180);
  let best: number | null = null;
  let bd = Infinity;
  for (const p of pts) {
    const d = Math.hypot((p.lon - lon) * k, p.lat - lat);
    if (d < bd) {
      bd = d;
      best = p.ele;
    }
  }
  return best;
}

/**
 * How much of the polygon's length the spine actually covers.
 *
 * Both are projected onto the polygon's own long axis, found by the standard two-sweep
 * approximation (farthest vertex from the centroid, then farthest from that). Measuring along the
 * axis rather than end-to-end is what makes this immune to a winding spine: a spine that snakes but
 * still runs top-to-bottom scores high, while a straight spine parked in the middle scores low.
 */
function axisCoverage(
  ring: { lon: number; lat: number }[],
  pieces: [number, number][][],
): { cover: number; axisM: number } {
  if (ring.length < 3) return { cover: 1, axisM: 0 };
  const k = Math.cos((ring[0].lat * Math.PI) / 180);
  const cx = ring.reduce((s, p) => s + p.lon, 0) / ring.length;
  const cy = ring.reduce((s, p) => s + p.lat, 0) / ring.length;
  const far = (ox: number, oy: number) => {
    let b = ring[0];
    let bd = -1;
    for (const p of ring) {
      const d = Math.hypot((p.lon - ox) * k, p.lat - oy);
      if (d > bd) { bd = d; b = p; }
    }
    return b;
  };
  const a = far(cx, cy);
  const b = far(a.lon, a.lat);
  let ux = (b.lon - a.lon) * k;
  let uy = b.lat - a.lat;
  const ul = Math.hypot(ux, uy);
  if (ul <= 0) return { cover: 1, axisM: 0 };
  ux /= ul;
  uy /= ul;
  const proj = (lon: number, lat: number) => ((lon - a.lon) * k * ux + (lat - a.lat) * uy) * M_PER_DEG;
  let rMin = Infinity;
  let rMax = -Infinity;
  for (const p of ring) {
    const t = proj(p.lon, p.lat);
    if (t < rMin) rMin = t;
    if (t > rMax) rMax = t;
  }
  const axisM = rMax - rMin;
  // Per-piece intervals, merged -- NOT the overall min..max extent. Taking the extent was a real
  // measurement bug: a spine that arrives in fragments with holes in the middle projects to exactly
  // the same sMin..sMax as an unbroken one, so the metric scored a gappy spine as perfect and was
  // structurally blind to the very defect the stitch and coverage passes exist to fix. Raising the
  // stitch ceiling moved individual polygons from 88% to 97% while this number did not budge at all.
  const iv: [number, number][] = [];
  for (const piece of pieces) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const [lon, lat] of piece) {
      const t = proj(lon, lat);
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    if (hi > lo) iv.push([lo, hi]);
  }
  if (iv.length === 0 || axisM <= 0) return { cover: 0, axisM };
  iv.sort((x, y) => x[0] - y[0]);
  let covered = 0;
  let [cs, ce] = iv[0];
  for (let i = 1; i < iv.length; i++) {
    if (iv[i][0] <= ce) ce = Math.max(ce, iv[i][1]);
    else {
      covered += ce - cs;
      [cs, ce] = iv[i];
    }
  }
  covered += ce - cs;
  return { cover: covered / axisM, axisM };
}

/**
 * The corridor yardstick: coverage measured gateway-to-gateway, not end-to-end.
 *
 * `axisCoverage` above asks "does the spine run the length of the polygon", which is the right
 * question for a ribbon and the wrong one for a corridor. A corridor is not a run in its own right,
 * it is the join between its neighbours, and the builder deliberately terminates its spine at the
 * two farthest-apart GATEWAYS rather than at the rim extremities -- because ending at a rim corner
 * would make a skier crossing it detour out to the corner and back. Grading that spine against the
 * long axis therefore penalises it for obeying its own design: measured over the fleet, corridors
 * score a median 0.74 against 0.96 for every other polygon, and five of 33 land under 0.55, escaping
 * the report only because they are too short to clear the axis-length gate. That is luck, not a
 * clean bill of health.
 *
 * So judge a corridor against what it was built to do: project onto the axis joining its two
 * farthest gateways, and ask how much of THAT span the spine covers. Same merged-interval treatment
 * as above, for the same reason -- fragmentation must stay visible.
 */
function gatewayCoverage(
  gateways: [number, number][],
  pieces: [number, number][][],
): { cover: number; spanM: number } {
  if (gateways.length < 2) return { cover: 0, spanM: 0 };
  const k = Math.cos((gateways[0][1] * Math.PI) / 180);
  let a = gateways[0];
  let b = gateways[1];
  let bd = -1;
  for (let i = 0; i < gateways.length; i++)
    for (let j = i + 1; j < gateways.length; j++) {
      const d = Math.hypot((gateways[i][0] - gateways[j][0]) * k, gateways[i][1] - gateways[j][1]);
      if (d > bd) { bd = d; a = gateways[i]; b = gateways[j]; }
    }
  const spanM = bd * M_PER_DEG;
  if (spanM <= 0) return { cover: 0, spanM: 0 };
  const ux = ((b[0] - a[0]) * k) / bd;
  const uy = (b[1] - a[1]) / bd;
  const proj = (lon: number, lat: number) => ((lon - a[0]) * k * ux + (lat - a[1]) * uy) * M_PER_DEG;
  const iv: [number, number][] = [];
  for (const piece of pieces) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const [lon, lat] of piece) {
      // Clamped to the gateway span: a spine overshooting a gateway is not extra coverage, and left
      // unclamped a long arm past one end would mask a hole in the middle.
      const t = Math.max(0, Math.min(spanM, proj(lon, lat)));
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    if (hi > lo) iv.push([lo, hi]);
  }
  if (!iv.length) return { cover: 0, spanM };
  iv.sort((x, y) => x[0] - y[0]);
  let covered = 0;
  let [cs, ce] = iv[0];
  for (let i = 1; i < iv.length; i++) {
    if (iv[i][0] <= ce) ce = Math.max(ce, iv[i][1]);
    else {
      covered += ce - cs;
      [cs, ce] = iv[i];
    }
  }
  covered += ce - cs;
  return { cover: covered / spanM, spanM };
}

async function run(id: string): Promise<Row[]> {
  const resort = RESORTS.find((r) => r.id === id);
  if (!resort) return [];
  // Rebuild the FIRST-PASS graph, the one that still contains the polygons. Reading
  // `public/resorts/<id>/graph.json` is what this used to do and it silently stopped working: the
  // shipped graph is the *second* pass, in which every `area=yes` perimeter has already been
  // replaced by its skeleton, so it holds zero area edges. `buildSkeletons` then had nothing to
  // measure and this reported a clean bill of health for every resort. Reproducing `build.ts`'s
  // first pass is the only way to see the polygons -- and it still judges against shipped
  // elevations, because those come from the same enrichment the real build uses.
  const osm = await fetchResortOsm(resort, { refresh: false, ttlDays: 3650 });
  if (!osm.pistes.length) return [];
  const pistes = osm.pistes.map(normalizePiste);
  const lifts = osm.lifts.map(normalizeLift);
  await enrichElevations([...pistes.map((p) => p.points), ...lifts.map((l) => l.points)]);
  const graph = buildResortGraph(resort.id, pistes, lifts, DEFAULT_GRAPH_CONSTANTS);
  const res = buildSkeletons(graph, pistes);
  const nodes = graph.nodes
    .filter((n) => n.point.ele != null)
    .map((n) => ({ lon: n.point.lon, lat: n.point.lat, ele: n.point.ele as number }));
  const ringByWay = new Map(pistes.filter((p) => p.area).map((p) => [p.wayId, p.points]));
  const rows: Row[] = [];
  for (const r of res) {
    // Stitches count towards coverage: a stitched spine is a continuous one, and a routed stitch is
    // real skiable centreline through the polygon exactly like a synthesised piece.
    const pieces = [...r.skel.spinePieces, ...r.skel.stitches].filter((p) => p.length >= 2);
    // Coverage only (deliberately NOT in `pieces`, which also feeds the descent/direction stats --
    // a bridge is a straight measurement segment, not skiable centreline, and must not be allowed
    // to influence the spine's own drop or bearing). Where one OSM way leaves its polygon and
    // returns, the run is continuous in the graph, so the unpainted gap is not a coverage defect.
    const coverPieces = [...pieces, ...r.skel.wayBridges.filter((p) => p.length >= 2)];
    const ring = ringByWay.get(r.wayId);
    if (!ring?.length) continue;
    // The polygon's own fall line: highest ring point to lowest.
    let hi: { lon: number; lat: number; ele: number } | null = null;
    let lo: { lon: number; lat: number; ele: number } | null = null;
    for (const q of ring) {
      const e = nearestEle(nodes, q.lon, q.lat);
      if (e == null) continue;
      if (!hi || e > hi.ele) hi = { lon: q.lon, lat: q.lat, ele: e };
      if (!lo || e < lo.ele) lo = { lon: q.lon, lat: q.lat, ele: e };
    }
    if (!hi || !lo) continue;
    const polyDropM = hi.ele - lo.ele;
    // The spine, taken end to end over all its pieces: its own descent and its own direction.
    let sHi: [number, number] | null = null;
    let sLo: [number, number] | null = null;
    let sHiE = -Infinity;
    let sLoE = Infinity;
    let lenM = 0;
    const k = Math.cos((hi.lat * Math.PI) / 180);
    for (const piece of pieces) {
      for (let i = 0; i < piece.length; i++) {
        const [lon, lat] = piece[i];
        if (i > 0) {
          const [plon, plat] = piece[i - 1];
          lenM += Math.hypot((lon - plon) * k, lat - plat) * M_PER_DEG;
        }
        const e = nearestEle(nodes, lon, lat);
        if (e == null) continue;
        if (e > sHiE) { sHiE = e; sHi = [lon, lat]; }
        if (e < sLoE) { sLoE = e; sLo = [lon, lat]; }
      }
    }
    const spineDropM = sHi && sLo ? sHiE - sLoE : 0;
    const dropRatio = polyDropM > 0 ? spineDropM / polyDropM : 0;
    const { cover, axisM } = axisCoverage(ring, coverPieces);
    const gw = r.corridor
      ? gatewayCoverage(
          r.points.filter((p) => p.color === SKEL_COLORS.gateway).map((p) => p.at),
          coverPieces,
        )
      : { cover: 0, spanM: 0 };
    let angleDeg = 0;
    if (sHi && sLo) {
      const fx = (lo.lon - hi.lon) * k;
      const fy = lo.lat - hi.lat;
      const sx = (sLo[0] - sHi[0]) * k;
      const sy = sLo[1] - sHi[1];
      const fl = Math.hypot(fx, fy);
      const sl = Math.hypot(sx, sy);
      if (fl > 0 && sl > 0)
        angleDeg = (Math.acos(Math.max(-1, Math.min(1, (fx * sx + fy * sy) / (fl * sl)))) * 180) / Math.PI;
    }
    rows.push({
      resort: id,
      wayId: r.wayId,
      label: r.label,
      dropRatio,
      spineDropM,
      polyDropM,
      angleDeg,
      spanFrac: r.spanFrac,
      cover,
      axisM,
      coverGw: gw.cover,
      gwSpanM: gw.spanM,
      synth: r.synth,
      corridor: r.corridor,
      lenM,
      at: sHi ?? [hi.lon, hi.lat],
    });
  }
  return rows;
}

const arg = process.argv[2] ?? 'all';
const thresh = Number(process.argv[3] ?? 0.35);
const ids = arg === 'all' ? RESORTS.map((r) => r.id) : [arg];
const all: Row[] = [];
for (const id of ids) all.push(...(await run(id)));

// Only polygons with something to descend: a genuinely flat shelf has no fall line to disagree with.
const MIN_POLY_DROP_M = 15;
// Coverage is only meaningful on a polygon long enough for "stops short" to mean anything.
const MIN_AXIS_M = 150;
const COVER_THRESH = 0.55;
// A corridor's gateways can sit as little as 35% of a short chord apart, so the 150 m axis gate that
// guards the ribbon test would exclude essentially every corridor from being checked at all. Below
// this the two gateways are effectively in the same place and the ratio is noise, not a verdict.
const MIN_GW_SPAN_M = 30;
const scored = all.filter((r) => r.polyDropM >= MIN_POLY_DROP_M);
// Corridors are judged separately, below. Both lists here measure a spine against the polygon's own
// fall line and long axis, which presumes the polygon IS a run -- exactly what a corridor is not.
const ribbons = scored.filter((r) => !r.corridor);
const bad = ribbons.filter((r) => r.dropRatio < thresh).sort((a, b) => a.dropRatio - b.dropRatio);
// Deliberately a separate list: these spines descend fine, so the drop test is happy with them. They
// simply do not reach far enough, which is invisible to every other number here.
const short = ribbons
  .filter((r) => r.dropRatio >= thresh && r.axisM >= MIN_AXIS_M && r.cover < COVER_THRESH)
  .sort((a, b) => a.cover - b.cover);
// Corridors: no drop test at all (a join between neighbours has no fall line to disagree with), and
// coverage taken gateway-to-gateway. Not filtered by `polyDropM` for the same reason.
const badGw = all
  .filter((r) => r.corridor && r.gwSpanM >= MIN_GW_SPAN_M && r.coverGw < COVER_THRESH)
  .sort((a, b) => a.coverGw - b.coverGw);

const fmt = (r: Row) =>
  `  ${r.resort} w${r.wayId} drop=${r.dropRatio.toFixed(2)} cover=${r.cover.toFixed(2)}` +
  ` (${(r.cover * r.axisM).toFixed(0)}m of ${r.axisM.toFixed(0)}m axis)` +
  ` angle=${r.angleDeg.toFixed(0)}° len=${r.lenM.toFixed(0)}m` +
  `${r.synth ? ' synth' : ''}  ${r.label}  @${r.at[0].toFixed(5)},${r.at[1].toFixed(5)}`;

const fmtGw = (r: Row) =>
  `  ${r.resort} w${r.wayId} gwCover=${r.coverGw.toFixed(2)}` +
  ` (${(r.coverGw * r.gwSpanM).toFixed(0)}m of ${r.gwSpanM.toFixed(0)}m gateway span)` +
  ` len=${r.lenM.toFixed(0)}m  ${r.label}  @${r.at[0].toFixed(5)},${r.at[1].toFixed(5)}`;

// Report-only escape hatch: every row as CSV, for asking distribution questions this tool's own
// summary cannot answer (e.g. how corridors score against ribbons). SPINEDUMP=1 npm run check:spines
if (process.env.SPINEDUMP) {
  console.log('resort,wayId,corridor,synth,dropRatio,cover,axisM,coverGw,gwSpanM,polyDropM,lenM,spanFrac');
  for (const r of all)
    console.log(
      `${r.resort},${r.wayId},${r.corridor ? 1 : 0},${r.synth ? 1 : 0},${r.dropRatio.toFixed(3)},` +
        `${r.cover.toFixed(3)},${r.axisM.toFixed(0)},${r.coverGw.toFixed(3)},${r.gwSpanM.toFixed(0)},` +
        `${r.polyDropM.toFixed(1)},${r.lenM.toFixed(0)},${r.spanFrac.toFixed(3)}`,
    );
}

console.log(`=== check:spines ${arg} ===`);
console.log(`polygons=${all.length} with a real drop=${scored.length} of which corridors=${all.filter((r) => r.corridor).length}`);
if (ribbons.length) {
  const med = [...ribbons].sort((a, b) => a.dropRatio - b.dropRatio)[Math.floor(ribbons.length / 2)];
  const mc = [...ribbons].sort((a, b) => a.cover - b.cover)[Math.floor(ribbons.length / 2)];
  console.log(`median drop ratio=${med.dropRatio.toFixed(2)} median cover=${mc.cover.toFixed(2)}`);
  // The median is far too coarse to see a partial-coverage regression: a spine can stop 400 m short
  // of the end of a 2 km ribbon and still score a perfectly healthy 0.77, which is above both the
  // median and the flag threshold. Report the tail of the distribution, on the polygons big enough
  // for coverage to mean anything.
  const big = ribbons.filter((r) => r.axisM >= MIN_AXIS_M);
  if (big.length) {
    const under = (t: number): number => big.filter((r) => r.cover < t).length;
    const mean = big.reduce((s, r) => s + r.cover, 0) / big.length;
    console.log(
      `coverage over ${big.length} polygons with axis >= ${MIN_AXIS_M}m:` +
        ` mean=${mean.toFixed(3)}  <0.9: ${under(0.9)}  <0.75: ${under(0.75)}  <0.6: ${under(0.6)}`,
    );
  }
}
{
  const gws = all.filter((r) => r.corridor && r.gwSpanM >= MIN_GW_SPAN_M);
  if (gws.length) {
    const mean = gws.reduce((s, r) => s + r.coverGw, 0) / gws.length;
    console.log(
      `gateway coverage over ${gws.length} corridors with span >= ${MIN_GW_SPAN_M}m: mean=${mean.toFixed(3)}` +
        `  <0.9: ${gws.filter((r) => r.coverGw < 0.9).length}  <0.75: ${gws.filter((r) => r.coverGw < 0.75).length}`,
    );
  }
}

console.log(`\n--- does not descend (drop < ${thresh}): ${bad.length} ---`);
for (const r of bad.slice(0, 40)) console.log(fmt(r));
if (bad.length > 40) console.log(`  … and ${bad.length - 40} more`);

console.log(`\n--- descends but stops short (cover < ${COVER_THRESH}, axis >= ${MIN_AXIS_M}m): ${short.length} ---`);
for (const r of short.slice(0, 40)) console.log(fmt(r));
if (short.length > 40) console.log(`  … and ${short.length - 40} more`);

console.log(
  `\n--- corridor spine misses its gateways (gwCover < ${COVER_THRESH}, span >= ${MIN_GW_SPAN_M}m): ${badGw.length} ---`,
);
for (const r of badGw.slice(0, 40)) console.log(fmtGw(r));
if (badGw.length > 40) console.log(`  … and ${badGw.length - 40} more`);
