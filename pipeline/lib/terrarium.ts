/**
 * Independent second-opinion DEM: Mapzen/AWS "Terrarium" RGB terrain tiles (free, no rate limit).
 *
 * Extracted from the read-only audit (`_elevaudit.ts`) so the BUILD can consult the same source the
 * audit does. If these ever diverge, the pipeline would be auto-correcting against one field while
 * the audit judged it against another — so both import from here.
 *
 * Tiles are cached on disk (pipeline/.cache/terrarium) and in memory for the process.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CACHE = path.join(ROOT, 'pipeline', '.cache', 'terrarium');

/** ~13 m/pixel at 47°N — fine enough to localise a node, coarse enough to be stable. */
export const Z = 13;

const TILE_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

fs.mkdirSync(CACHE, { recursive: true });

export function lonToXpix(lon: number, z: number): number {
  return ((lon + 180) / 360) * Math.pow(2, z) * 256;
}
export function latToYpix(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z) * 256;
}

const tileCache = new Map<string, { data: Buffer; width: number; height: number } | null>();

async function loadTile(
  z: number,
  x: number,
  y: number,
): Promise<{ data: Buffer; width: number; height: number } | null> {
  const key = `${z}/${x}/${y}`;
  const memo = tileCache.get(key);
  if (memo !== undefined) return memo;
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
      // Remember the miss: without this a resort outside tile coverage refetches per node.
      tileCache.set(key, null);
      return null;
    }
  }
  const png = PNG.sync.read(buf);
  const t = { data: png.data, width: png.width, height: png.height };
  tileCache.set(key, t);
  return t;
}

/** Elevation at an integer global pixel (resolves its own tile). */
async function elevAtPixel(px: number, py: number, z: number): Promise<number | null> {
  const tx = Math.floor(px / 256),
    ty = Math.floor(py / 256);
  const ix = px - tx * 256,
    iy = py - ty * 256;
  const tile = await loadTile(z, tx, ty);
  if (!tile) return null;
  const off = (iy * tile.width + ix) * 4;
  const r = tile.data[off],
    g = tile.data[off + 1],
    b = tile.data[off + 2];
  return r * 256 + g + b / 256 - 32768;
}

/**
 * Bilinear elevation at a point, plus a smoothed neighbourhood median (5x5 at ~1px spacing).
 * `smooth` mimics how a topo map's contours smooth the DEM, so Terrarium's own single-pixel
 * spikes/voids don't become our new truth.
 */
export async function sampleTerrarium(
  lat: number,
  lon: number,
): Promise<{ point: number | null; smooth: number | null }> {
  const gx = lonToXpix(lon, Z),
    gy = latToYpix(lat, Z);
  const x0 = Math.floor(gx),
    y0 = Math.floor(gy),
    fx = gx - x0,
    fy = gy - y0;
  const p00 = await elevAtPixel(x0, y0, Z),
    p10 = await elevAtPixel(x0 + 1, y0, Z);
  const p01 = await elevAtPixel(x0, y0 + 1, Z),
    p11 = await elevAtPixel(x0 + 1, y0 + 1, Z);
  let point: number | null = null;
  if ([p00, p10, p01, p11].every((v) => v != null)) {
    point =
      p00! * (1 - fx) * (1 - fy) + p10! * fx * (1 - fy) + p01! * (1 - fx) * fy + p11! * fx * fy;
  }
  const vals: number[] = [];
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const v = await elevAtPixel(x0 + dx, y0 + dy, Z);
      if (v != null) vals.push(v);
    }
  vals.sort((a, b) => a - b);
  const smooth = vals.length ? vals[Math.floor(vals.length / 2)] : null;
  return { point, smooth };
}
