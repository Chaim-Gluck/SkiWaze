import { readFileSync } from 'node:fs';
import { findLongestRuns } from '../src/routing/plan';
import { DEFAULT_PREFERENCES } from '../src/config/defaults';
import type { ResortGraph } from '../src/types/domain';
for (const id of process.argv.slice(2)) {
  const g: ResortGraph = JSON.parse(readFileSync(`public/resorts/${id}/graph.json`, 'utf8'));
  const runs = findLongestRuns(g, DEFAULT_PREFERENCES, 3);
  console.log(id.padEnd(24) + runs.map((r) => (r.distanceM / 1000).toFixed(2) + 'km/' + Math.round(r.descentM) + 'm').join('  '));
}

