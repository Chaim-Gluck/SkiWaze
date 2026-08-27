/**
 * `npm run check:resort <id>` — the acceptance gate for a resort.
 *
 * Adding a resort used to mean remembering seven separate commands, so the easy thing to do was
 * skip one and rediscover a solved problem later. This runs the whole battery and prints a single
 * verdict table.
 *
 * Deliberately NOT a pass/fail build gate: most of these report *candidates*, not certainties
 * (a valley run ending at a road is a legitimate "trapped" node). REVIEW means "a human should
 * look at this on the map", FAIL means the check itself errored.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const id = process.argv[2];
if (!id) {
  console.error('usage: npm run check:resort <resortId> [--skip-elevation]');
  process.exit(2);
}
const skipElevation = process.argv.includes('--skip-elevation');

type Verdict = 'ok' | 'review' | 'fail';

interface Check {
  name: string;
  script: string;
  args?: string[];
  /** Pull the headline numbers out of stdout and decide whether a human needs to look. */
  read: (out: string) => { verdict: Verdict; note: string };
}

const num = (out: string, re: RegExp): number | null => {
  const m = out.match(re);
  return m ? Number(m[1]) : null;
};

const checks: Check[] = [
  {
    name: 'connectivity',
    script: '_trapped.ts',
    read: (o) => {
      const m = o.match(
        /summary:\s*trapped=(\d+)\s+orphan=(\d+)\s+basins=(\d+)\s+strandedNodes=(\d+)/i,
      );
      if (!m) return { verdict: 'fail', note: 'could not parse summary line' };
      const [trapped, orphan, basins, stranded] = m.slice(1, 5).map(Number);
      const note = `${trapped} trapped, ${orphan} orphan, ${basins} trapped basin(s) holding ${stranded} node(s)`;
      // Orphans and trapped basins are always wrong; a couple of trapped nodes are usually
      // real valley dead-ends.
      return { verdict: orphan > 0 || basins > 0 || trapped > 5 ? 'review' : 'ok', note };
    },
  },
  {
    name: 'audit (reversals/potholes)',
    script: '_phantoms.ts',
    read: (o) => {
      // Trust the TOTAL summary line, which names every category in one place.
      const m = o.match(
        /TOTAL:\s*(\d+)\s+reversal candidates?,\s*(\d+)\s+pothole sinks?,\s*(\d+)\s+long connections?/i,
      );
      if (!m) return { verdict: 'fail', note: 'could not parse TOTAL line' };
      const [rev, pot, conn] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const disc = num(o, /DISCONNECTED tops[^:]*:\s*(\d+)/i) ?? 0;
      return {
        verdict: rev + pot + conn + disc > 0 ? 'review' : 'ok',
        note: `${rev} reversals, ${pot} potholes, ${conn} long connections, ${disc} disconnected tops`,
      };
    },
  },
  {
    name: 'polygon spines',
    script: '_spinecheck.ts',
    read: (o) => {
      const polys = num(o, /polygons=(\d+)/);
      if (polys === 0) return { verdict: 'ok', note: 'no area polygons' };
      const flat = num(o, /does not descend[^:]*:\s*(\d+)/i) ?? 0;
      const short = num(o, /stops short[^:]*:\s*(\d+)/i) ?? 0;
      return {
        verdict: flat > 0 || short > 0 ? 'review' : 'ok',
        note: `${polys} polygons, ${flat} don't descend, ${short} stop short`,
      };
    },
  },
  {
    name: 'overrides still valid',
    script: '_overridecheck.ts',
    read: (o) => {
      const m = o.match(/override-integrity:\s*(\d+)\s+likely-stale,\s*(\d+)\s+to-verify/i);
      if (!m) return { verdict: 'fail', note: 'could not parse summary line' };
      const [stale, verify] = [Number(m[1]), Number(m[2])];
      return {
        verdict: stale + verify > 0 ? 'review' : 'ok',
        note: stale + verify > 0 ? `${stale} stale, ${verify} to verify` : 'all entries resolve',
      };
    },
  },
  {
    name: 'routing smoke test',
    script: '_routetest.ts',
    read: (o) => {
      const m = o.match(/routed OK:\s*(\d+)\/(\d+)/i);
      if (!m) return { verdict: 'fail', note: 'could not parse output' };
      const [ok, total] = [Number(m[1]), Number(m[2])];
      const miss = total - ok;
      // A handful of unreachable bottoms is normal (valley runs that end at a road/ski bus).
      return {
        verdict: miss / total > 0.05 ? 'review' : 'ok',
        note: `${ok}/${total} bottoms routable${miss ? ` (${miss} unreachable)` : ''}`,
      };
    },
  },
  {
    name: 'route quality',
    script: '_planprobe.ts',
    read: (o) => {
      // meanOption1/shortest: chosen route vs the shortest feasible path. 1.00 = optimal.
      const r = num(o, /meanOption1\/shortest=([0-9.]+)x/);
      if (r == null) return { verdict: 'fail', note: 'could not parse output' };
      const over = num(o, /over1\.25x=(\d+)/) ?? 0;
      return {
        verdict: r > 1.1 ? 'review' : 'ok',
        note: `mean detour ${r.toFixed(3)}x, ${over} pairs over 1.25x`,
      };
    },
  },
];

