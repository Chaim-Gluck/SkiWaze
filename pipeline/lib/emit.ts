// Emit static per-resort assets: graph.json (routing), geo.json (map display), meta.json.
import fs from 'node:fs';
import path from 'node:path';
import type { Resort, ResortGraph } from '../../src/types/domain';
import type { ValidationReport } from './validate';
import { SKEL_COLORS, SKEL_ROLE } from './skelColors';

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

/**
 * Just enough of `areaSkeleton`'s `PolyResult` to draw it. Declared structurally rather than
 * imported so the emitter stays a leaf module.
 */
export interface SpineSource {
  wayId: number;
  label: string;
  cls: string;
  synth: boolean;
  corridor: boolean;
  lines: { coords: [number, number][]; color: string; width: number; way?: number }[];
  points: { at: [number, number]; color: string; r?: number; tag?: string; label?: string }[];
}

/**
 * The skeleton builder distinguishes its parts by *colour only*, which is fine to look at and
 * useless to filter on. `SKEL_ROLE` maps each colour back to the role it stands for so the debug
 * layer can style, filter and label them; anything unrecognised is an arm, which is what the
 * remaining colours (portal hub / gateway fork / unreachable) all are.
 */
const RIM_COLOR = SKEL_COLORS.rim;

/** ~0.1 m. Full float precision would roughly double the file for no visible gain. */
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Polygon skeletons as a standalone GeoJSON file.
 *
 * Deliberately NOT folded into `geo.json`: that ships to every user of the app, and this is a
 * review artifact. It is emitted by the pipeline rather than by a separate script because the one
 * thing a spine view must never do is drift from what actually shipped — the retired
 * `check:areaskel` re-derived skeletons straight from OSM, missed `build.ts`'s synthesis passes,
 * and ended up classifying every polygon class `D`.
 *
 * The rim is dropped: the `areas` layer already draws those polygons.
 */
function spinesJson(spines: SpineSource[]) {
  const features: unknown[] = [];
  for (const s of spines) {
    const common = { wayId: s.wayId, label: s.label, cls: s.cls, synth: s.synth, corridor: s.corridor };
    for (const l of s.lines) {
      if (l.color === RIM_COLOR) continue;
      features.push({
        type: 'Feature' as const,
        properties: { ...common, role: SKEL_ROLE[l.color] ?? 'arm', color: l.color, width: l.width },
        geometry: { type: 'LineString' as const, coordinates: l.coords.map(([x, y]) => [r6(x), r6(y)]) },
      });
    }
    for (const p of s.points) {
      features.push({
        type: 'Feature' as const,
        properties: { ...common, role: 'point', color: p.color, r: p.r ?? 6, label: p.label ?? p.tag ?? null },
        geometry: { type: 'Point' as const, coordinates: [r6(p.at[0]), r6(p.at[1])] },
      });
    }
  }
  return { type: 'FeatureCollection' as const, features };
}

export function emitResort(
  resort: Resort,
  graph: ResortGraph,
  report: ValidationReport,
  publicDir: string,
  areaPolys: AreaPoly[] = [],
  spines: SpineSource[] = [],
): void {
  const dir = path.join(publicDir, 'resorts', resort.id);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(graph));
  fs.writeFileSync(path.join(dir, 'geo.json'), JSON.stringify(geoJson(graph, areaPolys)));
  fs.writeFileSync(path.join(dir, 'spines.json'), JSON.stringify(spinesJson(spines)));
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
