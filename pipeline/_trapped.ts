// Connectivity audit for a compiled resort graph.
// Usage: tsx pipeline/_trapped.ts <resortId>
//
// Reports two kinds of connectivity problems on public/resorts/<id>/graph.json:
//   - "trapped": nodes from which a skier CANNOT reach any lift station (they'd get stuck
//     at the bottom of a fragment with no way back up / onward).
//   - "orphan":  nodes NOT reachable FROM the lift network (you can never get there).
//   - "trapped basin": terrain you can ski into that can never get back to the resort's main
//     body. `trapped` misses these because the skier *can* reach a lift; it simply doesn't get
//     them out. See lib/trappedBasins.ts for why this replaced a narrower "one-way pocket" test.
// Use this after `npm run data <id>` to find genuinely isolated fragments, then fix them
// via pipeline/overrides/<id>.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GraphEdge, ResortGraph } from '../src/types/domain';
import { loadOverrides } from './lib/overrides';
import { basinLabel, findTrappedBasins } from './lib/trappedBasins';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OVERRIDES_DIR = path.join(ROOT, 'pipeline', 'overrides');

function loadGraph(id: string): ResortGraph {
  const p = path.join(ROOT, 'public', 'resorts', id, 'graph.json');
  if (!fs.existsSync(p)) {
    console.error(`No compiled graph at ${p}. Run: npm run data ${id}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')) as ResortGraph;
}

function bfs(adj: Map<string, string[]>, seeds: string[]): Set<string> {
  const seen = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

function main(): void {
  const id = process.argv[2];
  if (!id) {
    console.error('Usage: tsx pipeline/_trapped.ts <resortId>');
    process.exit(1);
  }
  const graph = loadGraph(id);
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  const fwd = new Map<string, string[]>();
  const rev = new Map<string, string[]>();
  for (const e of graph.edges) {
    (fwd.get(e.from) ?? fwd.set(e.from, []).get(e.from)!).push(e.to);
    (rev.get(e.to) ?? rev.set(e.to, []).get(e.to)!).push(e.from);
  }

  const liftStations = graph.nodes.filter((n) => n.kind === 'lift_station').map((n) => n.id);
  const canReachLift = bfs(rev, liftStations); // can get FROM node TO a lift
  const reachableFromLift = bfs(fwd, liftStations); // can get FROM a lift TO node

  const ov = loadOverrides(id, OVERRIDES_DIR);
  // Dead ends a human signed off. Same contract as `acceptedBasins`: the graph is untouched, the
  // nodes are only taken out of the counts and reported separately, so a resort whose dead ends
  // are all understood can reach `ok` instead of reporting REVIEW forever.
  const acceptedNodes = new Map<string, string>();
  for (const a of ov?.acceptedDeadEnds ?? []) {
    for (const n of a.nodes) acceptedNodes.set(n, a.why);
  }
  const accepted = (n: { id: string }) => acceptedNodes.has(n.id);

  // Off-piste terrain is not a connectivity defect, and this check disagreed with `trappedBasins.ts`
  // about that for as long as both have existed.
  //
  // A freeride itinerary that descends to a valley and stops IS the thing it is; nothing is missing
  // from OSM. `cost.ts` refuses those edges outright unless the skier opts in with `allowOffPiste`,
  // so by default a skier cannot even enter this terrain, let alone "get stuck" in it — and a skier
  // who does opt in has accepted unpatrolled, unlinked terrain by definition. Reporting it sent
  // reviewers chasing phantoms: Verbier's L'Eteygeon accounted for ALL 18 of that resort's trapped
  // nodes and sat on the review list for rounds, and it is the same call already signed off for
  // Tignes' Termignon ("free-ride off-piste, do not add a link"). Fleet-wide this is 48 of 138
  // trapped and 23 of 57 orphan nodes across 7 resorts — a third of the noise in this check.
  //
  // The graph is NOT changed and the BFS is NOT filtered: same contract as `acceptedBasins`, the
  // nodes are only moved out of the counts and reported separately. Deliberately conservative:
  // `_trapped.ts` still walks off-piste when deciding what can reach a lift, so a PISTE node whose
  // only escape is a freeride line still counts as reaching one. That is arguably too generous, but
  // it matches `trappedBasins.ts` exactly, and changing reachability semantics is a much larger
  // behavioural change than suppressing a report — it should be measured on its own, not smuggled in
  // here.
  //
  // The app's OWN synthetic plumbing is ignored when judging. At L'Eteygeon every single
  // non-off-piste edge in the sector is `synthetic:true` — rescue/snap connectors the pipeline
  // invented while trying to save the itinerary — so judging raw edges would call the sector "mixed"
  // on the strength of the app's own guesses about terrain it cannot see.
  const touching = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    for (const nid of [e.from, e.to]) (touching.get(nid) ?? touching.set(nid, []).get(nid)!).push(e);
  }
  const offPisteOnly = (n: { id: string }): boolean => {
    const real = (touching.get(n.id) ?? []).filter((e) => e.kind !== 'lift' && !e.synthetic);
    return real.length > 0 && real.every((e) => e.offPiste === true);
  };

  const trappedAll = graph.nodes.filter((n) => !canReachLift.has(n.id));
  const orphanAll = graph.nodes.filter((n) => !reachableFromLift.has(n.id));
  const trapped = trappedAll.filter((n) => !accepted(n) && !offPisteOnly(n));
  const orphan = orphanAll.filter((n) => !accepted(n) && !offPisteOnly(n));
  const offPisteSeen = new Set(
    [...trappedAll, ...orphanAll].filter((n) => !accepted(n) && offPisteOnly(n)).map((n) => n.id),
  );
  const acceptedSeen = new Set(
    [...trappedAll, ...orphanAll].filter(accepted).map((n) => n.id),
  );

  const label = (nid: string): string => {
    const p = graph.points.find((x) => x.nodeId === nid);
    const n = nodeById.get(nid);
    return `${p ? p.name : nid} Â· ${Math.round(n?.point.ele ?? 0)} m`;
  };

  console.log(`=== check:trapped ${id} ===`);
  console.log(`nodes=${graph.nodes.length} edges=${graph.edges.length} lift_stations=${liftStations.length}`);
  console.log(`\ntrapped (can't reach any lift â†’ skier gets stuck): ${trapped.length}`);
  trapped.slice(0, 30).forEach((n) => console.log('  - ' + label(n.id)));
  if (trapped.length > 30) console.log(`  â€¦ and ${trapped.length - 30} more`);
  console.log(`\norphan (unreachable from the lift network): ${orphan.length}`);
  orphan.slice(0, 30).forEach((n) => console.log('  - ' + label(n.id)));
  if (orphan.length > 30) console.log(`  â€¦ and ${orphan.length - 30} more`);

  // Trapped basins: terrain you can ski into that can never get back to the main mountain.
  // `acceptedBasins` MUST be passed here. Without it this check re-litigates every basin a human
  // has already signed off, and because `check:resort` reads the summary line below it kept
  // reporting REVIEW for a resort whose basins were all resolved — the exact noise the sign-off
  // mechanism exists to remove (see lib/trappedBasins.ts).
  const report = findTrappedBasins(graph, id, ov?.acceptedBasins);
  console.log(
    `\ntrapped basins (ski in, no way back to the main body): ${report.significant.length}` +
      ` â€” ${report.significantNodes} stranded node(s)` +
      (report.basins.length > report.significant.length
        ? `, plus ${report.basins.length - report.significant.length} lone dead-end node(s)`
        : ''),
  );
  console.log(
    `main body: ${report.mainSize}/${graph.nodes.length} nodes (${(report.mainShare * 100).toFixed(0)}%)`,
  );
  report.significant.slice(0, 15).forEach((b) => {
    console.log(
      `  - ${String(b.nodes.length).padStart(4)} node(s), ${b.lifts.length} lift(s), ` +
        `gap ${b.gapM}m, exit ${b.climbM >= 0 ? '+' : ''}${b.climbM}m â€” ${basinLabel(b)}` +
        ` (e.g. ${label(b.exit.id)})`,
    );
  });
  if (report.significant.length > 15)
    console.log(`  â€¦ and ${report.significant.length - 15} more`);

  if (report.accepted.length) {
    console.log(
      `\naccepted (signed off in overrides/${id}.json, not counted above): ${report.accepted.length}`,
    );
    report.accepted.forEach((b) => {
      console.log(`  - ${String(b.nodes.length).padStart(4)} node(s) â€” ${basinLabel(b)}`);
    });
  }
  for (const s of report.staleAccepted) {
    console.log(
      `\nWARN acceptedBasins entry matched no basin (${s.nodes.join(', ')}) â€” ` +
        'either it is fixed now, or a refresh retired those ids.',
    );
  }

  if (offPisteSeen.size) {
    console.log(
      `\noff-piste only (freeride terrain, not a connectivity defect — not counted above): ${offPisteSeen.size}`,
    );
    const names = new Set<string>();
    for (const nid of offPisteSeen) {
      for (const e of touching.get(nid) ?? []) if (e.offPiste && e.pisteName) names.add(e.pisteName);
    }
    console.log(`  ${[...names].join(', ') || '(unnamed lines)'}`);
  }

  if (acceptedSeen.size) {
    console.log(
      `\naccepted dead ends (signed off in overrides/${id}.json, not counted above): ${acceptedSeen.size}`,
    );
    for (const nid of acceptedSeen) {
      console.log(`  - ${label(nid)} â€” ${acceptedNodes.get(nid)}`);
    }
  }
  // A sign-off that no longer matches anything is worse than none: it silently stops covering the
  // thing it was written for. Same warning `acceptedBasins` gets, for the same reason.
  for (const [nid, why] of acceptedNodes) {
    if (acceptedSeen.has(nid)) continue;
    const exists = nodeById.has(nid);
    console.log(
      `\nWARN acceptedDeadEnds node ${nid} is ${exists ? 'no longer trapped or orphan' : 'not in the graph'}` +
        ` â€” ${exists ? 'it may be fixed now' : 'a refresh probably retired the id'} (${why})`,
    );
  }

  console.log(
    `\nsummary: trapped=${trapped.length} orphan=${orphan.length}` +
      ` basins=${report.significant.length} strandedNodes=${report.significantNodes}` +
      ` offPisteOnly=${offPisteSeen.size}`,
  );
  if (!trapped.length && !orphan.length && !report.significant.length) {
    console.log('\nOK: every node connects to the lift network both ways.');
  }
}

main();
