/**
 * Trapped basins: terrain you can ski into but never ski/ride back out of.
 *
 * This replaces an earlier, narrower "one-way pocket" test (an absorbing SCC that contains a
 * lift). That test was wrong in two directions and both were found by eyeballing a real resort:
 *
 *   - It missed trapped terrain with **no lift inside** — Tignes' Balme couloirs and the Leisse
 *     runs are stranded, but the old rule skipped them because it demanded a lift.
 *   - It painted only the absorbing core, so a reviewer saw a 3-node dot when 5 nodes, four
 *     separate groups and a whole glacier bowl were actually stranded.
 *
 * The honest question is simply: **can this node get back to the resort's main body?** Anything
 * that cannot is trapped, lift or no lift, however far upstream it sits. Asking it that way found
 * that the entire Alta Badia half of Sella Ronda (437 nodes, 65 lift edges) could be skied into
 * and never left — a defect every earlier check passed.
 *
 * The main body is the largest strongly-connected component: the part of the mountain you can
 * roam freely. `mainShare` is reported so a caller can notice if that assumption ever looks wrong.
 */
import type { GraphEdge, GraphNode, ResortGraph } from '../../src/types/domain';

export interface TrappedBasin {
  resort: string;
  /** Every node that cannot get back to the main body, not just the absorbing core. */
  nodes: GraphNode[];
  /** Lifts stranded inside. May be empty — a basin with no lift is still a basin. */
  lifts: string[];
  /** Named runs inside, for a label a human can recognise on the map. */
  pistes: string[];
  /** How many piste edges are stranded. Zero means no one could ski there anyway. */
  pisteEdges: number;
  /** Edges that lead into the basin: how a skier falls in. */
  entries: GraphEdge[];
  /** The node inside closest to anything outside — the natural place to link. */
  exit: GraphNode;
  /** The nearest node outside the basin. */
  outside: GraphNode;
  gapM: number;
  /** How much higher `outside` sits than `exit`. Positive means escaping needs a climb. */
  climbM: number;
  /**
   * Worth a human's time: real skiable terrain is stranded. A basin with no piste in it is either
   * an ordinary dead-end node or an isolated lift with no runs (a goods ropeway, a nursery drag) —
   * nobody could ski there in the first place, so stranding it costs the router nothing.
   */
  significant: boolean;
  /**
   * A human reviewed this basin on the map and confirmed it is genuinely disconnected in the real
   * world (a satellite area you reach by ski bus, a closed sector). Set from `acceptedBasins` in
   * the resort's overrides. Accepted basins are never `significant`, so they leave the review list
   * for good instead of being re-litigated on every pass.
   */
  accepted?: boolean;
  /** Why it was accepted, carried through to the report so the reason stays visible. */
  acceptedWhy?: string;
}

/** A basin smaller than this is a dead-end stub, not a stranded sector. */
const MIN_SIGNIFICANT_NODES = 3;

const distM = (a: { lon: number; lat: number }, b: { lon: number; lat: number }): number => {  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * rad) * 111320;
  const y = (b.lat - a.lat) * 111320;
  return Math.hypot(x, y);
};

/** Kosaraju SCCs, iterative so a 5k-node resort can't blow the stack. */
function stronglyConnected(
  ids: string[],
  fwd: Map<string, string[]>,
  rev: Map<string, string[]>,
): Map<string, number> {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const start of ids) {
    if (seen.has(start)) continue;
    seen.add(start);
    const stack: [string, number][] = [[start, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const outs = fwd.get(top[0]) ?? [];
      if (top[1] < outs.length) {
        const next = outs[top[1]++];
        if (!seen.has(next)) {
          seen.add(next);
          stack.push([next, 0]);
        }
      } else {
        order.push(top[0]);
        stack.pop();
      }
    }
  }
  const comp = new Map<string, number>();
  let c = 0;
  for (let i = order.length - 1; i >= 0; i--) {
    const seed = order[i];
    if (comp.has(seed)) continue;
    comp.set(seed, c);
    const stack = [seed];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const prev of rev.get(cur) ?? []) {
        if (!comp.has(prev)) {
          comp.set(prev, c);
          stack.push(prev);
        }
      }
    }
    c++;
  }
  return comp;
}

export interface AcceptedBasin {
  /**
   * Node ids known to be inside the basin. Any one matching accepts it. List two or three: node
   * ids are stable but a refresh can retire the single OSM node an id was derived from, and extra
   * ids make the entry survive that.
   */
  nodes: string[];
  why: string;
}

export interface BasinReport {
  /** Every basin found, biggest first. */
  basins: TrappedBasin[];
  /** The subset worth reviewing — see `TrappedBasin.significant`. */
  significant: TrappedBasin[];
  /** Nodes in the main body, as a share of the resort. A low share means the graph is fractured. */
  mainShare: number;
  mainSize: number;
  trappedCount: number;
  /** Nodes stranded inside significant basins only. */
  significantNodes: number;
  /** Basins a human already signed off on, so the caller can report them separately. */
  accepted: TrappedBasin[];
  /** `acceptedBasins` entries that matched no basin — a stale override worth reporting. */
  staleAccepted: AcceptedBasin[];
}

