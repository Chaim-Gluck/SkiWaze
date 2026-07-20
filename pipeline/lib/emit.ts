// Emit static per-resort assets: graph.json (routing), geo.json (map display), meta.json.
import fs from 'node:fs';
import path from 'node:path';
import type { Resort, ResortGraph } from '../../src/types/domain';
import type { ValidationReport } from './validate';

function geoJson(graph: ResortGraph) {
  // One LineString per edge that carries display geometry (skip reverse duplicates for lifts).
  const seen = new Set<string>();
  const features = graph.edges
    .filter((e) => {
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
        connectorKind: e.connectorKind ?? null,
        synthetic: e.synthetic ?? false,
      },
      geometry: {
        type: 'LineString' as const,
        coordinates: e.geometry.map((p) => [p.lon, p.lat]),
      },
    }));
  return { type: 'FeatureCollection' as const, features };
}

export function emitResort(
  resort: Resort,
  graph: ResortGraph,
  report: ValidationReport,
  publicDir: string,
): void {
  const dir = path.join(publicDir, 'resorts', resort.id);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(graph));
  fs.writeFileSync(path.join(dir, 'geo.json'), JSON.stringify(geoJson(graph)));
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
