// Global rule: infer a difficulty color for unrated ("unknown") downhill pistes.
//
// OSM often tags a real run/connector as `piste:type=downhill` (or `=connection`) with no
// `piste:difficulty`, so it imports as color `unknown`. The router treats `unknown` as
// *harder than black* and filters it out for every skier — which can make whole sections
// unreachable when an unrated run is the only way in (e.g. the sole ski-out from a lift top).
//
// This pass assigns each unrated piste the difficulty of its rated neighbours, following the
// downhill piste graph (connectors are transparent links you traverse *through*; lifts are
// never traversed). The rule, applied to a fixpoint:
//
//   1. Feeder rule (primary): color = the EASIEST rated run that feeds INTO it. Whoever can
//      reach this segment arrived on one of those runs, so the easiest arrival defines who
//      must be able to keep going.
//   2. Guarded downstream fallback: if nothing rated feeds it (only a lift/connector does),
//      inherit the run it FEEDS INTO — but only when it is that run's *sole* skiable feeder
//      (no other piste and no lift can reach that run). A run that is independently reachable
//      must not gain a second, possibly-harder access falsely painted as easy.
//   3. Ambiguous leftovers: color as the HARDEST neighbour, so experts can still use it while
//      easy skiers are never misrouted onto it. Left `unknown` only if nothing rated touches it.
//
// Safety: runs with a real difficulty are never changed. Freeride/backcountry runs carry
// `piste:difficulty=freeride` (→ black), so they are already rated and this pass never
// downgrades genuinely dangerous terrain.
import type { GraphEdge, PisteColor } from '../../src/types/domain';
import { PISTE_COLOR_ORDER } from '../../src/types/domain';

const rankOf = (c: PisteColor): number => PISTE_COLOR_ORDER.indexOf(c); // green 0 .. black 3
const isRated = (c: PisteColor | undefined): c is PisteColor => !!c && c !== 'unknown';
const easiest = (cs: PisteColor[]): PisteColor => cs.reduce((a, b) => (rankOf(a) <= rankOf(b) ? a : b));
const hardest = (cs: PisteColor[]): PisteColor => cs.reduce((a, b) => (rankOf(a) >= rankOf(b) ? a : b));

/**
 * Assign colors to unrated piste edges in place. Returns the number of segments colored.
 */
export function inheritUnratedPisteColors(edges: GraphEdge[]): number {
  const out = new Map<string, GraphEdge[]>();
  const inc = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (inc.get(e.to) ?? inc.set(e.to, []).get(e.to)!).push(e);
  }

  // First rated piste edges reachable from `start`, traversing only connectors (never lifts).
  const collectPistes = (start: string, adj: Map<string, GraphEdge[]>, step: (e: GraphEdge) => string): GraphEdge[] => {
    const found: GraphEdge[] = [];
    const seen = new Set<string>([start]);
    const stack = [start];
    while (stack.length) {
      const n = stack.pop()!;
      for (const e of adj.get(n) ?? []) {
        if (e.kind === 'piste') found.push(e);
        else if (e.kind === 'connector') {
          const nxt = step(e);
          if (!seen.has(nxt)) { seen.add(nxt); stack.push(nxt); }
        }
        // lifts are not traversed
      }
    }
    return found;
  };
  const feederPistes = (node: string) => collectPistes(node, inc, (e) => e.from);
  const successorPistes = (node: string) => collectPistes(node, out, (e) => e.to);

  // Whether a lift can deliver a skier into the connector-closure feeding `node` (independent
  // access, so a downstream run there is not "solely fed" by a single piste).
  const hasLiftAccess = (node: string): boolean => {
    const seen = new Set<string>([node]);
    const stack = [node];
    while (stack.length) {
      const n = stack.pop()!;
      for (const e of inc.get(n) ?? []) {
        if (e.kind === 'lift') return true;
        if (e.kind === 'connector' && !seen.has(e.from)) { seen.add(e.from); stack.push(e.from); }
      }
    }
    return false;
  };

  let colored = 0;

  // Passes 1 & 2 to a fixpoint: feeder rule, then guarded sole-feeder downstream fallback.
  let changed = true;
  let guard = edges.length + 5;
  while (changed && guard-- > 0) {
    changed = false;
    for (const p of edges) {
      if (p.kind !== 'piste' || isRated(p.color)) continue;

      const feeders = feederPistes(p.from).map((e) => e.color).filter(isRated);
      if (feeders.length) {
        p.color = easiest(feeders);
        colored++; changed = true;
        continue;
      }

      const soleColors: PisteColor[] = [];
      for (const q of successorPistes(p.to)) {
        if (!isRated(q.color)) continue;
        const qFeeders = feederPistes(q.from);
        if (qFeeders.length === 1 && qFeeders[0].id === p.id && !hasLiftAccess(q.from)) {
          soleColors.push(q.color);
        }
      }
      if (soleColors.length) {
        p.color = easiest(soleColors);
        colored++; changed = true;
      }
    }
  }

  // Pass 3: still-unrated → hardest rated neighbour (usable by experts, never misroutes easy skiers).
  for (const p of edges) {
    if (p.kind !== 'piste' || isRated(p.color)) continue;
    const neighbours = [...feederPistes(p.from), ...successorPistes(p.to)].map((e) => e.color).filter(isRated);
    if (neighbours.length) {
      p.color = hardest(neighbours);
      colored++;
    }
  }

  return colored;
}
