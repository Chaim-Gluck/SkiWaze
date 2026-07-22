import type { ResortGraph } from '../types/domain';

export interface ResortIndexEntry {
  id: string;
  name: string;
  country: string;
  center: { lon: number; lat: number };
}

export type GeoFeatureCollection = {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    properties: {
      kind: 'piste' | 'lift' | 'connector' | 'area';
      color: string | null;
      liftType?: string | null;
      name: string | null;
      connectorKind?: string | null;
      synthetic?: boolean;
      custom?: boolean;
    };
    geometry:
      | { type: 'LineString'; coordinates: [number, number][] }
      | { type: 'Polygon'; coordinates: [number, number][][] };
  }[];
};

const base = import.meta.env.BASE_URL;

// Version-based cache-busting: fetch the tiny build stamp once (fresh), then reuse it as the
// query for the large graph/geo files so the browser CAN cache them across reloads and only
// re-downloads after the data is actually rebuilt.
let versionPromise: Promise<string> | null = null;
function dataVersion(): Promise<string> {
  if (!versionPromise) {
    versionPromise = fetch(`${base}resorts/build.json?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : { builtAt: '' }))
      .then((j: { builtAt?: number | string }) => String(j.builtAt ?? ''))
      .catch(() => '');
  }
  return versionPromise;
}

export async function loadResortIndex(): Promise<ResortIndexEntry[]> {
  const res = await fetch(`${base}resorts/index.json?t=${Date.now()}`);
  if (!res.ok) throw new Error(`Failed to load resort index (${res.status})`);
  return res.json();
}

export async function loadResortGraph(id: string): Promise<ResortGraph> {
  const res = await fetch(`${base}resorts/${id}/graph.json?v=${await dataVersion()}`);
  if (!res.ok) throw new Error(`Failed to load graph for ${id} (${res.status})`);
  return res.json();
}

export async function loadResortGeo(id: string): Promise<GeoFeatureCollection> {
  const res = await fetch(`${base}resorts/${id}/geo.json?v=${await dataVersion()}`);
  if (!res.ok) throw new Error(`Failed to load geo for ${id} (${res.status})`);
  return res.json();
}
