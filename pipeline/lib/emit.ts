// Emit static per-resort assets: graph.json (routing), geo.json (map display), meta.json.
import fs from 'node:fs';
import path from 'node:path';
import type { Resort, ResortGraph } from '../../src/types/domain';
import type { ValidationReport } from './validate';

export interface AreaPoly {
  color: string;
  name?: string;
  /** Run number and OSM way id, carried so the debug overlay can label a polygon on the map. */
  ref?: string;
  wayId?: number;
  coordinates: [number, number][];
}

function geoJson(graph: ResortGraph, areaPolys: AreaPoly[]) {
  // One LineString per edge that carries display geometry (skip reverse duplicates for lifts).
  const seen = new Set<string>();
  const features: unknown[] = graph.edges
    .filter((e) => {
      if (e.area) return false; // area=yes polygons: kept in graph for routing, not drawn (perimeters double the lines)
      if (e.kind === 'lift' && e.isDownload) return false; // avoid drawing lift twice
      if (e.kind === 'connector') {
        // draw one direction of bidirectional connectors
        const key = [e.from, e.to].sort().join('-');
        if (seen.has(key)) return false;
        seen.add(key);
      }
      return true;
    })
    .map((e) => ({
      type: 'Feature' as const,
      properties: {
        kind: e.kind,
        color: e.color ?? null,
        liftType: e.liftType ?? null,
        name: e.pisteName ?? e.liftName ?? null,
        ref: e.pisteRef ?? null,
        connectorKind: e.connectorKind ?? null,
        synthetic: e.synthetic ?? false,
        offPiste: e.offPiste ?? false,
      },
      geometry: {
        type: 'LineString' as const,
        coordinates: e.geometry.map((p) => [p.lon, p.lat]),
      },
    }));
  // Area polygons (bowls/aprons) as fills — an optional overlay so the wide open
  // areas are visible without their perimeters cluttering the piste lines.
  for (const a of areaPolys) {
    features.push({
      type: 'Feature' as const,
      properties: { kind: 'area', color: a.color, name: a.name ?? null, ref: a.ref ?? null, wayId: a.wayId ?? null },
      geometry: { type: 'Polygon' as const, coordinates: [a.coordinates] },
    });
  }
  return { type: 'FeatureCollection' as const, features };
}

export function emitResort(
  resort: Resort,
  graph: ResortGraph,
  report: ValidationReport,
  publicDir: string,
  areaPolys: AreaPoly[] = [],
): void {
  const dir = path.join(publicDir, 'resorts', resort.id);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(graph));
  fs.writeFileSync(path.join(dir, 'geo.json'), JSON.stringify(geoJson(graph, areaPolys)));
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify(
      {
        resort,
        generatedAt: graph.generatedAt,
        stats: report,
        warnings: graph.warnings,
      },
      null,
      2,
    ),
  );
  console.log(`  wrote ${dir}\\{graph,geo,meta}.json`);
}