if (!skipElevation) {
  checks.splice(2, 0, {
    name: 'elevation vs 2nd DEM',
    script: '_elevaudit.ts',
    read: (o) => {
      // The number that matters is not "nodes that disagree with the 2nd DEM" (a 40 m
      // disagreement on an open slope is harmless) but how many piste edges would flip
      // direction under the corrected field.
      const rev = num(o, /piste edges that REVERSE under the corrected field:\s*(\d+)/i);
      if (rev == null) return { verdict: 'fail', note: 'could not parse ROUTING IMPACT line' };
      const suppressed = num(o, /(\d+)\s+verified-good candidate/i) ?? 0;
      return {
        verdict: rev > 0 ? 'review' : 'ok',
        note: `${rev} edges would reverse${suppressed ? `, ${suppressed} suppressed as verified-good` : ''}`,
      };
    },
  });
}

console.log(`\n=== resort acceptance check: ${id} ===\n`);

const rows: { name: string; verdict: Verdict; note: string }[] = [];
for (const c of checks) {
  process.stdout.write(`  running ${c.name}...`.padEnd(42));
  const res = spawnSync(
    `npx tsx ${JSON.stringify(path.join('pipeline', c.script))} ${id} ${(c.args ?? []).join(' ')}`,
    { cwd: ROOT, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  let row: { verdict: Verdict; note: string };
  if (res.status !== 0) {
    row = { verdict: 'fail', note: `exit ${res.status}` };
  } else {
    try {
      row = c.read(out);
    } catch {
      row = { verdict: 'fail', note: 'could not parse output' };
    }
  }
  rows.push({ name: c.name, ...row });
  console.log(row.verdict === 'ok' ? 'ok' : row.verdict.toUpperCase());
}

const mark = (v: Verdict) => (v === 'ok' ? 'ok    ' : v === 'review' ? 'REVIEW' : 'FAIL  ');
console.log('');
for (const r of rows) console.log(`  ${mark(r.verdict)} ${r.name.padEnd(30)} ${r.note}`);

const review = rows.filter((r) => r.verdict === 'review');
const fail = rows.filter((r) => r.verdict === 'fail');
console.log('');
if (fail.length) {
  console.log(`${fail.length} check(s) FAILED to run — fix the tooling before trusting this resort.`);
  process.exitCode = 1;
} else if (review.length) {
  console.log(
    `${review.length} check(s) need a human look: ${review.map((r) => r.name).join(', ')}.\n` +
      `Verify each on /devtools/mapdebug.html before writing an override — these are candidates, not certainties.`,
  );
} else {
  console.log('All checks clean.');
}
