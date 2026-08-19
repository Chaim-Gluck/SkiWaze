// Read-only elevation cross-check audit.
// Usage: tsx pipeline/_elevaudit.ts <resortId|all> [thresholdMeters]
//
// Our pipeline samples elevation from SRTM-30m sources (open-elevation / opentopodata srtm30m),
// so a single mis-sampled DEM pixel (a "spike"/"pothole") can slip in and silently reverse a
// piste or invent a false rim. This audit cross-references every graph node against an INDEPENDENT
// DEM — Mapzen/AWS "Terrarium" RGB terrain tiles (free, no rate limit) — plus a local smoothed
// value (median of a small neighbourhood, mimicking how the topo map's contours smooth the DEM).
// It FLAGS nodes whose stored elevation disagrees with the second source beyond a threshold, for
// human review. It NEVER edits data — apply confirmed fixes via setNodeElevation in
// pipeline/overrides/<id>.json. Terrarium tiles are cached on disk (pipeline/.cache/terrarium).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import type { ResortGraph } from '../src/types/domain';
import { loadOverrides } from './lib/overrides';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OVERRIDE_DIR = path.join(ROOT, 'pipeline', 'overrides');
const CACHE = path.join(ROOT, 'pipeline', '.cache', 'terrarium');
const Z = 13; // ~13 m/pixel at 47°N — fine enough to localise a node, coarse enough to be stable
const TILE_URL = (z: number, x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

fs.mkdirSync(CACHE, { recursive: true });

function lonToXpix(lon: number, z: number): number { return ((lon + 180) / 360) * Math.pow(2, z) * 256; }
function latToYpix(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z) * 256;
}
function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000, dLat = ((lat2 - lat1) * Math.PI) / 180, dLon = ((lon2 - lon1) * Math.PI) / 180;
  const la = (lat1 * Math.PI) / 180, lb = (lat2 * Math.PI) / 180;
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2));
}

const tileCache = new Map<string, { data: Buffer; width: number; height: number }>();
async function loadTile(z: number, x: number, y: number): Promise<{ data: Buffer; width: number; height: number } | null> {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key)!;
  const file = path.join(CACHE, `${z}_${x}_${y}.png`);
  let buf: Buffer | null = null;
  if (fs.existsSync(file)) buf = fs.readFileSync(file);
  else {
    try {
      const res = await fetch(TILE_URL(z, x, y));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(file, buf);
    } catch (e) {
      console.warn(`  tile ${key} fetch failed: ${String(e)}`);
      return null;
    }
  }
  const png = PNG.sync.read(buf);
  const t = { data: png.data, width: png.width, height: png.height };
  tileCache.set(key, t);
  return t;
}

// Elevation at an integer global pixel (resolves its own tile).
async function elevAtPixel(px: number, py: number, z: number): Promise<number | null> {
  const tx = Math.floor(px / 256), ty = Math.floor(py / 256);
  const ix = px - tx * 256, iy = py - ty * 256;
  const tile = await loadTile(z, tx, ty);
  if (!tile) return null;
  const off = (iy * tile.width + ix) * 4;
  const r = tile.data[off], g = tile.data[off + 1], b = tile.data[off + 2];
  return r * 256 + g + b / 256 - 32768;
}

// Bilinear elevation at a node, plus a smoothed neighbourhood median (5x5 at ~1px spacing).
export async function sampleNode(lat: number, lon: number): Promise<{ point: number | null; smooth: number | null }> {
  const gx = lonToXpix(lon, Z), gy = latToYpix(lat, Z);
  const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
  const p00 = await elevAtPixel(x0, y0, Z), p10 = await elevAtPixel(x0 + 1, y0, Z);
  const p01 = await elevAtPixel(x0, y0 + 1, Z), p11 = await elevAtPixel(x0 + 1, y0 + 1, Z);
  let point: number | null = null;
  if ([p00, p10, p01, p11].every((v) => v != null)) {
    point = p00! * (1 - fx) * (1 - fy) + p10! * fx * (1 - fy) + p01! * (1 - fx) * fy + p11! * fx * fy;
  }
  const vals: number[] = [];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const v = await elevAtPixel(x0 + dx, y0 + dy, Z);
    if (v != null) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  const smooth = vals.length ? vals[Math.floor(vals.length / 2)] : null;
  return { point, smooth };
}

