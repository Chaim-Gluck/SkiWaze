/**
 * Unify duplicate OSM nodes that occupy the same spot.
 *
 * `buildCanonicalNodes` decides which points become graph nodes by counting, **per OSM node id**,
 * how many ways contain it: an id in >= 2 ways is a junction and both ways get split there. That
 * assumes mappers reuse one node when two runs meet. They often don't — they draw each way with
 * its own node at the same coordinates. Both ids then have a way-count of 1, neither is
 * significant, neither way is split, and a junction that exists on the snow is silently dropped.
 *
 * Nothing downstream can recover it either: the endpoint merge and the endpoint->line snap both
 * only look at way *endpoints*, and these duplicates are interior vertices. `weldCoincidentNodes`
 * deliberately only welds nodes already joined by an edge, which these never are.
 *
 * Warth (Ski Arlberg) is the reference case. Run 269 Dorfabfahrt and run 266 Wannenkopf each make
 * a hairpin at 10.1756297,47.2585637 — bit-identical coordinates, node ids 3419720259 and
 * 12815432358, interior to both ways. Without the junction the Dorfbahn gondola and its two runs
 * form an 8-node island with zero edges in or out, and the resort's whole Warth sector is
 * unreachable. There is no missing terrain to invent: the split alone reconnects it.
 *
 * Safety: ways whose grade-separation signature differs (`layer`/`bridge`/`tunnel`, see
 * `levelKeyFor`) are never unified, so a run crossing over another on a bridge stays separate.
 * Points of the same way are never unified with each other, so a way cannot be made to self-loop.
 * And only **piste x piste** pairs can form a union: welding a piste onto a lift's interior would
 * invent a mid-span boarding point between two pylons. Lift points are still *rewritten* by the
 * resulting map, so a junction a lift already shared with a piste survives the renaming.
 */
import type { NormLift, NormPiste, NormPoint } from './normalize';

/**
 * Horizontal tolerance, in metres. Deliberately sub-metre: these are duplicated nodes, not nearby
 * ones. Anything genuinely "close but distinct" is left to the normal Hmerge/Vmerge clustering.
 */
const COINCIDENT_M = 0.5;

/** Bucket size in degrees, comfortably larger than COINCIDENT_M so a 3x3 scan cannot miss a pair. */
const CELL_DEG = 1e-5;

interface Entry {
  p: NormPoint;
  wayKey: string;
  levelKey: string;
  /** Only piste points may form a union; lift points ride along to be rewritten. */
  isPiste: boolean;
}

function metresBetween(a: NormPoint, b: NormPoint): number {
  const k = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot((a.lon - b.lon) * k, a.lat - b.lat) * 111320;
}

export interface UnifyResult {
  /** Number of OSM ids rewritten onto another id. */
  unified: number;
  /** Number of distinct spots that gained a junction. */
  spots: number;
}

/**
 * Rewrites `osmId` in place so that every node sharing a spot carries the same id — the smallest
 * one, so the result is independent of iteration order and node ids stay stable across refetches.
 */
export function unifyCoincidentOsmNodes(
  pistes: NormPiste[],
  lifts: NormLift[],
): UnifyResult {
  const entries: Entry[] = [];
  const push = (points: NormPoint[], wayKey: string, levelKey: string | undefined, isPiste: boolean) => {
    for (const p of points) entries.push({ p, wayKey, levelKey: levelKey ?? '', isPiste });
  };
  for (const p of pistes) push(p.points, `p${p.wayId}`, p.levelKey, true);
  for (const l of lifts) push(l.points, `l${l.wayId}`, l.levelKey, false);

  const cells = new Map<string, Entry[]>();
  for (const e of entries) {
    if (!e.isPiste) continue; // the index only needs candidates that may form a union
    const key = `${Math.round(e.p.lon / CELL_DEG)},${Math.round(e.p.lat / CELL_DEG)}`;
    const arr = cells.get(key);
    if (arr) arr.push(e);
    else cells.set(key, [e]);
  }

  // Union-find over OSM ids, always keeping the smallest id as the representative.
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r)!;
    while ((parent.get(x) ?? x) !== x) {
      const next = parent.get(x)!;
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  for (const e of entries) {
    if (!e.isPiste) continue;
    const cx = Math.round(e.p.lon / CELL_DEG);
    const cy = Math.round(e.p.lat / CELL_DEG);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const f of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (f.p.osmId === e.p.osmId) continue;
          if (f.wayKey === e.wayKey) continue; // a way meeting itself is not a junction to invent
          if (f.levelKey !== e.levelKey) continue; // bridge/tunnel: they pass, they don't meet
          if (metresBetween(e.p, f.p) > COINCIDENT_M) continue;
          union(e.p.osmId, f.p.osmId);
        }
      }
    }
  }

  const moved = new Set<number>();
  const spots = new Set<number>();
  for (const e of entries) {
    const root = find(e.p.osmId);
    if (root === e.p.osmId) continue;
    moved.add(e.p.osmId);
    spots.add(root);
    e.p.osmId = root;
  }
  return { unified: moved.size, spots: spots.size };
}
