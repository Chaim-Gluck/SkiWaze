/**
 * probe:stationclimb - lift stations you can only leave by climbing.
 *
 * The dead-end snap links a stranded lift station onto the nearest piste line. Normally that link
 * is level (fleet-wide median climb 0.0 m), because the station and the run beside it are the same
 * place. Where it climbs a lot, one of two very different things is true:
 *
 *   EXEMPT   the station has a terminal BUILDING (gondola / cable car / funicular), so the
 *            vertical is stairs or an escalator inside it, not snow. `GraphEdge.stationAccess`
 *            already marks these and `cost.ts` stops charging them as a climb.
 *   SUSPECT  the station is an open-air ramp - a chairlift base, a drag top, a rope tow - where
 *            there is no building for the metres to hide in.
 *
 * The first version of this probe labelled SUSPECT "probable mis-seated station". That framing was
 * WRONG and the probe's own second-DEM column disproves it: across the whole surviving population
 * Terrarium agrees with our station height to within 1.6 m. The honest question is not "is this
 * node the wrong height" but "should this link exist at all, or is there real terrain the snap
 * should have attached to instead" - which is why the overlay now marks provenance (dashed = app
 * invented, solid = a real OSM way) and lists the real edges touching the station.
 *
 * This probe reports the split and writes a review round for the SUSPECT half. It never edits
 * anything - a station height is fixed with `setNodeElevation`, and only after a human has read
 * the contours, because at these nodes both DEMs usually agree with each other and are simply
 * both wrong (see the Avoriaz bullet in AGENTS.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_GRAPH_CONSTANTS } from '../src/config/graphConstants';
import { sampleTerrarium } from './lib/terrarium';

const ROOT = path.resolve(import.meta.dirname, '..');
const RESORTS = path.join(ROOT, 'public', 'resorts');
const OVERLAY_DIR = path.join(ROOT, 'public', 'devtools', 'overlays');
const OVERLAY_FILE = 'station-climb.json';
const OVERLAY_ID = 'station-climb';

/** Climb above which a station link stops looking like measurement noise. */
const MIN_CLIMB_M = DEFAULT_GRAPH_CONSTANTS.maxTraverseClimb;

type Pt = { lon: number; lat: number; ele?: number };
type Edge = {
  id: string; from: string; to: string; kind: string; connectorKind?: string;
  geometry: Pt[]; lengthM: number; dropM: number; synthetic?: boolean;
  stationAccess?: 'building' | 'ramp'; liftType?: string; liftName?: string; pisteName?: string; color?: string;
  srcWayId?: number;
};
type Node = { id: string; point: Pt; kind: string };

type Case = {
  resort: string; station: string; target: string; edgeId: string;
  climb: number; len: number; label: string;
  liftNames: string[]; liftTypes: string[]; arrives: boolean; exempt: boolean;
  stationEle: number; targetEle: number;
  pistesAtTarget: string[];
  /** Real (OSM-backed) edges touching the station. If this is empty the app-added link is the ONLY way on or off. */
  realAtStation: string[];
};

const ids: string[] = JSON.parse(fs.readFileSync(path.join(RESORTS, 'index.json'), 'utf8'))
  .map((r: { id: string }) => r.id);

const cases: Case[] = [];
const overlay: Record<string, unknown> = {};

