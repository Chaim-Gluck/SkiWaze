/**
 * `npm run check:basins` Ã¢â‚¬â€ find trapped basins and emit a map-debug overlay + review list.
 *
 * A trapped basin is terrain you can ski into but never get back out of. See
 * `lib/trappedBasins.ts` for why this replaced the narrower "one-way pocket" test.
 *
 * A pin on a node is not enough to judge one of these Ã¢â‚¬â€ you cannot see the extent, so you cannot
 * tell a stranded sector from a genuinely separate ski area, and a reviewer looking at a 3-node
 * dot will rightly say "but everything around it is trapped too". So this draws the whole basin:
 *   - public/devtools/overlays/trapped-basins.json Ã¢â‚¬â€ the basin in red, the edges that lead into it
 *     in green, and the shortest candidate link in amber.
 *   - public/devtools/overlays/review-list.json    Ã¢â‚¬â€ the same basins as prev/next entries.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResortGraph } from '../src/types/domain';
import { basinLabel, findTrappedBasins, type TrappedBasin } from './lib/trappedBasins';
import { loadOverrides } from './lib/overrides';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OVERLAY_DIR = path.join(ROOT, 'public', 'devtools', 'overlays');
const OVERRIDES_DIR = path.join(ROOT, 'pipeline', 'overrides');

/** Below this, the "largest SCC is the main body" assumption deserves a human's eyes. */
const MAIN_SHARE_WARN = 0.7;

