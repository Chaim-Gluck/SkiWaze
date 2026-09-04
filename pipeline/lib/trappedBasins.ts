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
  /**
   * The node inside to link, chosen so that a link there frees as much of the basin as possible.
   * NOT simply the nearest node: see the comment at the selection site. A link only helps the
   * skiers who can reach it, so on a one-way descent the nearest node is usually the useless one.
   */
  exit: GraphNode;
  /**
   * Where a link from `exit` would actually land. Usually this is an existing node, but very often
   * the nearest terrain is the *side* of a run rather than either of its ends — a run only carries
   * a graph node where it meets or ends, so its whole middle is nodeless. Searching nodes alone
   * therefore overstates the gap and can point the reviewer at the wrong spot entirely.
   */
  outside: BasinTarget;
  gapM: number;
  /**
   * How many of the basin's nodes a link at `exit` would actually free (i.e. how many can ski to
   * it). Equal to `nodes.length` when the whole basin drains to one point. Less than that means
   * the basin has several independent sinks and one link cannot fix all of it.
   */
  frees: number;
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

/**
 * Somewhere outside the basin a rescue link could attach.
 *
 * It is deliberately NOT a `GraphNode`. Measuring node-to-node was a structural blind spot: at
 * Sella Ronda's Nives / La Poza skiweg the detector proposed a 258 m link at -4.6%, while the run
 * that actually passes the skiweg's west end does so 157 m away at -8.3% — 100 m shorter and a far
 * more plausible ski grade — as interior vertex 6 of 25, where there is no node at all. A human
 * spotted it on the map; the detector could not.
 */
export interface BasinTarget {
  at: { lon: number; lat: number; ele: number };
  /** Set when the target is an existing graph node. */
  nodeId?: string;
  /** Set when the target is a point ALONG an edge — a link here would split that edge. */
  edgeId?: string;
  /** Something a reviewer can find on the map: a node id, or a run name plus its way. */
  label: string;
}

/** A basin smaller than this is a dead-end stub, not a stranded sector. */
const MIN_SIGNIFICANT_NODES = 3;

/**
 * How far out to look for a rescue target. Beyond this nobody would bridge anyway, and the cap is
 * what keeps the segment search cheap — it bounds how many grid cells each basin node visits.
 */
const MAX_TARGET_M = 1500;

/** Grid cell size for the segment index. Comfortably above the typical piste segment length. */
const CELL_M = 250;

const distM = (a: { lon: number; lat: number }, b: { lon: number; lat: number }): number => {  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * rad) * 111320;
  const y = (b.lat - a.lat) * 111320;
  return Math.hypot(x, y);
};

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  aEle: number;
  bEle: number;
  edgeId: string;
  label: string;
}

/**
 * Nearest point on segment AB to P, all in local metres. Returns the distance plus the fraction
 * along the segment, so the caller can interpolate the elevation and the lon/lat back out.
 */
function projectOnSeg(
  px: number,
  py: number,
  s: Seg,
): { d: number; t: number } {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const len2 = dx * dx + dy * dy;
  // A degenerate segment is just its start point; clamping t to 0 avoids a divide by zero.
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - s.ax) * dx + (py - s.ay) * dy) / len2));
  return { d: Math.hypot(px - (s.ax + t * dx), py - (s.ay + t * dy)), t };
}

/**
 * Index every segment of every edge that lies wholly outside the basin, so a basin node can find
 * the nearest point on a run rather than the nearest node. Local metric coordinates are computed
 * once against a fixed origin, because doing trigonometry per candidate is what would make this
 * search too slow to run over the whole fleet.
 */
