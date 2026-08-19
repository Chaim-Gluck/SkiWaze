// Override-integrity audit: catch id-based override entries that went stale after a node/edge
// renumbering (e.g. a past `data:refresh`). Two id-based fields are in use — addConnectors and
// setNodeElevation — and a stale id silently links or edits the WRONG node.
// Usage: tsx pipeline/_overridecheck.ts [resortId|all]
//
// Heuristics (no network):
//   - addConnectors: a flat_traverse/skiable_down connector whose endpoints are far apart is
//     almost certainly stale (real ski links are short). Flag > CONNECTOR_MAX metres.
//   - setNodeElevation: the corrected node should sit within a sane band of its GRAPH NEIGHBOURS
//     (a fix makes a node consistent with its surroundings). If the set elevation differs from
//     EVERY neighbour by a lot, the id now points at an unrelated node. Flag > NEIGHBOUR_MAX m.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResortGraph } from '../src/types/domain';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OVDIR = path.join(ROOT, 'pipeline', 'overrides');
const CONNECTOR_MAX = 250;  // m — a genuine flat link / cat-track is short
const NEIGHBOUR_MAX = 120;  // m — a fix should land within this of at least one neighbour

function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000, dLat = ((b.lat - a.lat) * Math.PI) / 180, dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180, lb = (b.lat * Math.PI) / 180;
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2));
}

interface Overrides {
  setNodeElevation?: { node: string; ele: number }[];
  addConnectors?: { from: string; to: string; kind: string; bidirectional?: boolean }[];
  mergeNodes?: string[][];
  removeEdges?: string[];
}

function checkResort(id: string): number {
  const ovPath = path.join(OVDIR, `${id}.json`);
  const gPath = path.join(ROOT, 'public', 'resorts', id, 'graph.json');
  if (!fs.existsSync(ovPath) || !fs.existsSync(gPath)) return 0;
  const ov = JSON.parse(fs.readFileSync(ovPath, 'utf8')) as Overrides;
  const g = JSON.parse(fs.readFileSync(gPath, 'utf8')) as ResortGraph;
  const nb = new Map(g.nodes.map((n) => [n.id, n]));
  const nm = (nid: string) => { const p = g.points.find((x) => x.nodeId === nid); return p ? ` "${p.name}"` : ''; };
  // graph-neighbour elevations per node (undirected)
  const nbrEle = new Map<string, number[]>();
  for (const e of g.edges) {
    const ae = nb.get(e.from)?.point.ele, be = nb.get(e.to)?.point.ele;
    if (be != null) (nbrEle.get(e.from) ?? nbrEle.set(e.from, []).get(e.from)!).push(be);
    if (ae != null) (nbrEle.get(e.to) ?? nbrEle.set(e.to, []).get(e.to)!).push(ae);
  }
  const issues: string[] = [];

  for (const c of ov.addConnectors ?? []) {
    const a = nb.get(c.from), b = nb.get(c.to);
    if (!a || !b) { issues.push(`  addConnector ${c.from}<->${c.to}: MISSING NODE (id gone)`); continue; }
    const d = Math.round(haversineM(a.point, b.point));
    if (d > CONNECTOR_MAX) issues.push(`  addConnector ${c.from}<->${c.to}: ${d} m apart (>${CONNECTOR_MAX}) — STALE?`);
  }

  for (const s of ov.setNodeElevation ?? []) {
    const n = nb.get(s.node);
    if (!n) { issues.push(`  setNodeElevation ${s.node}=${s.ele}: MISSING NODE (id gone)`); continue; }
    const nbrs = nbrEle.get(s.node) ?? [];
    if (!nbrs.length) continue; // isolated node — nothing to compare
    const minDiff = Math.min(...nbrs.map((e) => Math.abs(e - s.ele)));
    if (minDiff > NEIGHBOUR_MAX) issues.push(`  setNodeElevation ${s.node}=${s.ele}${nm(s.node)}: ${Math.round(minDiff)} m from its nearest neighbour elevation (>${NEIGHBOUR_MAX}) — WRONG NODE?`);
  }
  for (const grp of ov.mergeNodes ?? []) {
    const pts = grp.map((x) => nb.get(x)).filter(Boolean);
    if (pts.length < 2) continue;
    let max = 0;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) max = Math.max(max, haversineM(pts[i]!.point, pts[j]!.point));
    if (max > CONNECTOR_MAX) issues.push(`  mergeNodes [${grp.join(',')}]: spans ${Math.round(max)} m — STALE?`);
  }

  if (issues.length) {
    console.log(`\n=== ${id}: ${issues.length} suspicious override entr(y/ies) ===`);
    issues.forEach((i) => console.log(i));
  }
  return issues.length;
}

function main(): void {
  const arg = process.argv[2] || 'all';
  let ids: string[];
  if (arg === 'all') ids = fs.readdirSync(OVDIR).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
  else ids = [arg];
  let total = 0;
  for (const id of ids) total += checkResort(id);
  console.log(`\noverride-integrity: ${total} suspicious entr${total === 1 ? 'y' : 'ies'} across ${ids.length} resort(s).`);
  if (!total) console.log('OK: all id-based override entries look valid (connectors short, elevations consistent).');
}

main();