function main(): void {
  const index = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'public', 'resorts', 'index.json'), 'utf8'),
  ) as { resorts?: { id: string }[] } | { id: string }[];
  const ids = (Array.isArray(index) ? index : (index.resorts ?? [])).map((r) => r.id);

  const overlay: Record<string, unknown> = {};
  const review: unknown[] = [];
  const rows: { id: string; basin: TrappedBasin }[] = [];
  const warnings: string[] = [];
  const accepted: string[] = [];

  for (const id of ids) {
    const gp = path.join(ROOT, 'public', 'resorts', id, 'graph.json');
    if (!fs.existsSync(gp)) continue;
    const graph = JSON.parse(fs.readFileSync(gp, 'utf8')) as ResortGraph;
    const ov = loadOverrides(id, OVERRIDES_DIR);
    const report = findTrappedBasins(graph, id, ov?.acceptedBasins);
    for (const b of report.accepted) {
      accepted.push(`${id}: ${basinLabel(b)} (${b.nodes.length} nodes) — ${b.acceptedWhy}`);
    }
    for (const s of report.staleAccepted) {
      warnings.push(
        `${id}: acceptedBasins entry matched no basin (${s.nodes.join(', ')}) — ` +
          `either it is fixed now, or a refresh retired those ids. Re-check and update the override.`,
      );
    }
    if (report.mainShare < MAIN_SHARE_WARN) {
      warnings.push(
        `${id}: main body is only ${(report.mainShare * 100).toFixed(0)}% of the resort ` +
          `(${report.mainSize}/${graph.nodes.length}) Ã¢â‚¬â€ the mountain is fractured, not just leaky.`,
      );
    }
    if (!report.significant.length) continue;

    const named = new Map((graph.points ?? []).map((p) => [p.nodeId, p.name]));
    const lines: unknown[] = [];
    const points: unknown[] = [];
    let minLon = 180,
      minLat = 90,
      maxLon = -180,
      maxLat = -90;

    for (const b of report.significant) {
      rows.push({ id, basin: b });
      const inside = new Set(b.nodes.map((n) => n.id));
      for (const e of graph.edges) {
        const bothIn = inside.has(e.from) && inside.has(e.to);
        if (!bothIn && !inside.has(e.to)) continue;
        lines.push({
          coords: e.geometry.map((g) => [g.lon, g.lat]),
          // Red = trapped. Green = an edge that leads in but that you can't come back out of,
          // which is exactly how a skier falls in.
          color: bothIn ? '#e11d48' : '#16a34a',
          width: bothIn ? 4 : 2,
        });
      }
      for (const n of b.nodes) {
        minLon = Math.min(minLon, n.point.lon);
        maxLon = Math.max(maxLon, n.point.lon);
        minLat = Math.min(minLat, n.point.lat);
        maxLat = Math.max(maxLat, n.point.lat);
      }
      lines.push({
        coords: [
          [b.exit.point.lon, b.exit.point.lat],
          [b.outside.at.lon, b.outside.at.lat],
        ],
        color: '#f59e0b',
        width: 3,
      });
      points.push({
        at: [b.exit.point.lon, b.exit.point.lat],
        color: '#e11d48',
        r: 15,
        tag: 'exit',
        label:
          `<b>${b.exit.id}</b> ${named.get(b.exit.id) ?? ''}<br>` +
          `${Math.round(b.exit.point.ele ?? 0)} m Ã¢â‚¬â€ trapped basin: ${b.nodes.length} nodes, ` +
          `${b.lifts.length} lift(s), ${b.entries.length} way(s) in<br>${basinLabel(b)}`,
      });
      points.push({
        at: [b.outside.at.lon, b.outside.at.lat],
        color: '#16a34a',
        r: 13,
        tag: `outside ${b.climbM >= 0 ? '+' : ''}${b.climbM}m`,
        label:
          `<b>${b.outside.label}</b><br>` +
          `${Math.round(b.outside.at.ele)} m, ${b.gapM} m away` +
          (b.outside.edgeId
            ? '<br><i>a point ALONG a run, not a node: a link here would split it</i>'
            : '<br><i>nearest node outside</i>'),
      });

      review.push({
        size: b.nodes.length,
        label:
          `${id}: ${basinLabel(b)} (${b.nodes.length} nodes, ${b.lifts.length} lift(s), ` +
          `gap ${b.gapM}m, exit ${b.climbM >= 0 ? '+' : ''}${b.climbM}m, frees ${b.frees}/${b.nodes.length})`,
        resort: id,
        node: b.exit.id,
        center: [
          +((b.exit.point.lon + b.outside.at.lon) / 2).toFixed(6),
          +((b.exit.point.lat + b.outside.at.lat) / 2).toFixed(6),
        ],
        zoom: 15,
        note:
          `Trapped basin: you can ski in, and nothing gets you back to the main mountain. ` +
          `Red = every trapped node (not just the core), green = the edges that lead in, ` +
          `amber = the best candidate link. Exit ${b.exit.id} ` +
          `(${named.get(b.exit.id) ?? 'unnamed'}, ${Math.round(b.exit.point.ele ?? 0)} m) -> ` +
          `${b.outside.label} (${Math.round(b.outside.at.ele)} m), ` +
          `${b.gapM} m away and ${b.climbM} m higher. ` +
          (b.outside.edgeId
            ? `NOTE that target is a point ALONG a run rather than one of its ends, so a link ` +
              `there would split that run. `
            : '') +
          `A link there would free ${b.frees} of the ${b.nodes.length} trapped node(s)` +
          (b.frees < b.nodes.length
            ? ` - the rest drain somewhere else, so ONE link cannot fix this basin.`
            : ` (all of them: the basin drains to this point).`) +
          ` Wrong station height -> setNodeElevation; a real short walk or unmapped link -> ` +
          `addConnectors; wrong resort / a separate ski area -> tighten the bbox.`,
      });
    }

    overlay[id] = {
      focus: {
        bounds: [
          [minLon, minLat],
          [maxLon, maxLat],
        ],
      },
      lines,
      points,
      notes:
        `${report.significant.length} trapped basin(s), ${report.significantNodes} node(s) stranded. ` +
        `Red = trapped; green = the way in; amber = shortest candidate link.`,
    };
  }

  // Biggest first: a reviewer's time is best spent where the most terrain is stranded.
  review.sort((a, b) => (b as { size: number }).size - (a as { size: number }).size);
  for (const r of review) delete (r as { size?: number }).size;

  fs.writeFileSync(
    path.join(OVERLAY_DIR, 'trapped-basins.json'),
    JSON.stringify(overlay, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(OVERLAY_DIR, 'review-list.json'),
    JSON.stringify(review, null, 2) + '\n',
  );

  console.log('=== check:basins ===');
  rows.sort((a, b) => b.basin.nodes.length - a.basin.nodes.length);
  for (const { id, basin } of rows) {
    console.log(
      `  ${id.padEnd(22)} ${String(basin.nodes.length).padStart(4)} nodes  ` +
        `${String(basin.lifts.length).padStart(2)} lift(s)  gap ${String(basin.gapM).padStart(4)}m  ` +
        `exit ${basin.climbM >= 0 ? '+' : ''}${basin.climbM}m  ${basinLabel(basin)}`,
    );
  }
  for (const w of warnings) console.log(`  WARN ${w}`);
  if (accepted.length) {
    console.log(`\n  accepted (reviewed, genuinely disconnected — not counted below):`);
    for (const a of accepted) console.log(`    ${a}`);
  }
  const nodes = rows.reduce((s, r) => s + r.basin.nodes.length, 0);
  console.log(
    `\nsummary: ${rows.length} trapped basin(s), ${nodes} stranded node(s) across ${ids.length} resort(s)`,
  );
  console.log(
    'wrote overlays/trapped-basins.json and overlays/review-list.json Ã¢â‚¬â€ open /devtools/mapdebug.html',
  );
}

main();
