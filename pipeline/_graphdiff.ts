/**
 * Structural graph diff: prove a pipeline change only relabelled the graph.
 *
 * Compares the committed graph.json for a resort against the one in the working tree by
 * matching nodes on POSITION rather than id, then checking that every edge survives with the
 * same endpoints, kind, geometry and length. That is exactly what is needed to land an id
 * scheme change safely: ids may differ everywhere, but nothing else may move.
 *
 * Usage: npm run check:graphdiff <resortId|all> [gitRef]   (gitRef defaults to HEAD)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ResortGraph, GraphEdge } from '../src/types/domain';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readRef(ref: string, rel: string): ResortGraph | null {
  try {
    // execFileSync (not a shell) keeps the output as raw bytes, so JSON parses cleanly on Windows.
    const buf = execFileSync('git', ['show', `${ref}:${rel}`], { cwd: ROOT, maxBuffer: 1 << 30 });
    return JSON.parse(buf.toString('utf8')) as ResortGraph;
  } catch {
    return null;
  }
}

/** Position key: two nodes are "the same node" when they sit at the same point. */
const posKey = (lon: number, lat: number, ele: number | null | undefined): string =>
  `${lon.toFixed(9)}|${lat.toFixed(9)}|${ele == null ? 'x' : ele.toFixed(6)}`;

const edgeKey = (e: GraphEdge, id: (n: string) => string): string =>
  [
    id(e.from), id(e.to), e.kind, e.connectorKind ?? '-', e.color ?? '-',
    e.lengthM.toFixed(2), (e.geometry?.length ?? 0), e.liftName ?? '-', e.pisteName ?? '-',
    e.area ? 'area' : '-', e.synthetic ? 'syn' : '-',
  ].join('|');

function diffResort(id: string, ref: string): boolean {
  const rel = `public/resorts/${id}/graph.json`;
  const oldG = readRef(ref, rel);
  const newG = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')) as ResortGraph;
  if (!oldG) { console.log(`\n=== ${id} ===\n  no committed graph at ${ref} — skipped`); return true; }

  console.log(`\n=== ${id} ===`);
  let ok = true;

  // --- Nodes: match on position, build old id -> new id ---------------------------------------
  const newByPos = new Map<string, string[]>();
  for (const n of newG.nodes) {
    const k = posKey(n.point.lon, n.point.lat, n.point.ele);
    const arr = newByPos.get(k); if (arr) arr.push(n.id); else newByPos.set(k, [n.id]);
  }
  const map = new Map<string, string>();
  const unmatched: string[] = [];
  for (const n of oldG.nodes) {
    const cands = newByPos.get(posKey(n.point.lon, n.point.lat, n.point.ele));
    if (!cands || !cands.length) { unmatched.push(n.id); continue; }
    map.set(n.id, cands.shift()!);
  }
  const leftover = [...newByPos.values()].flat();
  console.log(`  nodes ${oldG.nodes.length} -> ${newG.nodes.length}` +
    `  matched=${map.size} unmatchedOld=${unmatched.length} extraNew=${leftover.length}`);
  if (unmatched.length) { ok = false; console.log(`    old nodes with no counterpart: ${unmatched.slice(0, 12).join(', ')}${unmatched.length > 12 ? ' …' : ''}`); }
  if (leftover.length) { ok = false; console.log(`    new nodes with no counterpart: ${leftover.slice(0, 12).join(', ')}${leftover.length > 12 ? ' …' : ''}`); }

  // --- Edges: compare as multisets under the node mapping --------------------------------------
  const resolve = (n: string) => map.get(n) ?? `?${n}`;
  const oldCounts = new Map<string, number>();
  for (const e of oldG.edges) { const k = edgeKey(e, resolve); oldCounts.set(k, (oldCounts.get(k) ?? 0) + 1); }
  const newCounts = new Map<string, number>();
  for (const e of newG.edges) { const k = edgeKey(e, (x) => x); newCounts.set(k, (newCounts.get(k) ?? 0) + 1); }
  const onlyOld: string[] = [], onlyNew: string[] = [];
  for (const [k, c] of oldCounts) { const d = c - (newCounts.get(k) ?? 0); for (let i = 0; i < d; i++) onlyOld.push(k); }
  for (const [k, c] of newCounts) { const d = c - (oldCounts.get(k) ?? 0); for (let i = 0; i < d; i++) onlyNew.push(k); }
  console.log(`  edges ${oldG.edges.length} -> ${newG.edges.length}  onlyOld=${onlyOld.length} onlyNew=${onlyNew.length}`);
  if (onlyOld.length) { ok = false; onlyOld.slice(0, 8).forEach((k) => console.log(`    - ${k}`)); }
  if (onlyNew.length) { ok = false; onlyNew.slice(0, 8).forEach((k) => console.log(`    + ${k}`)); }

  // --- Named points must still resolve to the same place ---------------------------------------
  // Compare as a multiset of (name, kind, position): several points legitimately share a name
  // (e.g. two "Fontfroide (top)" stations), so matching by name alone picks the wrong twin.
  const posOf = (g: ResortGraph): Map<string, string> =>
    new Map(g.nodes.map((n) => [n.id, posKey(n.point.lon, n.point.lat, n.point.ele)]));
  const oldNodePos = posOf(oldG), newNodePos = posOf(newG);
  const stamp = (g: ResortGraph, at: Map<string, string>) =>
    (g.points ?? []).map((p) => `${p.name}|${p.kind ?? '-'}|${at.get(p.nodeId) ?? 'missing'}`).sort();
  const oldPts = stamp(oldG, oldNodePos), newPts = stamp(newG, newNodePos);
  const newPool = new Map<string, number>();
  for (const s of newPts) newPool.set(s, (newPool.get(s) ?? 0) + 1);
  const movedPoints = oldPts.filter((s) => {
    const c = newPool.get(s) ?? 0;
    if (c <= 0) return true;
    newPool.set(s, c - 1);
    return false;
  });
  if (oldPts.length !== newPts.length || movedPoints.length) {
    ok = false;
    console.log(`  named points ${oldPts.length} -> ${newPts.length}, moved or vanished: ${movedPoints.length}`);
    movedPoints.slice(0, 8).forEach((s) => console.log(`    - ${s}`));
  }

  console.log(`  => ${ok ? 'IDENTICAL (relabelled only)' : 'DIFFERENT — review above'}`);
  return ok;
}

function main(): void {
  const arg = process.argv[2];
  const ref = process.argv[3] || 'HEAD';
  if (!arg) { console.error('Usage: tsx pipeline/_graphdiff.ts <resortId|all> [gitRef]'); process.exit(1); }
  let ids: string[];
  if (arg === 'all') {
    const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'resorts', 'index.json'), 'utf8'));
    ids = (Array.isArray(idx) ? idx : idx.resorts || []).map((r: { id: string }) => r.id);
  } else ids = [arg];
  let allOk = true;
  for (const id of ids) allOk = diffResort(id, ref) && allOk;
  console.log(`\n${allOk ? 'ALL RESORTS STRUCTURALLY IDENTICAL' : 'SOME RESORTS DIFFER — see above'} (vs ${ref})`);
  if (!allOk) process.exitCode = 1;
}

main();
