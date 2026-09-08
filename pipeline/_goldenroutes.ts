// Golden-route timing check: does the app's estimate still match a real, recorded descent?
//
// Every other gate in this repo measures distance, detour rate or option counts - nothing guards
// the *time* estimate, which is the number the user actually reads. A cost-model change can leave
// every route identical in shape while quietly making it 20% slower.
//
// Fixtures live in `fixtures/golden-routes.json` and come from real Strava ELAPSED times (elapsed,
// not moving: it includes the lift queues our wait model estimates). Tolerances are deliberately
// generous - with a handful of samples a tight bound just produces false alarms, and the point is
// to catch a large drift, not to pin the model to one skier's day.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResortGraph, SkillLevel } from '../src/types/domain';
import { DEFAULT_PREFERENCES } from '../src/config/defaults';
import { planRoutes } from '../src/routing/plan';

interface Fixture {
  label: string;
  resort: string;
  from: string;
  to: string;
  closedKeys?: string[];
  skillLevel?: SkillLevel;
  expectedMinutes: number;
  toleranceMinutes: number;
  source?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures: Fixture[] = JSON.parse(
  fs.readFileSync(path.join(here, 'fixtures', 'golden-routes.json'), 'utf8'),
);

let failures = 0;
for (const f of fixtures) {
  const graph: ResortGraph = JSON.parse(
    fs.readFileSync(path.join(here, '..', 'public', 'resorts', f.resort, 'graph.json'), 'utf8'),
  );
  const prefs = { ...DEFAULT_PREFERENCES, skillLevel: f.skillLevel ?? DEFAULT_PREFERENCES.skillLevel };
  const result = planRoutes(graph, {
    resortId: f.resort,
    fromNodeId: f.from,
    toNodeId: f.to,
    timing: { mode: 'now' },
    prefs,
    closedKeys: f.closedKeys ?? [],
  });

  const route = result.routes[0];
  if (!route) {
    console.log(`FAIL  ${f.label}\n      no route found${result.error ? `: ${result.error}` : ''}`);
    failures++;
    continue;
  }

  const mins = route.stats.totalDurationS / 60;
  const delta = mins - f.expectedMinutes;
  const ok = Math.abs(delta) <= f.toleranceMinutes;
  if (!ok) failures++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${f.label}\n` +
      `      estimate ${mins.toFixed(1)} min vs recorded ${f.expectedMinutes} min ` +
      `(${delta >= 0 ? '+' : ''}${delta.toFixed(1)}, tolerance ${f.toleranceMinutes}) · ` +
      `${(route.stats.totalDistanceM / 1000).toFixed(1)} km · ${route.stats.liftCount} lifts`,
  );
}

console.log(`\n${fixtures.length - failures}/${fixtures.length} golden routes within tolerance.`);
if (failures) process.exitCode = 1;
