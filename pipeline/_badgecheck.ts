/**
 * Regression guard for a badge that contradicts the number printed beside it.
 *
 * The invariant is deliberately the USER'S, not the router's: a card badged "Fastest" must not
 * display more minutes than a sibling card, and one badged "Longest" must not display fewer
 * kilometres of skiing. Everything is compared at DISPLAY resolution (fmtDuration rounds to
 * whole minutes, fmtDistance to 0.1 km) because a difference the user cannot see is not a lie.
 *
 * This exists because Mount Hermon shipped an 8 min / 2.5 km option badged "Fastest" above a
 * 7 min / 1.9 km one: the ranking comparator called two times tied when they differed by exactly
 * its 60 s floor, so the "Skiing" key (more piste metres) decided the objective the user had
 * explicitly asked to be decided on time.
 *
 *   npx tsx pipeline/_badgecheck.ts <resortId|all> [maxPairs]
 */
import { readFileSync } from 'node:fs';
import { planRoutes } from '../src/routing/plan';
import { DEFAULT_PREFERENCES } from '../src/config/defaults';
import { pisteMetres } from '../src/routing/ranking';
import type { ResortGraph, Route } from '../src/types/domain';
import { RESORTS } from '../src/config/resorts';

const arg = process.argv[2];
const maxPairs = Number(process.argv[4] ?? 120);
if (!arg) throw new Error('usage: _badgecheck.ts <resortId|all> [maxPairs]');
const ids = arg === 'all' ? RESORTS.map((r) => r.id) : [arg];

const mins = (r: Route) => Math.round(r.stats.totalDurationS / 60);
const km = (m: number) => Math.round(m / 100) / 10;

function hav(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const k = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot((a.lon - b.lon) * k, a.lat - b.lat) * 111320;
}

let violations = 0;
let planned = 0;
// How many plans actually carried each badge. A badge key that never matches would make this
// probe report a serene "0 violations" while testing nothing — the failure mode AGENTS warns
// about, and a live risk here because these keys are matched as strings. Asserted at the end.
const badged = { fastest: 0, longest_ab: 0 };

for (const id of ids) {
  let graph: ResortGraph;
  try {
    graph = JSON.parse(readFileSync(`public/resorts/${id}/graph.json`, 'utf8'));
  } catch {
    console.log(`${id}: no graph.json — skipped`);
    continue;
  }
  // Deterministic pair selection, by position rather than by index, so a pass that adds or
  // removes nodes does not silently change the test set and manufacture a phantom regression.
  const nodes = [...graph.nodes].sort((a, b) => a.point.lon - b.point.lon || a.point.lat - b.point.lat);
  const step = Math.max(1, Math.floor(nodes.length / maxPairs));
  let local = 0;
  for (let i = 0; i < nodes.length; i += step) {
    const a = nodes[i];
    let best: string | undefined;
    let bestD = Infinity;
    for (const b of nodes) {
      if (b.id === a.id) continue;
      const d = hav(a.point, b.point);
      if (d > 300 && d < 3000 && d < bestD) {
        bestD = d;
        best = b.id;
      }
    }
    if (!best) continue;
    const res = planRoutes(graph, {
      resortId: id,
      fromNodeId: a.id,
      toNodeId: best,
      timing: { mode: 'now' },
      prefs: { ...DEFAULT_PREFERENCES, routeType: 'balanced' },
    });
    const routes = res.routes ?? [];
    if (routes.length < 2) continue;
    planned++;
    const fastest = routes.find((r) => r.labels?.includes('fastest'));
    if (fastest) {
      badged.fastest++;
      const quicker = routes.find((r) => r !== fastest && mins(r) < mins(fastest));
      if (quicker) {
        violations++;
        local++;
        console.log(
          `${id} ${a.id}→${best}: "Fastest" shows ${mins(fastest)} min but a sibling shows ${mins(quicker)} min`,
        );
      }
    }
    const longest = routes.find((r) => r.labels?.includes('longest_ab'));
    if (longest) {
      badged.longest_ab++;
      const longer = routes.find((r) => r !== longest && km(pisteMetres(r)) > km(pisteMetres(longest)));
      if (longer) {
        violations++;
        local++;
        console.log(
          `${id} ${a.id}→${best}: "Longest" shows ${km(pisteMetres(longest))} km skiing but a sibling shows ${km(pisteMetres(longer))} km`,
        );
      }
    }
  }
  console.log(`${id}: ${local} violation(s)`);
}

console.log(`badges: ${violations} violation(s) over ${planned} multi-option plans`);
console.log(`badges seen: fastest=${badged.fastest} longest_ab=${badged.longest_ab}`);
// A run that planned real routes but never saw a badge means the keys stopped matching, not that
// the app got perfect. Fail, rather than report a clean bill of health for an untested invariant.
const blind = planned > 0 && badged.fastest === 0 && badged.longest_ab === 0;
if (blind) console.log('badges: FAIL — no badge key ever matched, so nothing was actually checked');
process.exitCode = violations > 0 || blind ? 1 : 0;