export function findTrappedBasins(
  graph: ResortGraph,
  resort: string,
  acceptedBasins?: AcceptedBasin[],
): BasinReport {
  const fwd = new Map<string, string[]>();
  const rev = new Map<string, string[]>();
  for (const n of graph.nodes) {
    fwd.set(n.id, []);
    rev.set(n.id, []);
  }
  for (const e of graph.edges) {
    fwd.get(e.from)?.push(e.to);
    rev.get(e.to)?.push(e.from);
  }

  const comp = stronglyConnected(
    graph.nodes.map((n) => n.id),
    fwd,
    rev,
  );
  const members = new Map<number, string[]>();
  for (const n of graph.nodes) {
    const c = comp.get(n.id)!;
    const list = members.get(c);
    if (list) list.push(n.id);
    else members.set(c, [n.id]);
  }
  let main: string[] = [];
  for (const list of members.values()) if (list.length > main.length) main = list;

  // Walk backwards from the main body: anything that can still be reached this way has a route in.
  const canReach = new Set(main);
  const stack = [...main];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const prev of rev.get(cur) ?? []) {
      if (!canReach.has(prev)) {
        canReach.add(prev);
        stack.push(prev);
      }
    }
  }

  const trapped = graph.nodes.filter((n) => !canReach.has(n.id));
  const trappedIds = new Set(trapped.map((n) => n.id));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // Group the trapped nodes into basins by *undirected* connectivity: a skier standing anywhere in
  // one group is in the same predicament, so it is one thing for a human to judge.
  const undirected = new Map<string, string[]>();
  for (const id of trappedIds) undirected.set(id, []);
  for (const e of graph.edges) {
    if (!trappedIds.has(e.from) || !trappedIds.has(e.to)) continue;
    undirected.get(e.from)?.push(e.to);
    undirected.get(e.to)?.push(e.from);
  }
  const grouped = new Set<string>();
  const groups: string[][] = [];
  for (const id of trappedIds) {
    if (grouped.has(id)) continue;
    grouped.add(id);
    const group: string[] = [];
    const q = [id];
    while (q.length) {
      const cur = q.pop()!;
      group.push(cur);
      for (const next of undirected.get(cur) ?? []) {
        if (!grouped.has(next)) {
          grouped.add(next);
          q.push(next);
        }
      }
    }
    groups.push(group);
  }

  const outsideNodes = graph.nodes.filter((n) => !trappedIds.has(n.id));
  const basins: TrappedBasin[] = [];
  for (const group of groups) {
    const inside = new Set(group);
    const nodes = group.map((id) => byId.get(id)!);
    const lifts = new Set<string>();
    const pistes = new Set<string>();
    let pisteEdges = 0;
    for (const e of graph.edges) {
      if (!inside.has(e.from) || !inside.has(e.to)) continue;
      if (e.kind === 'lift') lifts.add(e.liftName ?? 'unnamed lift');
      else {
        if (e.kind === 'piste') pisteEdges++;
        if (e.pisteName) pistes.add(e.pisteName);
      }
    }
    const entries = graph.edges.filter((e) => !inside.has(e.from) && inside.has(e.to));

    let gapM = Infinity;
    let exit: GraphNode | null = null;
    let outside: GraphNode | null = null;
    for (const n of nodes) {
      for (const m of outsideNodes) {
        const d = distM(n.point, m.point);
        if (d < gapM) {
          gapM = d;
          exit = n;
          outside = m;
        }
      }
    }
    if (!exit || !outside) continue;

    basins.push({
      resort,
      nodes,
      lifts: [...lifts],
      pistes: [...pistes],
      pisteEdges,
      entries,
      exit,
      outside,
      gapM: Math.round(gapM),
      climbM: Math.round((outside.point.ele ?? 0) - (exit.point.ele ?? 0)),
      significant: pisteEdges > 0 && nodes.length >= MIN_SIGNIFICANT_NODES,
    });
  }

  basins.sort((a, b) => b.nodes.length - a.nodes.length);

  // Apply human sign-off last, so an accepted basin is still *found* (it stays in `basins` and on
  // the debug overlay) but stops asking for attention.
  const stale: AcceptedBasin[] = [];
  for (const entry of acceptedBasins ?? []) {
    const wanted = new Set(entry.nodes);
    const hit = basins.find((b) => b.nodes.some((n) => wanted.has(n.id)));
    if (!hit) {
      stale.push(entry);
      continue;
    }
    hit.accepted = true;
    hit.acceptedWhy = entry.why;
    hit.significant = false;
  }

  const significant = basins.filter((b) => b.significant);
  return {
    basins,
    significant,
    mainSize: main.length,
    mainShare: graph.nodes.length ? main.length / graph.nodes.length : 1,
    trappedCount: trapped.length,
    significantNodes: significant.reduce((s, b) => s + b.nodes.length, 0),
    accepted: basins.filter((b) => b.accepted),
    staleAccepted: stale,
  };
}

/** A short human label: the biggest-name features inside, so it can be found on a map. */
export function basinLabel(b: TrappedBasin): string {
  const names = [...b.lifts, ...b.pistes];
  if (!names.length) return `${b.nodes.length} unnamed nodes`;
  return names.slice(0, 3).join('/') + (names.length > 3 ? ` +${names.length - 3}` : '');
}