function buildSegIndex(
  graph: ResortGraph,
  inside: Set<string>,
  origin: { lon: number; lat: number },
): { cells: Map<string, Seg[]>; toXY: (p: { lon: number; lat: number }) => [number, number] } {
  const rad = Math.PI / 180;
  const kx = Math.cos(origin.lat * rad) * 111320;
  const toXY = (p: { lon: number; lat: number }): [number, number] => [
    (p.lon - origin.lon) * kx,
    (p.lat - origin.lat) * 111320,
  ];
  const cells = new Map<string, Seg[]>();
  const put = (s: Seg) => {
    // Register under every cell the segment's bounding box touches, so a long segment is still
    // found from a cell its endpoints do not occupy.
    const i0 = Math.floor(Math.min(s.ax, s.bx) / CELL_M);
    const i1 = Math.floor(Math.max(s.ax, s.bx) / CELL_M);
    const j0 = Math.floor(Math.min(s.ay, s.by) / CELL_M);
    const j1 = Math.floor(Math.max(s.ay, s.by) / CELL_M);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const k = `${i},${j}`;
        const list = cells.get(k);
        if (list) list.push(s);
        else cells.set(k, [s]);
      }
  };
  for (const e of graph.edges) {
    // A lift's geometry is a cable in the air. Its interior is not a place, so projecting onto it
    // invents a mid-span boarding point - which is exactly the mistake `coincidentNodes` is already
    // guarded against. Measured: without this, St. Anton's Fluehen basin was handed a target 10 m
    // away and 162 m UP, because the Ruefikopfbahn span passes directly overhead. Lift STATIONS are
    // still valid targets; they are nodes, and nodes are searched separately.
    if (e.kind === 'lift') continue;
    // An edge with an end inside the basin is not a rescue target: it is either how you fall in or
    // part of the basin itself, so projecting onto it proves nothing.
    if (inside.has(e.from) || inside.has(e.to)) continue;
    const g = e.geometry;
    if (!g || g.length < 2) continue;
    const label = e.pisteName ?? e.liftName ?? (e.srcWayId ? `w${e.srcWayId}` : e.kind);
    for (let i = 0; i + 1 < g.length; i++) {
      const [ax, ay] = toXY(g[i]);
      const [bx, by] = toXY(g[i + 1]);
      put({ ax, ay, bx, by, aEle: g[i].ele ?? 0, bEle: g[i + 1].ele ?? 0, edgeId: e.id, label });
    }
  }
  return { cells, toXY };
}

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

/**
 * The ids of the resort's main body — the largest strongly-connected component, i.e. the part of
 * the mountain you can roam freely. Exported because a caller that needs a *representative* node
 * (a smoke test's start point, say) must not pick one off an island: St. Anton's highest node is
 * "Hochkar (top)", which reaches exactly 2 of 1087 nodes, so starting there reports 0 routable
 * bottoms and looks like a total failure of a perfectly healthy graph.
 */
