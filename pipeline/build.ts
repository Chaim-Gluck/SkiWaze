// SkiWaze data pipeline orchestrator.
// Usage: tsx pipeline/build.ts <resortId|all>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESORTS } from '../src/config/resorts';
import { DEFAULT_GRAPH_CONSTANTS } from '../src/config/graphConstants';
import type { Resort } from '../src/types/domain';
import { fetchResortOsm, fetchResortRoads } from './lib/overpass';
import { normalizeLift, normalizePiste } from './lib/normalize';
import { dropExcludedFeatures } from './lib/excludeArea';
import { enrichElevations } from './lib/elevation';
import { buildResortGraph } from './lib/buildGraph';
import { corroborateLiftDirections } from './lib/liftDirection';
import { buildSkeletons } from './lib/areaSkeleton';
import { skeletonPistes } from './lib/areaSkeletonPistes';
import { applyOverrides, loadOverrides } from './lib/overrides';
import { applyCorrectionsGuarded, proposeElevationCorrections } from './lib/elevationConsensus';
import { pruneRedundantArms } from './lib/pruneArms';
import { dropOutOfAreaSpill } from './lib/bboxSpill';
import { dropInertFragments } from './lib/inertFragments';
import { linkLiftBaseSkiIns } from './lib/liftSkiIn';
import { tidyStationAccessLinks } from './lib/stationAccess';
import { weldCoincidentNodes } from './lib/weldCoincident';
import { markSpineDuplicates } from './lib/spineDuplicates';
import { dropTraversesAlongSurfaceLifts } from './lib/surfaceLiftParallel';
import { dropSyntheticRoadCrossings } from './lib/roadCrossing';
import { printReport, reachableFromLiftStations, validateGraph } from './lib/validate';
import { emitResort } from './lib/emit';
import { auditGraph, auditSummary, acceptedDeadEndNodes } from './_phantoms';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OVERRIDES_DIR = path.join(ROOT, 'pipeline', 'overrides');