for (const id of ids) {
  const gp = path.join(RESORTS, id, 'graph.json');
  if (!fs.existsSync(gp)) continue;
  const g = JSON.parse(fs.readFileSync(gp, 'utf8')) as { nodes: Node[]; edges: Edge[]; points?: { nodeId?: string; id?: string; name?: string; label?: string }[] };
  const N = new Map(g.nodes.map((n) => [n.id, n]));
  // graph.points carries `name` ("Kindlisfeldlift (top) - 1362 m"); `label` is the older spelling.
  const labels = new Map((g.points ?? []).map((p) => [p.nodeId ?? p.id ?? '', p.name ?? p.label ?? '']));

  const entries: Case[] = [];
  for (const e of g.edges) {
    // The exact dead-end-snap population, taken from the flag the emitter stamps. Inferring it
    // from edge shape instead swept in rescue links, plateau bridges and lift ski-in links.
    if (!e.stationAccess) continue;
    const S = N.get(e.from);
    if (!S || S.kind !== 'lift_station') continue;
    // dropM > 0 means the edge GAINS height from `from` to `to`, i.e. leaving the station climbs.
    if (e.dropM <= MIN_CLIMB_M) continue;
    const lifts = g.edges.filter((x) => x.kind === 'lift' && (x.from === e.from || x.to === e.from));
    if (!lifts.length) continue;
    const T = N.get(e.to);
    if (!T) continue;
    entries.push({
      resort: id, station: e.from, target: e.to, edgeId: e.id,
      climb: e.dropM, len: e.lengthM,
      label: labels.get(e.from) || '(unnamed station)',
      liftNames: [...new Set(lifts.map((l) => l.liftName || '(unnamed)'))],
      liftTypes: [...new Set(lifts.map((l) => l.liftType || '?'))],
      arrives: lifts.some((l) => l.to === e.from),
      exempt: e.stationAccess === 'building',
      stationEle: S.point.ele ?? 0,
      targetEle: T.point.ele ?? 0,
      pistesAtTarget: [...new Set(g.edges
        .filter((x) => x.kind === 'piste' && (x.from === e.to || x.to === e.to))
        .map((x) => x.pisteName || '(unnamed)'))],
      realAtStation: g.edges
        .filter((x) => x.kind !== 'lift' && !x.synthetic && x.srcWayId != null
          && (x.from === e.from || x.to === e.from))
        .map((x) => `${x.id} ${x.kind} ${x.pisteName ?? '(unnamed)'} w${x.srcWayId}`),
    });
  }
  if (!entries.length) continue;
  cases.push(...entries);

  const suspect = entries.filter((c) => !c.exempt);
  if (!suspect.length) continue;

  // One overlay entry per resort covering every suspect case in it, so switching resort in the
  // tool still shows everything rather than only the case the review list happens to be on.
  const lines: unknown[] = [];
  const points: unknown[] = [];
  let minLon = 180, minLat = 90, maxLon = -180, maxLat = -90;
  for (const c of suspect) {
    // Draw EVERY edge touching either end, not just the subject link. The first review round
    // drew three colours and never said which line came from OSM and which the app invented,
    // and the reader could not answer "why do we need the red line at all" - which is the whole
    // question. Provenance is now carried two ways: dashed = app-invented, solid = a real OSM
    // way, and every line states its edge id, direction and `way=` in a click popup.
    const touching = g.edges.filter((e) =>
      e.from === c.station || e.to === c.station || e.from === c.target || e.to === c.target);
    for (const e of touching) {
      const app = !!e.synthetic || e.srcWayId == null;
      const subject = e.id === c.edgeId;
      const color = subject ? '#e11d48' : e.kind === 'lift' ? '#b5179e' : app ? '#f97316' : '#1560ff';
      // Trim the cable: a 2 km lift drawn whole hides the 20 m link that is the subject.
      const geom = e.kind === 'lift' ? e.geometry.slice(0, 8) : e.geometry;
      const what = e.kind === 'lift'
        ? `lift ${e.liftName ?? '(unnamed)'} [${e.liftType ?? '?'}]`
        : e.kind === 'piste'
          ? `piste ${e.pisteName ?? '(unnamed)'}${e.color ? ' (' + e.color + ')' : ''}`
          : `${e.connectorKind ?? 'connector'}`;
      lines.push({
        coords: geom.map((p) => [p.lon, p.lat]),
        color, width: subject ? 6 : 4, dash: app,
        way: e.srcWayId ?? null,
        tip: `<b>${e.id}</b>${subject ? ' &lt;- THE LINK UNDER REVIEW' : ''}<br>${what}`
          + `<br>${e.from} -&gt; ${e.to} (one-way as drawn)`
          + `<br>${e.lengthM.toFixed(0)} m, ${e.dropM >= 0 ? 'climbs' : 'drops'} ${Math.abs(e.dropM).toFixed(1)} m`
          + `<br>${app ? '<b>APP-ADDED</b> - no OSM way behind it' : `real OSM way <b>w${e.srcWayId}</b>`}`,
      });
    }
    const S = N.get(c.station)!, T = N.get(c.target)!;
    points.push({ at: [S.point.lon, S.point.lat], color: '#e11d48', r: 17, tag: `${c.label} ${c.stationEle.toFixed(0)}m`,
      label: `<b>${c.station}</b> ${c.label}<br>${c.liftNames.join(', ')} [${c.liftTypes.join(', ')}]<br>our elevation ${c.stationEle.toFixed(1)} m` });
    points.push({ at: [T.point.lon, T.point.lat], color: '#16a34a', r: 13, tag: `${c.targetEle.toFixed(0)}m`,
      label: `<b>${c.target}</b> on ${c.pistesAtTarget.join(' / ')}<br>our elevation ${c.targetEle.toFixed(1)} m` });
    for (const p of [S.point, T.point]) {
      minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    }
  }
  overlay[id] = {
    focus: { bounds: [[minLon, minLat], [maxLon, maxLat]] },
    lines, points,
    notes: `<b>Station climb-outs (${suspect.length})</b>`
      + `<br><b>Dashed = the app invented this line. Solid = a real OSM way.</b> Click any line for its edge id, direction, length, climb and way id.`
      + `<br>Thick red dashed = the link under review. Magenta = the lift (drawn short on purpose). Blue = real pistes. Orange dashed = other app-added links.`
      + `<br>Red dot = the station, green dot = where the link lands; both tagged with OUR elevation.`
      + `<br><b>The question:</b> does anything real already serve this station, or is the dashed red line the only way on or off it?`,
  };
}