export function mainBodyNodeIds(graph: ResortGraph): Set<string> {
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
  return new Set(main);
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
        // Off-piste terrain does not count as stranded piste. A freeride line you can only ski
        // into is not a connectivity defect — that is what off-piste IS — and reporting it sent a
        // reviewer chasing two phantom basins at Tignes (Balme couloirs, Leisse) where nothing was
        // missing from OSM at all. Counting only real pistes makes the detector answer the question
        // it is actually asking: "is groomed, marked terrain cut off?"
        if (e.kind === 'piste' && !e.offPiste) pisteEdges++;
        if (e.pisteName) pistes.add(e.pisteName);
      }
    }
    const entries = graph.edges.filter((e) => !inside.has(e.from) && inside.has(e.to));

    // Both halves of this search had a blind spot; they are independent and were fixed separately.
    //
    // (a) WHICH BASIN NODE to escape from. The obvious answer — the basin node geometrically
    // nearest anything outside — is wrong, and was wrong on 6 of 16 fleet basins. A link only frees
    // the skiers who can REACH it, and on a one-way descent the nearest point is usually the TOP:
    // linking it frees the one person standing there and leaves everyone who has already skied down
    // still trapped (Bamby/Altin freed 1 of 4, Termignon 1 of 5, Leisse 1 of 3, Balmbrunnen 1 of 6).
    // So rank candidates by how much of the basin they actually free first, and only use distance to
    // break ties. The reported gap gets longer, which is honest: it is the real cost of fixing the
    // basin rather than the cost of a link that fixes nothing.
    //
    // (b) WHAT TO AIM AT outside it — see `BasinTarget`. Searching outside *nodes* only is a
    // structural blind spot, because a run carries a node where it meets or ends and nowhere else,
    // so the entire middle of every run was invisible. That understates nothing and overstates the
    // gap, which matters because the gap is the number a human accepts or rejects the basin on.
    const reachersOf = (() => {
      const rev = new Map<string, string[]>();
      for (const e of graph.edges) {
        if (!inside.has(e.from) || !inside.has(e.to)) continue;
        const list = rev.get(e.to);
        if (list) list.push(e.from);
        else rev.set(e.to, [e.from]);
      }
      return (target: string) => {
        const seen = new Set([target]);
        const q = [target];
        while (q.length) {
          for (const p of rev.get(q.pop()!) ?? []) {
            if (!seen.has(p)) {
              seen.add(p);
              q.push(p);
            }
          }
        }
        return seen.size;
      };
    })();

    const { cells, toXY } = buildSegIndex(graph, inside, nodes[0].point);
    const reach = Math.ceil(MAX_TARGET_M / CELL_M);
    /** Nearest point on any outside RUN, as opposed to the nearest outside node. */
    const nearestOnEdge = (p: { lon: number; lat: number }): { d: number; t: number; seg: Seg } | null => {
      const [px, py] = toXY(p);
      const ci = Math.floor(px / CELL_M);
      const cj = Math.floor(py / CELL_M);
      let best: { d: number; t: number; seg: Seg } | null = null;
      // Widen ring by ring and stop as soon as the best hit is closer than the ring itself could
      // improve on — the whole point of the cap is to avoid scanning every segment in the resort.
      for (let r = 0; r <= reach; r++) {
        if (best && best.d <= (r - 1) * CELL_M) break;
        for (let i = ci - r; i <= ci + r; i++)
          for (let j = cj - r; j <= cj + r; j++) {
            if (r > 0 && Math.abs(i - ci) !== r && Math.abs(j - cj) !== r) continue;
            for (const s of cells.get(`${i},${j}`) ?? []) {
              const pr = projectOnSeg(px, py, s);
              if (pr.d < (best?.d ?? Infinity)) best = { d: pr.d, t: pr.t, seg: s };
            }
          }
      }
      return best && best.d <= MAX_TARGET_M ? best : null;
    };

    let gapM = Infinity;
    let freed = -1;
    let exit: GraphNode | null = null;
    let outside: BasinTarget | null = null;
    const take = (f: number, d: number, n: GraphNode, t: BasinTarget) => {
      if (f > freed || (f === freed && d < gapM)) {
        freed = f;
        gapM = d;
        exit = n;
        outside = t;
      }
    };
    for (const n of nodes) {
      const f = reachersOf(n.id);
      if (f < freed) continue;
      for (const m of outsideNodes) {
        take(f, distM(n.point, m.point), n, {
          at: { lon: m.point.lon, lat: m.point.lat, ele: m.point.ele ?? 0 },
          nodeId: m.id,
          label: m.id,
        });
      }
      const on = nearestOnEdge(n.point);
      if (on) {
        // Interpolate the landing point back out of the segment so the reviewer gets a real
        // coordinate and an honest climb figure, not just a distance.
        const rad = Math.PI / 180;
        const kx = Math.cos(nodes[0].point.lat * rad) * 111320;
        const x = on.seg.ax + on.t * (on.seg.bx - on.seg.ax);
        const y = on.seg.ay + on.t * (on.seg.by - on.seg.ay);
        take(f, on.d, n, {
          at: {
            lon: nodes[0].point.lon + x / kx,
            lat: nodes[0].point.lat + y / 111320,
            ele: on.seg.aEle + on.t * (on.seg.bEle - on.seg.aEle),
          },
          edgeId: on.seg.edgeId,
          label: `${on.seg.label} (along ${on.seg.edgeId})`,
        });
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
      frees: freed,
      climbM: Math.round((outside as BasinTarget).at.ele - ((exit as GraphNode).point.ele ?? 0)),
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
