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

function audit(id: string): { phantoms: number; uphillFlats: number } {
  const graph = loadGraph(id);
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const ele = (nid: string): number => Math.round(nodeById.get(nid)?.point.ele ?? 0);

  const out = new Map<string, GraphEdge[]>();
  const inc = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (inc.get(e.to) ?? inc.set(e.to, []).get(e.to)!).push(e);
  }

  // 1. Phantom tops: a piste STARTS here, but the only way to arrive is an *uphill* flat
  //    traverse (or nothing). A legit piste-start is a lift top, has a piste descending into
  //    it, or is joined by a genuinely flat/downhill traverse from an equal-or-higher node.
  //    Arriving only from strictly-LOWER nodes means the elevation is almost certainly wrong.
  const phantoms: string[] = [];
  for (const n of graph.nodes) {
    if (n.kind === 'lift_station') continue;
    const outs = out.get(n.id) ?? [];
    const ins = inc.get(n.id) ?? [];
    const emitsPiste = outs.some((e) => e.kind === 'piste');
    if (!emitsPiste) continue;
    const arrivesByLift = ins.some((e) => e.kind === 'lift');
    const arrivesByDescent = ins.some(isDescent);
    if (arrivesByLift || arrivesByDescent) continue;
    // Legit if any flat traverse comes from an equal-or-higher node (within DEM slack).
    const flatIns = ins.filter((e) => e.connectorKind === 'flat_traverse');
    const hasLevelAccess = flatIns.some((e) => ele(e.from) >= ele(n.id) - UPHILL_FLAT_TOL);
    if (hasLevelAccess) continue;
    const flats = flatIns.map((e) => `${e.from}(${ele(e.from)}m)`);
    const emits = outs
      .filter((e) => e.kind === 'piste')
      .map((e) => `${e.pisteRef ? '#' + e.pisteRef + ' ' : ''}${e.pisteName ?? ''}->${e.to}(${ele(e.to)}m)`.trim());
    phantoms.push(
      `${n.id} @ ${ele(n.id)}m — skis out [${emits.join(', ')}]` +
        `; reachable only via flat [${flats.join(', ') || 'nothing'}]`,
    );
  }

  // 2. Uphill "flat" traverses (dedupe by unordered node pair).
  const seen = new Set<string>();
  const uphillFlats: string[] = [];
  for (const e of graph.edges) {
    if (e.connectorKind !== 'flat_traverse') continue;
    const key = [e.from, e.to].sort().join('~');
    if (seen.has(key)) continue;
    seen.add(key);
    const gap = Math.abs(ele(e.to) - ele(e.from));
    if (gap > UPHILL_FLAT_TOL) {
      uphillFlats.push(`${e.from}(${ele(e.from)}m) ~ ${e.to}(${ele(e.to)}m)  Δ${gap}m`);
    }
  }

  console.log(`\n=== ${id} ===`);
  console.log(`phantom tops (piste start with no lift/no incoming descent): ${phantoms.length}`);
  phantoms.forEach((s) => console.log('  ⚑ ' + s));
  console.log(`uphill "flat" traverses (Δ>${UPHILL_FLAT_TOL}m): ${uphillFlats.length}`);
  uphillFlats.slice(0, 40).forEach((s) => console.log('  ↥ ' + s));
  if (uphillFlats.length > 40) console.log(`  … and ${uphillFlats.length - 40} more`);
  return { phantoms: phantoms.length, uphillFlats: uphillFlats.length };
}

function main(): void {
  const id = process.argv[2];
  const ids = id ? [id] : listResorts();
  let totP = 0;
  let totF = 0;
  for (const r of ids) {
    const { phantoms, uphillFlats } = audit(r);
    totP += phantoms;
    totF += uphillFlats;
  }
  console.log(`\nTOTAL: ${totP} phantom tops, ${totF} uphill flats across ${ids.length} resort(s).`);
}

main();
