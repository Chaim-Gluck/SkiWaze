/**
 * Report-only: which spine pieces did a polygon actually end up with, and where do they sit?
 *
 * `check:spines` reports a single `cover` number. When that number is low the next question is
 * always the same: was a candidate centreline never adopted, or was it adopted and then clipped to
 * nothing? This prints every surviving spine piece projected onto the polygon's long axis, so the
 * gap is visible directly and can be compared against `_portalprobe`'s candidate list.
 *
 * Usage: npx tsx pipeline/_spineparts.ts <resortId> <wayId...>
 */
import { RESORTS } from '../src/config/resorts';
import { DEFAULT_GRAPH_CONSTANTS } from '../src/config/graphConstants';
import { fetchResortOsm } from './lib/overpass';
import { normalizeLift, normalizePiste } from './lib/normalize';
import { enrichElevations } from './lib/elevation';
import { buildResortGraph } from './lib/buildGraph';
import { buildSkeletons } from './lib/areaSkeleton';

const M_PER_DEG = 111_320;

const id = process.argv[2];
const want = new Set(process.argv.slice(3).map((s) => Number(s.replace(/^w/, ''))));
const resort = RESORTS.find((r) => r.id === id);
if (!resort) throw new Error(`unknown resort ${id}`);

const osm = await fetchResortOsm(resort, { refresh: false, ttlDays: 3650 });
const pistes = osm.pistes.map(normalizePiste);
const lifts = osm.lifts.map(normalizeLift);
await enrichElevations([...pistes.map((p) => p.points), ...lifts.map((l) => l.points)]);
const graph = buildResortGraph(resort.id, pistes, lifts, DEFAULT_GRAPH_CONSTANTS);
const res = buildSkeletons(graph, pistes);
const ringByWay = new Map(pistes.filter((p) => p.area).map((p) => [p.wayId, p.points]));

for (const r of res) {
  if (!want.has(r.wayId)) continue;
  const ring = ringByWay.get(r.wayId);
  if (!ring?.length) continue;
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
  const ul = Math.hypot(ux, uy) || 1;
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
  const synth = new Set(r.skel.synthSpines.map((s) => JSON.stringify(s)));
  const stitchSet = new Set(r.skel.stitches.map((s) => JSON.stringify(s)));
  const bridgeSet = new Set(r.skel.wayBridges.map((s) => JSON.stringify(s)));
  console.log(`\n=== w${r.wayId} ${r.label} axis=${(rMax - rMin).toFixed(0)}m centre=${cx.toFixed(5)},${cy.toFixed(5)} stitches=${r.stitches} splitComps=${r.splitComps}  spineWayIds=[${(r.spineWayIds ?? []).join(',')}]`);
  const parts = [...r.skel.spinePieces, ...r.skel.stitches, ...r.skel.wayBridges]
    .filter((p) => p.length >= 2)
    .map((p) => {
      let lo = Infinity;
      let hi = -Infinity;
      let len = 0;
      for (let i = 0; i < p.length; i++) {
        const t = proj(p[i][0], p[i][1]);
        if (t < lo) lo = t;
        if (t > hi) hi = t;
        if (i > 0) len += Math.hypot((p[i][0] - p[i - 1][0]) * k, p[i][1] - p[i - 1][1]) * M_PER_DEG;
      }
      return { lo: lo - rMin, hi: hi - rMin, len, synth: synth.has(JSON.stringify(p)), stitch: stitchSet.has(JSON.stringify(p)), bridge: bridgeSet.has(JSON.stringify(p)) };
    })
    .sort((x, y) => x.lo - y.lo);
  for (const p of parts)
    console.log(`  piece ${p.lo.toFixed(0)}..${p.hi.toFixed(0)}m  len=${p.len.toFixed(0)}m${p.synth ? '  SYNTH' : ''}${p.stitch ? '  STITCH' : ''}${p.bridge ? '  WAY-BRIDGE' : ''}`);
  // Union of the pieces along the axis: what the polygon would score if the gaps were bridged.
  const merged: [number, number][] = [];
  for (const p of parts.sort((x, y) => x.lo - y.lo)) {
    const last = merged[merged.length - 1];
    if (last && p.lo <= last[1] + 1) last[1] = Math.max(last[1], p.hi);
    else merged.push([p.lo, p.hi]);
  }
  const covered = merged.reduce((s, m) => s + (m[1] - m[0]), 0);
  console.log(`  union ${merged.map((m) => `${m[0].toFixed(0)}..${m[1].toFixed(0)}`).join(' | ')}  = ${((covered / (rMax - rMin)) * 100).toFixed(0)}% of axis`);
}