const suspect = cases.filter((c) => !c.exempt);
const exempt = cases.filter((c) => c.exempt);

console.log(`station links climbing > ${MIN_CLIMB_M} m: ${cases.length}  (exempt/building ${exempt.length}, SUSPECT ${suspect.length})\n`);
const row = (c: Case) =>
  `  ${c.resort.padEnd(21)} ${c.station.padEnd(16)} ${(c.climb.toFixed(1) + 'm').padStart(6)} /${(c.len.toFixed(0) + 'm').padStart(5)} = ${((c.climb / c.len) * 100).toFixed(0).padStart(3)}%  ${c.liftTypes.join(',').padEnd(11)} ${c.label}`;
console.log('EXEMPT (terminal building - cost already waived):');
exempt.forEach((c) => console.log(row(c)));
console.log('\nSUSPECT (open-air lift - no terminal building to hide the metres in):');
suspect.sort((a, b) => b.climb - a.climb).forEach((c) => console.log(row(c)));

// Second opinion, so the review round starts with more than our own number. Terrarium is NOT
// fully independent (our field averages it with skadi where they agree within 8 m), so treat an
// agreement as weak evidence and the contours as the decider.
console.log('\nsecond DEM (Terrarium) at each suspect station:');
const notes = new Map<string, string>();
for (const c of suspect) {
  let extra = '';
  try {
    const S = await sampleTerrarium(
      JSON.parse(fs.readFileSync(path.join(RESORTS, c.resort, 'graph.json'), 'utf8'))
        .nodes.find((n: Node) => n.id === c.station).point.lat,
      JSON.parse(fs.readFileSync(path.join(RESORTS, c.resort, 'graph.json'), 'utf8'))
        .nodes.find((n: Node) => n.id === c.station).point.lon,
    );
    const d = S.point - c.stationEle;
    extra = `Terrarium ${S.point.toFixed(0)} m (${d >= 0 ? '+' : ''}${d.toFixed(1)} vs ours), smoothed ${S.smooth.toFixed(0)} m`;
    console.log(`  ${c.resort.padEnd(21)} ${c.station.padEnd(16)} ours ${c.stationEle.toFixed(0)}  ${extra}`);
  } catch {
    extra = 'Terrarium unavailable';
    console.log(`  ${c.resort.padEnd(21)} ${c.station.padEnd(16)} ${extra}`);
  }
  notes.set(c.edgeId, extra);
}

fs.mkdirSync(OVERLAY_DIR, { recursive: true });
fs.writeFileSync(path.join(OVERLAY_DIR, OVERLAY_FILE), JSON.stringify(overlay, null, 1));