async function buildResort(resort: Resort, opts: { refresh: boolean; ttlDays: number }): Promise<void> {
  console.log(`\n=== ${resort.name} (${resort.id}) ===`);

  console.log('  fetching OSM (Overpass)...');
  const osm = await fetchResortOsm(resort, opts);
  console.log(`  pistes=${osm.pistes.length} lifts=${osm.lifts.length}`);
  if (osm.pistes.length === 0 && osm.lifts.length === 0) {
    console.warn('  no data returned; skipping.');
    return;
  }

  const rawPistes = osm.pistes.map(normalizePiste);
  const rawLifts = osm.lifts.map(normalizeLift);
  const excl = dropExcludedFeatures(rawPistes, rawLifts, resort.excludeBboxes);
  if (excl.droppedPistes || excl.droppedLifts) {
    console.log(
      `  excluded area: dropped ${excl.droppedPistes} piste(s) + ${excl.droppedLifts} lift(s) — ` +
        `${[...new Set(excl.names)].slice(0, 8).join(', ')}`,
    );
  }
  const pistes = excl.pistes;
  const lifts = excl.lifts;

  console.log('  enriching elevation...');
  const missing = await enrichElevations([
    ...pistes.map((p) => p.points),
    ...lifts.map((l) => l.points),
  ]);
  if (missing > 0) console.warn(`  ${missing} node(s) still missing elevation.`);

  console.log('  building graph...');
  // Ask the second raster about every lift the near-flat rule is about to orient by its drawing.
  // Runs here because it needs elevations on the lift points and must feed BOTH graph builds.
  const liftDir = await corroborateLiftDirections(lifts, DEFAULT_GRAPH_CONSTANTS);
  const rejected = liftDir.checks.filter((k) => k.rejected);
  if (rejected.length)
    console.log(
      `  lift direction: ${rejected.length}/${liftDir.checks.length} near-flat lift(s) keep their ` +
        `elevation-derived direction (a second raster corroborates the drop) - ` +
        rejected
          .slice(0, 8)
          .map(
            (k) =>
              `w${k.wayId} ${k.name ?? '<unnamed>'} ours=${k.oursM.toFixed(1)} terr=${k.terrM?.toFixed(1)}`,
          )
          .join('; '),
    );
  const buildOpts = { rejectDrawnLiftDirection: liftDir.reject };
  let graph = buildResortGraph(resort.id, pistes, lifts, DEFAULT_GRAPH_CONSTANTS, buildOpts);

  // Replace `area=yes` polygons with an interior skeleton (plan §3). The polygon's *perimeter* is
  // what the router can follow today, so crossing a bowl means skiing around its rim. Two passes
  // are needed because a portal is defined by what a ring node touches OUTSIDE its own polygon, and
  // the spine of a class A/B′ polygon is an existing centreline - both are properties of the
  // assembled graph, not of the raw ways. So: build once to discover them, then rebuild with the
  // skeletons in place of the polygons.
  const skels = buildSkeletons(graph, pistes);
  const corridors = skels.filter((s) => s.corridor);
  if (corridors.length)
    console.log(
      `  corridors: ${corridors.length} squat polygon(s) spined gateway-to-gateway` +
        ` (${corridors.map((s) => 'w' + s.wayId).slice(0, 12).join(' ')}${corridors.length > 12 ? ' …' : ''})`,
    );
  // Fall-line fact check: how many polygons ended up with a spine that does not descend them? A
  // spine is adopted from whichever OSM way of the same run touches the ring, and nothing has ever
  // verified it crosses the polygon - so this counts the ones where the adopted centreline is
  // demonstrably the wrong line. Report only for now; the number decides what to do about it.
  const FALL_MIN = 0.35;
  const graded = skels.filter((s) => s.fall.polyDropM >= 15);
  const flat = graded.filter((s) => s.fall.dropRatio < FALL_MIN);
  if (graded.length)
    console.log(
      `  fall-line: ${flat.length}/${graded.length} polygon(s) with a spine that barely descends` +
        ` (drop ratio < ${FALL_MIN})`,
    );
  if (process.env.FALLDIAG)
    for (const s of (process.env.FALLDIAG === 'all' ? [...graded] : [...flat]).sort((a, b) => a.fall.dropRatio - b.fall.dropRatio).slice(0, 60))
      console.log(
        `    w${s.wayId} drop=${s.fall.dropRatio.toFixed(2)} (${s.fall.spineDropM.toFixed(0)}m of ${s.fall.polyDropM.toFixed(0)}m)` +
          ` angle=${s.fall.angleDeg.toFixed(0)}° span=${s.spanFrac.toFixed(2)}${s.synth ? ' synth' : ''}  ${s.label}`,
      );
  const sk = skeletonPistes(skels, pistes);
  if (sk.pistes.length) {
    // Elevation for the new vertices is FETCHED, never interpolated: interpolated values reverse
    // ~3.8 % of segments (plan §4b), and a piste is emitted one-way descending, so a reversed
    // segment severs the run and hands the router a fake way to gain height.
    console.log(`  skeletons: ${sk.replaced.size} polygons, ${sk.pistes.length} ways, ${sk.newPoints.length} new vertices`);
    if (sk.unwelded) console.warn(`  ${sk.unwelded} arm(s) found no spine to weld onto`);
    const skMissing = await enrichElevations([sk.newPoints]);
    if (skMissing > 0) console.warn(`  ${skMissing} skeleton vertex/vertices still missing elevation.`);
    const kept = pistes.filter((p) => !sk.replaced.has(p.wayId));
    graph = buildResortGraph(resort.id, [...kept, ...sk.pistes], lifts, DEFAULT_GRAPH_CONSTANTS, buildOpts);
  }

  const ov = loadOverrides(resort.id, OVERRIDES_DIR);

  if (ov) {
    console.log('  applying overrides...');
    graph = applyOverrides(graph, ov);
  }

  // Consult an independent DEM and repair whatever piste reversals the hand-written overrides did
  // not already deal with. This runs AFTER the overrides on purpose: a human `setNodeElevation`
  // often fixes a reversal by correcting the *neighbour*, so judging the raw field would make the
  // pass re-solve an already-solved spot a second, different way. Nodes the human set are pinned.
  // See elevationConsensus.ts for why adoption of the second DEM is guarded rather than blind.
  if (!process.argv.includes('--no-elevation-consensus')) {
    const pinned = new Set((ov?.setNodeElevation ?? []).map((e) => e.node));
    const proposed = await proposeElevationCorrections(graph, ov?.ignoreReversals ?? []);
    const { sampled, flips, steep } = proposed;
    const corrections = proposed.corrections.filter((c) => !pinned.has(c.node));
    if (corrections.length) {
      // Which way each piste points BEFORE the repair. A correction can legitimately reverse a run
      // (applyOverrides re-orients an edge that ends up climbing), and that changes which way a
      // skier is routed — so it must be announced, not buried in a node-height list.
      const orientBefore = new Map(
        graph.edges.filter((e) => e.kind === 'piste' && !e.area).map((e) => [e.id, e.from]),
      );
      const guarded = applyCorrectionsGuarded(
        graph,
        corrections,
        (g, c) => applyOverrides(g, { setNodeElevation: c }),
        reachableFromLiftStations,
      );
      graph = guarded.graph;
      if (guarded.kept.length) {
        console.log(
          `  elevation consensus: repaired ${guarded.kept.length} node(s) of ${flips + steep} suspect(s)` +
            `${steep ? `, ${steep} from an impossible gradient` : ''} (${sampled} sampled)`,
        );
        for (const c of guarded.kept) console.log(`    ${c.node} -> ${c.ele}m  (${c.why})`);
        const reversed = graph.edges.filter(
          (e) => e.kind === 'piste' && !e.area && orientBefore.has(e.id) && orientBefore.get(e.id) !== e.from,
        );
        if (reversed.length) {
          console.log(`  elevation consensus: ${reversed.length} piste edge(s) now ski the OTHER WAY — review on the map:`);
          for (const e of reversed)
            console.log(
              `    ${e.id} ${e.pisteName ?? '(unnamed)'} ${e.color ?? ''} ${Math.round(e.lengthM)}m  now ${e.from} -> ${e.to}  way=${e.srcWayId ?? ''}`,
            );
        }
      }
      if (guarded.reverted.length) {
        console.warn(
          `  elevation consensus: declined ${guarded.reverted.length} correction(s) that would strand terrain: ` +
            guarded.reverted.map((c) => c.node).join(', '),
        );
      }
    }
  }

  // A lift base you can ski away from but never ski to. This must run AFTER the overrides and the
  // elevation consensus, because both re-derive edge direction — see liftSkiIn.ts for why its twin
  // (the lift-TOP ski-out) can live inside buildResortGraph and this one cannot.
  {
    const skiIn = linkLiftBaseSkiIns(graph, DEFAULT_GRAPH_CONSTANTS);
    if (skiIn.linked.length) {
      graph = skiIn.graph;
      console.log(`  ski-in: linked ${skiIn.linked.length} lift base(s) that had no way in:`);
      for (const l of skiIn.linked)
        console.log(
          `    ${l.liftName ?? '(unnamed lift)'} base ${l.base} <- ${l.onto} (${Math.round(l.distM)} m, ${l.twoWay ? 'two-way' : 'one-way down'})`,
        );
    }
  }

  // The dead-end snap invents a station link before the lift-top ski-out pass has run, so a lift
  // top can end up with both a proper descending exit and a redundant ramp climbing back out of it.
  // Same placement argument as the ski-in above: both rules ask about edge DIRECTION, which the
  // overrides and the elevation consensus re-derive. See stationAccess.ts.
  {
    const sa = tidyStationAccessLinks(graph, DEFAULT_GRAPH_CONSTANTS.maxTraverseClimb);
    graph = sa.graph;
    if (sa.redundantClimbs.length > 0) {
      console.log(
        `  station access: dropped ${sa.redundantClimbs.length} climbing link(s) out of a station that can already be skied away from`,
      );
    }
    if (sa.unboardableInbound.length > 0) {
      console.log(
        `  station access: dropped ${sa.unboardableInbound.length} link(s) arriving at the top of an up-only lift (nothing to board there)`,
      );
    }
    if (sa.keptStranding > 0) console.log(`    (kept ${sa.keptStranding} that would strand terrain)`);
  }

  // Before pruning, fuse nodes that share a spot. The snap and skeleton passes invent nodes after
  // `buildResortGraph` has already merged, so a split point can land on an existing node; the
  // resulting zero-length edge is a rung the longest-run search climbs to fake distance.
  const weld = weldCoincidentNodes(graph);
  if (weld.welded > 0) {
    graph = weld.graph;
    console.log(`  welded ${weld.welded} coincident node(s), dropping ${weld.droppedEdges} zero-length edge(s)`);
  }

  // A polygon that adopted a real centreline as its spine still emits its own skeleton lines, and
  // those often retrace the adopted line. Price the copies so the real run wins. See
  // spineDuplicates.ts.
  const dup = markSpineDuplicates(graph, skels);
  if (dup.edges > 0) {
    console.log(
      `  spine duplicates: ${dup.edges} edge(s) / ${(dup.lengthM / 1000).toFixed(1)} km ` +
        `retracing an adopted spine across ${dup.polygons} polygon(s)`,
    );
  }

  // A surface lift proves its own direction is not self-propelled, so a flat traverse running the
  // lift's uphill line between its own two stations contradicts it. Before pruning, because this
  // removes edges and pruning's redundancy proof must be the last thing that moves. See
  // surfaceLiftParallel.ts.
  const par = dropTraversesAlongSurfaceLifts(graph);
  graph = par.graph;
  if (par.dropped.length > 0) {
    console.log(
      `  dropped ${par.dropped.length} flat traverse(s) running along a surface lift` +
        (par.keptStranding > 0 ? ` (kept ${par.keptStranding} that would strand terrain)` : ''),
    );
  }

  // Every synthetic edge claims "a skier can get between these two points" on geometry alone, which
  // is blind to what lies in between. Where a public road does, the claim is false. Roads arrive
  // under their own cache key, so this is skipped (loudly) when Overpass is unreachable rather than
  // emitting a graph that was never checked. See roadCrossing.ts.
  const roads = await fetchResortRoads(resort, { refresh: opts.refresh, ttlDays: opts.ttlDays });
  if (roads === null) {
    console.warn('  WARNING: roads unavailable — synthetic road-crossing check SKIPPED');
  } else {
    const rc = dropSyntheticRoadCrossings(graph, roads);
    graph = rc.graph;
    if (rc.dropped.length > 0) {
      console.log(
        `  dropped ${rc.dropped.length} app-inferred link(s) crossing a road` +
          (rc.keptStranding > 0 ? ` (kept ${rc.keptStranding} that would strand terrain)` : ''),
      );
    }
  }

  // Last of all, and deliberately so: pruning proves an arm redundant against the graph around it,
  // and that proof is only worth anything if nothing moves afterwards. Overrides re-issue edges,
  // so this cannot live inside buildGraph. See pruneArms.ts.
  graph = pruneRedundantArms(graph, DEFAULT_GRAPH_CONSTANTS);

  // Overpass returns a way in full whenever any of its nodes touches the query bbox, so a lift or
  // run straddling the boundary arrives complete in the wrong resort's dataset. See bboxSpill.ts.
  const spill = dropOutOfAreaSpill(graph, resort);
  graph = spill.graph;
  for (const d of spill.dropped) {
    console.log(`  dropped out-of-area fragment: ${d.nodes} node(s) — ${d.label}`);
  }

  // After spill, because a fragment can be BOTH another resort's and inert, and the out-of-area
  // reason is the more informative one to print. See inertFragments.ts.
  const inert = dropInertFragments(graph);
  graph = inert.graph;
  for (const d of inert.dropped) {
    console.log(`  dropped inert fragment: ${d.nodes} node(s) / ${d.lengthM} m — ${d.label}`);
  }

  const report = validateGraph(graph);
  printReport(report);

  // Surface likely data issues (false-elevation reversals / non-skiable long connections)
  // so they're caught when adding or refreshing a resort. Review with: npm run check:audit <id>
  const summary = auditSummary(auditGraph(graph, acceptedDeadEndNodes(resort.id)));
  if (summary) console.warn(`  audit: ${summary} to review - run: npm run check:audit ${resort.id}`);

  const areaPolys = pistes
    .filter((p) => p.area && p.points.length >= 3)
    .map((p) => ({
      color: p.color,
      name: p.name,
      ref: p.ref,
      wayId: p.wayId,
      coordinates: p.points.map((pt) => [pt.lon, pt.lat] as [number, number]),
    }));
  emitResort(resort, graph, report, PUBLIC_DIR, areaPolys, skels);
}