type OverlayEntry = { focus: { bounds: [[number, number], [number, number]] }; lines: unknown[]; points: unknown[]; notes: string };
async function auditResort(id: string, thresh: number): Promise<OverlayEntry | null> {
  const gp = path.join(ROOT, 'public', 'resorts', id, 'graph.json');
  if (!fs.existsSync(gp)) { console.error(`No graph at ${gp} — run: npm run data ${id}`); return null; }
  const g = JSON.parse(fs.readFileSync(gp, 'utf8')) as ResortGraph;
  const pointName = (nid: string) => { const p = g.points.find((x) => x.nodeId === nid); return p ? p.name : ''; };
  const M = new Map<string, { id: string; our: number; terr: number; smooth: number; corrected: number; changed: boolean; lat: number; lon: number; kind: string; name: string }>();
  let checked = 0;
  for (const n of g.nodes) {
    if (n.point.ele == null) continue;
    const { point, smooth } = await sampleNode(n.point.lat, n.point.lon);
    if (point == null || smooth == null) continue;
    checked++;
    const our = n.point.ele;
    // Correct against the SMOOTHED second-source value (median neighbourhood) so Terrarium's own
    // single-pixel spikes/voids are not trusted. A node is "changed" if the two disagree > thresh.
    const changed = Math.abs(our - smooth) > thresh;
    M.set(n.id, { id: n.id, our, terr: point, smooth, corrected: changed ? smooth : our, changed, lat: n.point.lat, lon: n.point.lon, kind: n.kind, name: pointName(n.id) });
  }

  // --- Routing-impact: piste edges that FLIP direction under the JOINT corrected field ----------
  // Apply every correction at once (not one node at a time) so a reversal that only appears when a
  // whole cluster is corrected together is still caught — the failure mode that hides single spikes.
  const FLAT_EDGE = 60; // only skip clearly-steep pistes; a smaller fake gradient can still be a flip
  const DIR = 10;       // second source must disagree on flow direction by at least this many m
  let flips: Array<{ from: string; to: string; ao: number; bo: number; ac: number; bc: number; margin: number; strong: boolean; changed: string; geom: Array<[number, number]> }> = [];
  const seenFlip = new Set<string>();
  for (const e of g.edges) {
    if (e.kind !== 'piste' || e.area) continue; // area (bowl) boundaries have no meaningful direction
    const key = `${e.from}->${e.to}`;
    if (seenFlip.has(key)) continue;
    const A = M.get(e.from), B = M.get(e.to);
    if (!A || !B) continue;
    const ourDrop = A.our - B.our; // >=0: we oriented it descending from->to
    if (ourDrop > FLAT_EDGE) continue; // clearly descending as sampled — trust it, not a flip risk
    const terrDrop = A.terr - B.terr;     // independent POINT source: <0 means to-end is really higher
    const smoothDrop = A.smooth - B.smooth; // smoothed neighbourhood, same sign convention
    // Flag when the second source says the flow should go the OTHER way by a clear margin — this
    // catches near-flat reversals from SMALL sampling errors that a large "changed" threshold misses.
    if (terrDrop < -DIR) {
      seenFlip.add(key);
      const strong = smoothDrop < -DIR; // point AND smoothed both agree on the reverse gradient
      const who = `${e.from} our${Math.round(A.our)}~terr${Math.round(A.terr)}  ${e.to} our${Math.round(B.our)}~terr${Math.round(B.terr)}`;
      flips.push({ from: A.id, to: B.id, ao: Math.round(A.our), bo: Math.round(B.our), ac: Math.round(A.terr), bc: Math.round(B.terr), margin: Math.round(-terrDrop), strong, changed: who, geom: (e.geometry || []).map((p) => [p.lon, p.lat] as [number, number]) });
    }
  }
  flips.sort((a, b) => (Number(b.strong) - Number(a.strong)) || (b.margin - a.margin));

  // Drop candidates a human already checked on the map and confirmed we have right (the DEM is
  // wrong there, not us). Without this every future audit re-reports the same known-good spots and
  // the real signal drowns. Matched on the unordered pair, since which way it points is the point.
  const pairKey = (a: string, b: string) => [a, b].sort().join('~');
  const ignored = new Set((loadOverrides(id, OVERRIDE_DIR)?.ignoreReversals ?? []).map((r) => pairKey(r.from, r.to)));
  const suppressed = flips.filter((f) => ignored.has(pairKey(f.from, f.to)));
  flips = flips.filter((f) => !ignored.has(pairKey(f.from, f.to)));

  // Build a map-tool overlay entry for the reversal candidates (green = suggested top per corrected
  // elevations; orange = current/too-high top). Confidence by reversal margin: >=20 m strong (red).
  const oLines: Array<{ coords: Array<[number, number]>; color: string; width: number; label: string }> = [];
  const oPoints: Array<{ at: [number, number]; color: string; r: number; tag: string; label: string }> = [];
  const ob: [[number, number], [number, number]] = [[Infinity, Infinity], [-Infinity, -Infinity]];
  for (const f of flips) {
    if (f.geom.length < 2) continue;
    const strong = f.strong;
    f.geom.forEach(([lo, la]) => { ob[0][0] = Math.min(ob[0][0], lo); ob[0][1] = Math.min(ob[0][1], la); ob[1][0] = Math.max(ob[1][0], lo); ob[1][1] = Math.max(ob[1][1], la); });
    oLines.push({ coords: f.geom, color: strong ? '#e11d1d' : '#f59e0b', width: 4, label: `${f.from}->${f.to} reverses (margin ${f.margin} m; fix ${f.changed})` });
    oPoints.push({ at: f.geom[f.geom.length - 1], color: '#22a06b', r: 16, tag: f.to, label: `SUGGESTED TOP (descend from here) · ${f.to} · corrected ${f.bc} m` });
    oPoints.push({ at: f.geom[0], color: '#f59e0b', r: 14, tag: f.from, label: `current top (looks too high) · ${f.from} · our ${f.ao}->${f.ac} m` });
  }
  const overlayEntry = oLines.length
    ? { focus: { bounds: ob }, lines: oLines, points: oPoints,
        notes: `<b>${oLines.length} elevation-reversal candidate(s).</b> Each line is a piste that would flip direction once mis-sampled elevations are corrected. <span style="color:#22a06b">Green</span> = where the run SHOULD start (top per corrected DEM); it currently starts at the <span style="color:#f59e0b">orange</span> end. Red line = strong (an independent point DEM agrees), orange line = marginal (verify carefully). Check the topo layer: does the slope actually fall away from the green dot?` }
    : null;


  // --- Spatial clusters of corrected nodes (so a whole bench is fixed in one override) ----------
  const changedNodes = [...M.values()].filter((x) => x.changed);
  const clusters: Array<{ lat: number; lon: number; members: typeof changedNodes }> = [];
  for (const n of changedNodes) {
    let c = clusters.find((cl) => haversineM(cl.lat, cl.lon, n.lat, n.lon) < 90);
    if (c) { c.members.push(n); c.lat = c.members.reduce((s, m) => s + m.lat, 0) / c.members.length; c.lon = c.members.reduce((s, m) => s + m.lon, 0) / c.members.length; }
    else clusters.push({ lat: n.lat, lon: n.lon, members: [n] });
  }
  clusters.sort((a, b) => b.members.length - a.members.length);

  console.log(`\n=== elevation audit: ${id} ===`);
  console.log(`nodes checked=${checked}/${g.nodes.length}  threshold=±${thresh} m  disagreeing=${changedNodes.length}  clusters=${clusters.length}`);

  console.log(`\n[ROUTING IMPACT] piste edges that REVERSE under the corrected field: ${flips.length}`);
  for (const f of flips.slice(0, 40)) {
    const conf = f.strong ? 'strong' : 'marginal';
    console.log(`  ${f.from}->${f.to}  now ${f.ao}->${f.bo}  corrected ${f.ac}->${f.bc}  margin ${f.margin}m [${conf}]  (fix: ${f.changed})`);
  }
  if (flips.length > 40) console.log(`  … and ${flips.length - 40} more`);
  if (suppressed.length) {
    console.log(`  (${suppressed.length} verified-good candidate(s) suppressed via ignoreReversals in overrides/${id}.json: ${suppressed.map((f) => `${f.from}->${f.to}`).join(', ')})`);
  }

  console.log(`\n[CLUSTERS] groups of disagreeing nodes (fix together in overrides/${id}.json):`);
  for (const c of clusters.slice(0, 25)) {
    if (c.members.length < 2) continue;
    const sugg = Math.round(c.members.map((m) => m.corrected).sort((a, b) => a - b)[Math.floor(c.members.length / 2)]);
    const ids = c.members.map((m) => `${m.id}(${Math.round(m.our)}->${Math.round(m.corrected)})`).join(' ');
    console.log(`  @${c.lat.toFixed(5)},${c.lon.toFixed(5)}  x${c.members.length}  ~${sugg} m:  ${ids}`);
  }
  const singles = clusters.filter((c) => c.members.length === 1).length;
  console.log(`  (+${singles} isolated single-node disagreement(s))`);
  return overlayEntry;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const thresh = Number(process.argv[3] || 40);
  if (!arg) { console.error('Usage: tsx pipeline/_elevaudit.ts <resortId|all> [thresholdMeters]'); process.exit(1); }
  let ids: string[];
  if (arg === 'all') {
    const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'resorts', 'index.json'), 'utf8'));
    ids = (Array.isArray(idx) ? idx : idx.resorts || []).map((r: { id: string }) => r.id);
  } else ids = [arg];

  // Load existing overlay so a single-resort run updates just that resort's entry.
  const overlayPath = path.join(ROOT, 'public', 'devtools', 'overlays', 'elevation-reversals.json');
  let overlay: Record<string, OverlayEntry> = {};
  if (fs.existsSync(overlayPath)) { try { overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8')); } catch { overlay = {}; } }
  for (const id of ids) {
    const entry = await auditResort(id, thresh);
    if (entry) overlay[id] = entry; else delete overlay[id];
  }
  fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
  fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));
  console.log(`\nwrote overlay: public/devtools/overlays/elevation-reversals.json (${Object.keys(overlay).length} resort(s) with candidates)`);
}

// Only run the audit when invoked as a script — _elevprobe.ts imports sampleNode from here.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
