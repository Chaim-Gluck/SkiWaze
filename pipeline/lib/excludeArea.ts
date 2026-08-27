// Subtract neighbour terrain that falls INSIDE a resort's bbox.
//
// A resort's extent is declared as one rectangle, but real ski areas are not rectangles. Where a
// neighbouring resort shares a corner with ours (Tignes in Paradiski's south-east, for example)
// there is no rectangle that holds all of our terrain and none of theirs: shrinking a side always
// clips something real on the other end of that side.
//
// That neighbour terrain is worse than merely extra. It is usually a *trapped basin*: an off-piste
// col or a shared ridge lets the router ski INTO it, but nothing there leads back, so it strands
// nodes and pollutes the basin report forever. `bboxSpill.ts` cannot help — it only removes
// components that are undirected-disconnected AND mostly outside the bbox, and this terrain is
// neither.
//
// So the resort config may subtract rectangles: `bbox` minus `excludeBboxes`. A piste or lift is
// dropped when the MAJORITY of its points fall inside one exclusion box, which removes the
// neighbour's own runs while leaving a run that merely clips the corner intact.
import type { ResortBBox } from '../../src/types/domain';
import type { NormLift, NormPiste } from './normalize';

function inBox(p: { lon: number; lat: number }, b: ResortBBox): boolean {
  return p.lon >= b.minLon && p.lon <= b.maxLon && p.lat >= b.minLat && p.lat <= b.maxLat;
}

function mostlyInside(points: { lon: number; lat: number }[], boxes: ResortBBox[]): boolean {
  if (points.length === 0) return false;
  return boxes.some((b) => points.filter((p) => inBox(p, b)).length * 2 > points.length);
}

export interface ExcludeResult {
  pistes: NormPiste[];
  lifts: NormLift[];
  droppedPistes: number;
  droppedLifts: number;
  /** Names of dropped features, for the build log (so a bad box is obvious immediately). */
  names: string[];
}

export function dropExcludedFeatures(
  pistes: NormPiste[],
  lifts: NormLift[],
  boxes: ResortBBox[] | undefined,
): ExcludeResult {
  if (!boxes?.length) {
    return { pistes, lifts, droppedPistes: 0, droppedLifts: 0, names: [] };
  }
  const names: string[] = [];
  const keptPistes = pistes.filter((p) => {
    if (!mostlyInside(p.points, boxes)) return true;
    names.push(p.name || '(unnamed piste)');
    return false;
  });
  const keptLifts = lifts.filter((l) => {
    if (!mostlyInside(l.points, boxes)) return true;
    names.push(l.name || '(unnamed lift)');
    return false;
  });
  return {
    pistes: keptPistes,
    lifts: keptLifts,
    droppedPistes: pistes.length - keptPistes.length,
    droppedLifts: lifts.length - keptLifts.length,
    names,
  };
}
