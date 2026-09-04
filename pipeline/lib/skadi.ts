/**
 * SRTM 1-arcsec (~30 m) elevation, read straight from the AWS Open Data "skadi" bucket.
 *
 * This is the SAME dataset opentopodata serves as `srtm30m` — verified against it at five points
 * spanning the Plateau Rosa icefield, Zermatt and Cervinia village: worst difference 0.4 m, which
 * is opentopodata rounding to whole metres. The difference is that AWS has no key, no daily cap and
 * no per-second throttle, so a fleet-wide refresh is bounded by download speed rather than by a
 * 1000-call/day budget. That budget was the sole reason a full re-sample of the fleet took ~5 days
 * and forced us to ship resorts on mismatched DEMs.
 *
 * A tile is one 1°x1° cell, 3601x3601 big-endian int16, row 0 at the NORTH edge, ~16 MB gzipped.
 * A resort spans one or two, so the whole fleet is a few hundred MB fetched once and cached on
 * disk (pipeline/.cache/skadi, git-ignored) — after which sampling is free and offline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CACHE = path.join(ROOT, 'pipeline', '.cache', 'skadi');

/** SRTM's nodata marker. Voids are real (radar shadow in steep terrain) and must not be averaged. */
const VOID = -32768;

fs.mkdirSync(CACHE, { recursive: true });

const tiles = new Map<string, Buffer | null>();

function tileName(lat: number, lon: number): { dir: string; name: string } {
  const la = Math.floor(lat);
  const lo = Math.floor(lon);
  const dir = (la >= 0 ? 'N' : 'S') + String(Math.abs(la)).padStart(2, '0');
  const name = dir + (lo >= 0 ? 'E' : 'W') + String(Math.abs(lo)).padStart(3, '0');
  return { dir, name };
}

async function loadTile(lat: number, lon: number): Promise<Buffer | null> {
  const { dir, name } = tileName(lat, lon);
  const memo = tiles.get(name);
  if (memo !== undefined) return memo;

  const file = path.join(CACHE, `${name}.hgt`);
  if (!fs.existsSync(file)) {
    const url = `https://s3.amazonaws.com/elevation-tiles-prod/skadi/${dir}/${name}.hgt.gz`;
    const res = await fetch(url);
    if (!res.ok) {
      // Ocean and the poles simply have no tile. That is data, not an outage.
      tiles.set(name, null);
      return null;
    }
    fs.writeFileSync(file, gunzipSync(Buffer.from(await res.arrayBuffer())));
  }
  const buf = fs.readFileSync(file);
  tiles.set(name, buf);
  return buf;
}

/**
 * Bilinear sample, matching opentopodata's default interpolation — nearest-post instead disagrees
 * with it by up to 10 m on a slope, which would look like a dataset difference when it is only a
 * sampling one.
 */
export async function sampleSkadi(lat: number, lon: number): Promise<number | null> {
  const hgt = await loadTile(lat, lon);
  if (!hgt) return null;
  const side = Math.round(Math.sqrt(hgt.length / 2));
  const y = (Math.floor(lat) + 1 - lat) * (side - 1);
  const x = (lon - Math.floor(lon)) * (side - 1);
  const r0 = Math.min(Math.max(Math.floor(y), 0), side - 2);
  const c0 = Math.min(Math.max(Math.floor(x), 0), side - 2);
  const fy = y - r0;
  const fx = x - c0;
  const at = (r: number, c: number) => hgt.readInt16BE((r * side + c) * 2);
  const a = at(r0, c0);
  const b = at(r0, c0 + 1);
  const c = at(r0 + 1, c0);
  const d = at(r0 + 1, c0 + 1);
  if (a === VOID || b === VOID || c === VOID || d === VOID) return null;
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}
