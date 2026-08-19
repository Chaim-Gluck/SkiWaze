// Regenerates the "over-rim critical arcs" debug overlay for the map debug tool.
// Usage: node pipeline/debug/genOverRimOverlay.mjs
// Writes: public/devtools/overlays/over-rim-arcs.json  (generic overlay format)
//
// A "connectivity-critical over-rim arc" is an area (open-bowl) perimeter arc whose interior
// polyline climbs > CLIMB m above BOTH endpoints (so it hides a rim), AND whose removal would
// strand at least one node (leave it unable to reach any lift). These are the arcs we must NOT
// simply delete. Re-run after rebuilding resort data (node ids change on data:refresh).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESORTS = ['ischgl-samnaun', 'tignes-val-disere', 'val-thorens-3vallees', 'soelden', 'sella-ronda', 'cervinia-zermatt', 'les-deux-alpes', 'st-anton-arlberg'];
const CLIMB = 30;

function bfs(adj, seeds) {
  const seen = new Set(seeds);
  const q = [...seeds];
  while (q.length) { const c = q.shift(); for (const n of adj.get(c) ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); } }
  return seen;
}
function trappedSet(nodes, edges) {
  const rev = new Map();
  for (const e of edges) (rev.get(e.to) ?? rev.set(e.to, []).get(e.to)).push(e.from);
  const lifts = nodes.filter((n) => n.kind === 'lift_station').map((n) => n.id);
  const canReach = bfs(rev, lifts);
  return new Set(nodes.filter((n) => !canReach.has(n.id)).map((n) => n.id));
}

const overlay = {};
for (const id of RESORTS) {
  const gp = path.join(ROOT, 'public', 'resorts', id, 'graph.json');
  if (!fs.existsSync(gp)) continue;
  const g = JSON.parse(fs.readFileSync(gp, 'utf8'));
  const nb = new Map(g.nodes.map((n) => [n.id, n]));
  const baseTrapped = trappedSet(g.nodes, g.edges);
  const seen = new Set();
  const lines = [];
  const points = [];
  const bounds = [[Infinity, Infinity], [-Infinity, -Infinity]];
  const grow = (lon, lat) => { bounds[0][0] = Math.min(bounds[0][0], lon); bounds[0][1] = Math.min(bounds[0][1], lat); bounds[1][0] = Math.max(bounds[1][0], lon); bounds[1][1] = Math.max(bounds[1][1], lat); };
  const rows = [];
  for (const e of g.edges) {
    if (!e.area) continue;
    const G = e.geometry || [];
    if (G.length < 3) continue;
    const a = nb.get(e.from), b = nb.get(e.to);
    if (!a || !b || a.point.ele == null || b.point.ele == null) continue;
    const endHi = Math.max(a.point.ele, b.point.ele);
    let maxI = -1, maxE = -Infinity;
    for (let i = 1; i < G.length - 1; i++) if (G[i].ele != null && G[i].ele > maxE) { maxE = G[i].ele; maxI = i; }
    if (maxI < 0 || maxE - endHi <= CLIMB) continue;
    const key = [e.from, e.to].sort().join('|');
    if (seen.has(key)) continue; seen.add(key);
    const kept = g.edges.filter((x) => !((x.from === e.from && x.to === e.to) || (x.from === e.to && x.to === e.from)));
    const added = [...trappedSet(g.nodes, kept)].filter((x) => !baseTrapped.has(x));
    if (!added.length) continue;
    const climb = Math.round(maxE - endHi);
    lines.push({ coords: G.map((p) => [p.lon, p.lat]), color: '#e11', width: 4, label: `${e.from}<->${e.to}: climbs +${climb} m over ${Math.round(e.lengthM)} m` });
    G.forEach((p) => grow(p.lon, p.lat));
    points.push({ at: [G[0].lon, G[0].lat], color: '#1560ff', r: 15, tag: e.from, label: `Endpoint ${e.from} · ${Math.round(a.point.ele)} m` });
    points.push({ at: [G[G.length - 1].lon, G[G.length - 1].lat], color: '#1560ff', r: 15, tag: e.to, label: `Endpoint ${e.to} · ${Math.round(b.point.ele)} m` });
    points.push({ at: [G[maxI].lon, G[maxI].lat], color: '#111111', r: 16, tag: 'rim', label: `Interior rim high · ${Math.round(maxE)} m (+${climb} m above endpoints)` });
    for (const nid of added) { const n = nb.get(nid); points.push({ at: [n.point.lon, n.point.lat], color: '#ff8c00', r: 26, tag: nid, label: `STRANDED if arc removed · node ${nid} · ${Math.round(n.point.ele)} m` }); }
    rows.push(`${e.from}<->${e.to} (+${climb} m, strands ${added.length})`);
  }
  if (!lines.length) continue;
  overlay[id] = {
    focus: { bounds },
    lines, points,
    notes: `<b>${lines.length} connectivity-critical over-rim arc(s).</b> Each red line looks flat end-to-end (blue endpoints ~ equal height) but bulges up to the black rim point in between, so it can't be a free flat traverse; yet deleting it strands the orange node. When an orange halo surrounds a blue dot, the endpoint itself is the node that gets stranded. Arcs: ${rows.join('; ')}.`,
  };
}
fs.writeFileSync(path.join(ROOT, 'public', 'devtools', 'overlays', 'over-rim-arcs.json'), JSON.stringify(overlay, null, 2));
console.log('wrote public/devtools/overlays/over-rim-arcs.json for resorts:', Object.keys(overlay).join(', '));