function writeIndex(built: Resort[]): void {
  const dir = path.join(PUBLIC_DIR, 'resorts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify(
      built.map((r) => ({
        id: r.id,
        name: r.name,
        ...(r.shortName ? { shortName: r.shortName } : {}),
        country: r.country,
        center: r.center,
      })),
      null,
      2,
    ),
  );
  // Build stamp used by the app for version-based cache-busting (fresh only after a rebuild).
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ builtAt: Date.now() }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = args.find((a) => !a.startsWith('--'));
  const refresh = args.includes('--refresh');
  const ttlArg = args.find((a) => a.startsWith('--ttl-days='));
  const ttlDays = ttlArg ? Number(ttlArg.split('=')[1]) : 30;
  if (!arg) {
    console.error('Usage: tsx pipeline/build.ts <resortId|all> [--refresh] [--ttl-days=N]');
    process.exit(1);
  }
  const targets =
    arg === 'all' ? RESORTS : RESORTS.filter((r) => r.id === arg);
  if (targets.length === 0) {
    console.error(`Unknown resort "${arg}". Known: ${RESORTS.map((r) => r.id).join(', ')}`);
    process.exit(1);
  }

  const built: Resort[] = [];
  const failed: { id: string; err: string }[] = [];
  for (const resort of targets) {
    try {
      await buildResort(resort, { refresh, ttlDays });
      built.push(resort);
    } catch (err) {
      console.error(`  FAILED ${resort.id}: ${String(err)}`);
      failed.push({ id: resort.id, err: String(err) });
    }
  }
  // Merge with any previously built resorts so the index stays complete.
  const existingIds = new Set(built.map((r) => r.id));
  for (const r of RESORTS) {
    if (!existingIds.has(r.id) && fs.existsSync(path.join(PUBLIC_DIR, 'resorts', r.id, 'graph.json'))) {
      built.push(r);
    }
  }
  writeIndex(built);
  console.log(`\nDone. Built ${existingIds.size} resort(s).`);
  if (failed.length > 0) {
    // Exit non-zero so a partial `data:all` can't look like a success. A per-resort failure used
    // to be buried mid-log while the run still exited 0, which made a locked file (Windows keeps
    // graph.json open while the dev server serves it) look like the resort had been skipped.
    console.error(`\n${failed.length} resort(s) FAILED and were NOT written:`);
    for (const f of failed) console.error(`  - ${f.id}: ${f.err}`);
    console.error('\nStale data is still on disk for these. Re-run them individually; if the error');
    console.error("is an UNKNOWN/EPERM open, stop the dev server first - it's holding the file.");
    process.exit(1);
  }
}

main();
