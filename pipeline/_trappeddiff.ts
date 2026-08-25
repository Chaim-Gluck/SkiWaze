/**
 * Report-only: which nodes changed connectivity between two compiled graphs?
 *
 * `check:trapped` gives a count, and a count that moves by five across a 13-resort rebuild says
 * nothing about whether five real places got worse or five different places got better and worse.
 * This diffs the actual node sets, so a regression can be named and looked at on the map.
 *
 * Node ids are stable (derived from OSM), so they are the primary key; a node that exists in only
 * one graph is reported separately rather than silently counted as a change.
 *
 * Usage: npx tsx pipeline/_trappeddiff.ts <baselineGraph.json> <currentGraph.json> [label]
 */
import fs from 'node:fs';
import type { ResortGraph } from '../src/types/domain';

function bfs(adj: Map<string, string[]>, seeds: string[]): Set<string> {
  const seen = new Set<string>(seeds);
  const queue = [...seeds];
  for (let i = 0; i < queue.length; i++) for (const next of adj.get(queue[i]) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  return seen;
}

function analyse(g: ResortGraph): { trapped: Set<string>; orphan: Set<string>; ids: Set<string>; at: Map<string, string> } {
  const fwd = new Map<string, string[]>();
  const rev = new Map<string, string[]>();
  for (const e of g.edges) {
    (fwd.get(e.from) ?? fwd.set(e.from, []).get(e.from)!).push(e.to);
    (rev.get(e.to) ?? rev.set(e.to, []).get(e.to)!).push(e.from);
  }
  const lifts = g.nodes.filter((n) => n.kind === 'lift_station').map((n) => n.id);
  const toLift = bfs(rev, lifts);
  const fromLift = bfs(fwd, lifts);
  const at = new Map<string, string>();
  for (const n of g.nodes) at.set(n.id, `${n.point.lon.toFixed(5)},${n.point.lat.toFixed(5)} ${Math.round(n.point.ele ?? 0)}m`);
  return {
    trapped: new Set(g.nodes.filter((n) => !toLift.has(n.id)).map((n) => n.id)),
    orphan: new Set(g.nodes.filter((n) => !fromLift.has(n.id)).map((n) => n.id)),
    ids: new Set(g.nodes.map((n) => n.id)),
    at,
  };
}

const [aPath, bPath, label = ''] = process.argv.slice(2);
const A = analyse(JSON.parse(fs.readFileSync(aPath, 'utf8')) as ResortGraph);
const B = analyse(JSON.parse(fs.readFileSync(bPath, 'utf8')) as ResortGraph);

const both = [...B.ids].filter((id) => A.ids.has(id));
const newlyTrapped = both.filter((id) => B.trapped.has(id) && !A.trapped.has(id));
const fixedTrapped = both.filter((id) => !B.trapped.has(id) && A.trapped.has(id));
const addedTrapped = [...B.trapped].filter((id) => !A.ids.has(id));
const goneTrapped = [...A.trapped].filter((id) => !B.ids.has(id));

const d = (n: number): string => (n > 0 ? `+${n}` : String(n));
console.log(
  `${label.padEnd(24)} trapped ${A.trapped.size}->${B.trapped.size} (${d(B.trapped.size - A.trapped.size)})` +
    `  orphan ${A.orphan.size}->${B.orphan.size} (${d(B.orphan.size - A.orphan.size)})` +
    `  nodes ${A.ids.size}->${B.ids.size}`,
);
const show = (title: string, ids: string[], src: Map<string, string>): void => {
  if (!ids.length) return;
  console.log(`  ${title}: ${ids.length}`);
  for (const id of ids.slice(0, 12)) console.log(`    ${id}  @${src.get(id)}`);
  if (ids.length > 12) console.log(`    … and ${ids.length - 12} more`);
};
show('REGRESSED (existing node, was fine, now trapped)', newlyTrapped, B.at);
show('improved (existing node, was trapped, now fine)', fixedTrapped, B.at);
show('new node that is trapped', addedTrapped, B.at);
show('trapped node that no longer exists', goneTrapped, A.at);
