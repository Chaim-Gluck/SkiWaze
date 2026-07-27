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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** A flat traverse whose ends differ by more than this (m) is suspicious (a "flat" that climbs). */
const UPHILL_FLAT_TOL = 5;

/** Contiguous unrated (orange) "connection" chains longer than this (m) are flagged for review. */
const LONG_CONNECTION_M = 250;

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

export interface AuditResult {
  reversal: string[];
  disconnected: string[];
  longConnections: string[];
  uphillFlats: number;
}

/** Audit a compiled resort graph for false-elevation / non-skiable-connection issues. */
export function auditGraph(graph: ResortGraph): AuditResult {
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
      disconnected.push(`${n.id} @${ele(n.id)}m [${n.kind}] nearest-lift ${d}m; skis out [${emits.join(', ')}]\n      ${link}`);
    }
  }

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

  return { reversal, disconnected, longConnections: longConns, uphillFlats };
}

/** One-line summary for build output (empty string when nothing actionable). */
export function auditSummary(r: AuditResult): string {
  const parts: string[] = [];
  if (r.reversal.length) parts.push(`${r.reversal.length} reversal candidate(s)`);
  if (r.longConnections.length) parts.push(`${r.longConnections.length} long connection(s)`);
  return parts.join(', ');
}

function printAudit(id: string, r: AuditResult): void {
  console.log(`\n=== ${id} ===`);
  console.log(`REVERSAL candidates (false-peak, fix via setNodeElevation): ${r.reversal.length}`);
  r.reversal.forEach((s) => console.log('  ⚑ ' + s));
  console.log(`DISCONNECTED tops (missing connector / mapping gap): ${r.disconnected.length}`);
  r.disconnected.forEach((s) => console.log('  x ' + s));
  console.log(`LONG connections (>${LONG_CONNECTION_M}m, review skiable vs road/bus): ${r.longConnections.length}`);
  r.longConnections.forEach((s) => console.log('  ↔ ' + s));
  console.log(`(supplementary) uphill "flat" traverses Δ>${UPHILL_FLAT_TOL}m, non-synthetic: ${r.uphillFlats}`);
}

function main(): void {
  const id = process.argv[2];
  const ids = id ? [id] : listResorts();
  let totR = 0;
  let totL = 0;
  for (const r of ids) {
    const res = auditGraph(loadGraph(r));
    printAudit(r, res);
    totR += res.reversal.length;
    totL += res.longConnections.length;
  }
  console.log(`\nTOTAL: ${totR} reversal candidates, ${totL} long connections across ${ids.length} resort(s).`);
}

// Run as a CLI only (not when imported by the build).
if (process.argv[1] && process.argv[1].includes('_phantoms')) main();
