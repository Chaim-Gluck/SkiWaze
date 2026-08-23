// Disk cache for raw pipeline inputs (Overpass responses + elevation lookups).
// Ski geography changes rarely, so we cache raw data with a TTL and only re-sync
// when it's older than the TTL or a --refresh is requested.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = path.resolve(__dirname, '..', '.cache');

export const DEFAULT_TTL_DAYS = 30;

function ensureDir(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

interface CacheEnvelope<T> {
  savedAt: number;
  data: T;
}

/** Read a cached value if it exists and is younger than ttlDays; else null. */
export function readCache<T>(key: string, ttlDays: number): T | null {
  const file = path.join(CACHE_DIR, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const env = JSON.parse(fs.readFileSync(file, 'utf8')) as CacheEnvelope<T>;
    const ageMs = Date.now() - env.savedAt;
    if (ageMs > ttlDays * 24 * 60 * 60 * 1000) return null;
    return env.data;
  } catch {
    return null;
  }
}

export function writeCache<T>(key: string, data: T): void {
  ensureDir();
  const file = path.join(CACHE_DIR, `${key}.json`);
  const env: CacheEnvelope<T> = { savedAt: Date.now(), data };
  fs.writeFileSync(file, JSON.stringify(env));
}

// --- Persistent elevation cache (shared across resorts & runs) --------------
// Keyed by coordinate rounded to ~1 m so nearby resorts reuse each other's data.

const ELE_FILE = path.join(CACHE_DIR, 'elevation-cache.json');
let eleCache: Record<string, number> | null = null;

// Entries are namespaced by the DEM they came from. Switching elevation source must not
// silently reuse the old source's samples, and keeping both lets a revert stay cheap.
function eleKey(lat: number, lon: number, ns: string): string {
  const coord = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  return ns ? `${ns}|${coord}` : coord;
}

export function loadElevationCache(): Record<string, number> {
  if (eleCache) return eleCache;
  if (fs.existsSync(ELE_FILE)) {
    try {
      eleCache = JSON.parse(fs.readFileSync(ELE_FILE, 'utf8')) as Record<string, number>;
    } catch {
      eleCache = {};
    }
  } else {
    eleCache = {};
  }
  return eleCache;
}

export function getCachedElevation(lat: number, lon: number, ns = ''): number | undefined {
  return loadElevationCache()[eleKey(lat, lon, ns)];
}

export function setCachedElevation(lat: number, lon: number, ele: number, ns = ''): void {
  loadElevationCache()[eleKey(lat, lon, ns)] = ele;
}

export function saveElevationCache(): void {
  if (!eleCache) return;
  ensureDir();
  fs.writeFileSync(ELE_FILE, JSON.stringify(eleCache));
}