// Register the overlay once. The index is hand-maintained for the other overlays, so merge rather
// than rewrite - clobbering it would take every other investigation off the tool.
const idxPath = path.join(OVERLAY_DIR, 'index.json');
const idx: { id: string; label: string; file: string; description: string }[] =
  JSON.parse(fs.readFileSync(idxPath, 'utf8'));
const meta = {
  id: OVERLAY_ID,
  label: 'Station climb-outs (mis-seated stations)',
  file: OVERLAY_FILE,
  description: `A lift station whose only app-added way onto the piste network CLIMBS more than ${MIN_CLIMB_M} m, at a lift with no terminal building (chairlift base, drag top, rope tow) - so the metres cannot be stairs and the station is probably seated too low. Red = the link, magenta = the lift, blue = the runs it lands on. Regenerate with npm run probe:stationclimb.`,
};
const at = idx.findIndex((o) => o.id === OVERLAY_ID);
if (at >= 0) idx[at] = meta; else idx.push(meta);
fs.writeFileSync(idxPath, JSON.stringify(idx, null, 1));

// The review list is shared: `check:basins` overwrites it whenever an unsigned basin exists. That
// is documented behaviour, so record the reasoning in an override or a checkpoint, never only here.
if (suspect.length) {
  const review = suspect.map((c) => {
    const g = JSON.parse(fs.readFileSync(path.join(RESORTS, c.resort, 'graph.json'), 'utf8')) as { nodes: Node[] };
    const S = g.nodes.find((n) => n.id === c.station)!;
    const top = c.label.includes('(top)');
    return {
      label: `${c.resort}: ${c.label} - climbs ${c.climb.toFixed(1)} m over ${c.len.toFixed(0)} m (${((c.climb / c.len) * 100).toFixed(0)}%)`,
      resort: c.resort,
      // Name the overlay that wrote this round. The review list and the overlay selector are
      // independent controls, so without this a reviewer steps through the list while looking at
      // whatever overlay was left selected - which is silently often one with no data here.
      overlay: OVERLAY_ID,
      node: c.station,
      center: [S.point.lon, S.point.lat],
      zoom: 18,
      note: `<b>Station climb-out.</b> ${c.liftNames.join(', ')} [${c.liftTypes.join(', ')}], the lift ${c.arrives ? 'ARRIVES here as well as departing' : 'only departs here'}. The app's only link from this station onto the piste network is <b>${c.edgeId}</b>, which climbs <b>${c.climb.toFixed(1)} m over ${c.len.toFixed(0)} m (${((c.climb / c.len) * 100).toFixed(0)}%)</b> to reach ${c.pistesAtTarget.join(' / ')} at ${c.targetEle.toFixed(0)} m.`
        + `<br><br><b>Real OSM terrain touching this station:</b> ${c.realAtStation.length ? c.realAtStation.join('; ') : '<b>NONE</b> - the dashed red link is the only way on or off it.'}`
        + `<br><br><b>Elevation is NOT the explanation here.</b> Our station height is ${c.stationEle.toFixed(0)} m and ${notes.get(c.edgeId) ?? 'the second DEM agrees'} - so this is not a mis-sampled node, whatever the earlier framing of this probe said.`
        + (top ? ` It is a lift <b>TOP</b>, and by our own lift-type rule a drag/chair top is a SOURCE: routes should leave it, not climb into it.` : '')
        + `<br><br><b>What to look for:</b> dashed = the app invented the line, solid = a real OSM way; click any line for its edge id and way id. Then answer one question - is there real terrain at this station that the run should attach to instead (a snap the app got wrong), or does the run genuinely start above the station so a skier steps up a few metres (leave it alone)?`,
    };
  });
  fs.writeFileSync(path.join(OVERLAY_DIR, 'review-list.json'), JSON.stringify(review, null, 2));
  console.log(`\nwrote ${OVERLAY_FILE} (${Object.keys(overlay).length} resorts) and review-list.json (${review.length} entries)`);
  console.log('open /devtools/mapdebug.html - overlay "Station climb-outs", then use the review list prev/next');
} else {
  console.log('\nno suspect cases - review list left untouched');
}
