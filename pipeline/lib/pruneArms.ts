import type { GraphEdge, PisteColor, ResortGraph } from '../../src/types/domain';
import { PISTE_COLOR_ORDER } from '../../src/types/domain';
import type { GraphConstants } from '../../src/config/graphConstants';

/**
 * Drop synthesised polygon arms that carry no connectivity.
 *
 * Every rim point where a polygon meets other terrain becomes a portal with an arm running in to
 * the polygon's spine. Most are load-bearing — the arm is the only way in or out of the zone — but
 * where two portals sit a few metres apart on the same stretch of rim the second arm merely
 * duplicates the first, cluttering the map and inflating the graph while adding nothing a skier
 * can actually do.
 *
 * An arm is decoration when deleting it changes no skier's options: if the head of every deleted
 * edge is still reachable from its tail, any route that used the arm can be re-routed and no pair
 * of nodes loses reachability. Three riders on that, each of which was learned by measuring a
 * regression rather than by reading the code:
 *
 *  - **The replacement must be near.** Raw connectivity would happily swap a 30 m arm for a 3 km
 *    trip round the mountain: reachability preserved, route ruined.
 *  - **The replacement must be usable by the same skier.** Only `piste` edges carry a difficulty
 *    filter, and `unknown` ranks hardest of all, so a detour through an unrated piste is no detour
 *    for anybody — the router drops those edges entirely.
 *  - **The replacement must survive to the end.** The greedy sweep proves each arm redundant
 *    against the graph as it stands at that moment, which is not the graph we ship: a later cut
 *    can strand the very node an earlier detour ran through. That is the shared-gateway case, where
 *    two polygons each grow an arm to one portal, arm A re-routes through arm B, and then B is cut
 *    and the portal vanishes underneath A.
 *
 * **This pass must run last.** It is the only pass whose correctness depends on nothing moving
 * afterwards, and every earlier attempt to place it inside `buildGraph` was quietly invalidated by
 * `applyOverrides` re-issuing edges behind it. Alpe d'Huez is the canary: get the ordering wrong
 * and the Alpette-Rousses ski-out disappears, turning a 2-minute descent into a 68-minute,
 * five-lift detour that every connectivity check still reports as perfectly healthy.
 */
export function pruneRedundantArms(graph: ResortGraph, c: GraphConstants): ResortGraph {
  const edges = graph.edges;
  const groups = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    if (!e.armPortal) continue;
    const key = `${e.srcWayId ?? '-'}:${e.armPortal}`;
    const arr = groups.get(key);
    if (arr) arr.push(e);
    else groups.set(key, [e]);
  }
  const strip = (g: ResortGraph): ResortGraph => {
    for (const e of g.edges) {
      // `armPortal` is prune-pass bookkeeping and does not survive, but *being an arm* is a fact
      // the app needs: an arm is invented plumbing joining a rim portal to the spine, not terrain,
      // so the longest-run scorer must not pay distance credit for skiing one.
      if (e.armPortal) e.skeletonArm = true;
      delete e.armPortal;
    }
    return g;
  };
  if (!groups.size || process.env.NO_ARM_PRUNE) return strip(graph);

  if (process.env.ARM_PRUNE_NODES)
    for (const want of process.env.ARM_PRUNE_NODES.split(',')) {
      console.log(`  [nodediag] ${want}`);
      for (const e of edges)
        if (e.from === want || e.to === want)
          console.log(
            `      ${e.id} ${e.kind.padEnd(9)} ${e.from}->${e.to} ${Math.round(e.lengthM)}m armPortal=${e.armPortal ?? '<none>'} srcWay=${e.srcWayId ?? '-'}`,
          );
    }

  const live = new Map(edges.map((e) => [e.id, e] as const));
  const out = new Map<string, GraphEdge[]>();
  const inn = new Map<string, GraphEdge[]>();
  const deg = new Map<string, number>();
  for (const e of edges) {
    let arr = out.get(e.from);
    if (!arr) out.set(e.from, (arr = []));
    arr.push(e);
    let rev = inn.get(e.to);
    if (!rev) inn.set(e.to, (rev = []));
    rev.push(e);
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  /** How many of `del`'s edges touch `n` — i.e. how much degree `n` loses if the group goes. */
  const delDegree = (del: GraphEdge[], n: string): number => {
    let k = 0;
    for (const e of del) {
      if (e.from === n) k++;
      if (e.to === n) k++;
    }
    return k;
  };
  const rank = (col: PisteColor | undefined): number =>
    !col || col === 'unknown' ? PISTE_COLOR_ORDER.length : PISTE_COLOR_ORDER.indexOf(col);

  /**
   * The easiest difficulty at which a skier can be standing on `id` at all — the gentlest piste
   * touching it, in either direction. Connectors don't constrain anyone, so a node ringed only by
   * connectors stays unconstrained (rank 0) and keeps the strongest protection.
   *
   * This is what an arm's difficulty really is. Judging an arm by its own edges says a
   * connector-only arm is green and so may only be replaced by a green detour — but an arm buried
   * in a red bowl is reachable *only* by red piste, so that protects a skier who can never be
   * there, and every replacement gets rejected for being as hard as the way in. Ranking by access
   * keeps the case the rider was written for: an arm whose portal also touches a green piste is
   * genuinely green-reachable, so it stays protected.
   */
  const accessRank = new Map<string, number>();
  for (const e of edges) {
    if (e.kind !== 'piste') continue;
    const r = rank(e.color);
    for (const n of [e.from, e.to]) {
      const cur = accessRank.get(n);
      if (cur == null || r < cur) accessRank.set(n, r);
    }
  }
  const armRank = (del: GraphEdge[]): number => {
    const own = del.reduce((r, e) => (e.kind === 'piste' ? Math.max(r, rank(e.color)) : r), 0);
    // Either endpoint being easy-reachable is enough to constrain the arm, so take the min.
    let access = Infinity;
    for (const e of del) {
      for (const n of [e.from, e.to]) access = Math.min(access, accessRank.get(n) ?? 0);
    }
    return Math.max(own, Number.isFinite(access) ? access : 0);
  };

  /**
   * Shortest skiable distance `from` -> `to` over the live edges, ignoring `banned` and giving up
   * past `capM`. Lifts are excluded because a detour that boards a lift is not a detour, it is a
   * different trip with a queue attached. The cap is also what keeps this affordable: a
   * load-bearing arm has no alternative at all, and without a horizon that verdict would cost a
   * full-graph search per arm.
   */
  const detour = (from: string, to: string, banned: Set<string>, capM: number, maxRank: number): number | null => {
    if (from === to) return 0;
    const best = new Map<string, number>([[from, 0]]);
    const q: { id: string; d: number }[] = [{ id: from, d: 0 }];
    while (q.length) {
      let bi = 0;
      for (let i = 1; i < q.length; i++) if (q[i].d < q[bi].d) bi = i;
      const cur = q.splice(bi, 1)[0];
      if (cur.d > (best.get(cur.id) ?? Infinity)) continue;
      for (const e of out.get(cur.id) ?? []) {
        if (banned.has(e.id) || !live.has(e.id)) continue;
        if (e.kind === 'lift') continue;
        if (e.kind === 'piste' && rank(e.color) > maxRank) continue;
        const d = cur.d + e.lengthM;
        if (d > capM) continue;
        if (e.to === to) return d;
        if (d >= (best.get(e.to) ?? Infinity)) continue;
        best.set(e.to, d);
        q.push({ id: e.to, d });
      }
    }
    return null;
  };

  /**
   * Every way *through* a blob of plumbing, priced: for each ordered pair of real nodes on its
   * boundary, the shortest ski from one to the other whose intermediate steps all lie inside the
   * blob. These are the only journeys the blob can possibly serve — so they are exactly what has to
   * be replaceable before it can go. A dead end yields none.
   */
  const crossings = (
    blob: Set<string>,
    boundary: Map<string, number>,
    maxRank: number,
  ): Map<string, number> => {
    const found = new Map<string, number>();
    for (const from of boundary.keys()) {
      const best = new Map<string, number>([[from, 0]]);
      const q: { id: string; d: number }[] = [{ id: from, d: 0 }];
      while (q.length) {
        let bi = 0;
        for (let i = 1; i < q.length; i++) if (q[i].d < q[bi].d) bi = i;
        const cur = q.splice(bi, 1)[0];
        if (cur.d > (best.get(cur.id) ?? Infinity)) continue;
        for (const e of out.get(cur.id) ?? []) {
          if (!live.has(e.id)) continue;
          if (e.kind === 'lift') continue;
          if (e.kind === 'piste' && rank(e.color) > maxRank) continue;
          const d = cur.d + e.lengthM;
          if (d >= (best.get(e.to) ?? Infinity)) continue;
          if (!blob.has(e.to)) {
            // Landed back on real terrain: that is a crossing, and it goes no further. It only
            // counts if we actually went *through* the blob — a direct edge between two boundary
            // nodes is the spine doing its own job, and survives the cull anyway.
            if (e.to === from || !blob.has(cur.id)) continue;
            const key = `${from}>${e.to}`;
            if (d < (found.get(key) ?? Infinity)) found.set(key, d);
            continue;
          }
          best.set(e.to, d);
          q.push({ id: e.to, d });
        }
      }
    }
    return found;
  };

  interface Cut {
    del: GraphEdge[];
    maxRank: number;
  }
  const cuts: Cut[] = [];
  const NO_BAN: Set<string> = new Set();
  /**
   * How far out of their way the replacement may take a skier, per edge. Budgeting the *extra*
   * distance rather than an absolute radius is what keeps the cost bounded: an arm is only cut if
   * the way round is barely longer than the arm was, so a resort that loses a thousand arms still
   * loses only metres on any given route.
   */
  const capFor = (e: GraphEdge): number => e.lengthM + c.armPruneDetourM;

  /**
   * Every node a skier can be *put down on*: both ends of every lift. A skier's whole world is
   * "get off a lift, ski, get on a lift", so these are the roots of everything that matters.
   */
  const seeds: string[] = [];
  {
    const s = new Set<string>();
    for (const e of edges)
      if (e.kind === 'lift') {
        s.add(e.from);
        s.add(e.to);
      }
    seeds.push(...s);
  }

  /** Nodes reachable from the lift network, walking live edges forwards or backwards. */
  const reach = (back: boolean): Set<string> => {
    const seen = new Set(seeds);
    const stack = [...seeds];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of (back ? inn : out).get(cur) ?? []) {
        if (!live.has(e.id)) continue;
        const next = back ? e.from : e.to;
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return seen;
  };

  let canGetTo = reach(false); // places a skier can arrive at
  let canGetHome = reach(true); // places a skier can leave from

  /**
   * A node that exists only because arms touch it. It is not terrain — it is the invented portal
   * the arm was built to reach — so it has no claim to keep its own reachability. Real terrain does,
   * and that is what the harm test below actually protects.
   */
  /**
   * A node that nothing but app-invented links touch. It is not terrain — it is the portal an arm
   * was built to reach, plus the weld connectors that tied it to the spine — so it has no claim to
   * keep its own reachability. Real terrain does, and that is what the harm test protects.
   *
   * Both halves matter: `armPortal` catches the arms, `synthetic` catches the weld/snap connectors,
   * which carry no `srcWayId` and would otherwise masquerade as real geometry and protect the very
   * cul-de-sac they created.
   */
  const stations = new Set(graph.nodes.filter((n) => n.kind === 'lift_station').map((n) => n.id));
  const ele = new Map(graph.nodes.map((n) => [n.id, n.point.ele]));
  const armTouched = new Set<string>();
  const portals = new Set<string>();
  for (const e of edges)
    if (e.armPortal) {
      armTouched.add(e.from);
      armTouched.add(e.to);
      portals.add(e.armPortal);
    }
  /**
   * Is this link here only because of an arm? An arm edge obviously is. A synthetic connector counts
   * too — that is the weld tying a portal to the spine — but a synthetic link reaching out to real
   * terrain belongs to another pass (a dead-end snap, a rescue link, a lift-top ski-out), which is
   * load-bearing in its own right.
   */
  const invented = (e: GraphEdge): boolean => Boolean(e.armPortal) || Boolean(e.synthetic);
  const isPlumbing = (n: string): boolean => {
    if (stations.has(n)) return false; // a lift station is a real place, whatever links it
    let any = false;
    const welds: string[] = [];
    for (const e of [...(out.get(n) ?? []), ...(inn.get(n) ?? [])]) {
      if (!live.has(e.id)) continue;
      any = true;
      if (!invented(e)) return false;
      if (!e.armPortal) welds.push(e.from === n ? e.to : e.from);
    }
    if (!any || !armTouched.has(n)) return false;
    // This is the portal an arm was built to reach, or a weld between such portals. A node that only
    // *happens* to have an arm land on it is somebody else's, and not ours to delete.
    return portals.has(n) || welds.every((o) => portals.has(o));
  };

  /**
   * The real question: does removing this arm take anything away from a skier?
   *
   * The distance test cannot answer it, because it prices a journey nobody would make. A cul-de-sac
   * hanging off a single junction — every way in from that junction, every way out back to it — can
   * be arbitrarily "expensive to replace" and still be worth exactly nothing: you ski in and you
   * come back to where you started. What matters is only that every piece of *real* terrain keeps
   * both of its abilities: to be skied to, and to get back to a lift.
   */
  const tryCut = (del: GraphEdge[]): { to: Set<string>; home: Set<string> } | null => {
    for (const e of del) live.delete(e.id);
    const to2 = reach(false);
    const home2 = reach(true);
    const harmed = (set: Set<string>, now: Set<string>): boolean => {
      for (const n of set) {
        if (now.has(n)) continue;
        if ((deg.get(n) ?? 0) - delDegree(del, n) <= 0) continue; // vanishes with the arm
        if (isPlumbing(n)) continue; // invented plumbing, not terrain
        return true;
      }
      return false;
    };
    if (harmed(canGetTo, to2) || harmed(canGetHome, home2)) {
      for (const e of del) live.set(e.id, e);
      return null;
    }
    return { to: to2, home: home2 };
  };

  const undo = (del: GraphEdge[]): void => {
    for (const e of del) live.set(e.id, e);
  };

  const diagFor = process.env.ARM_PRUNE_DIAG;
  const keepBlob = new Set((process.env.ARM_PRUNE_KEEP ?? '').split(',').filter(Boolean));
  for (const [key, del] of groups) {
    if (!del.every((e) => live.has(e.id))) continue;
    const banned = new Set(del.map((e) => e.id));
    const after = new Map<string, number>();
    for (const e of del) {
      after.set(e.from, (after.get(e.from) ?? deg.get(e.from)!) - 1);
      after.set(e.to, (after.get(e.to) ?? deg.get(e.to)!) - 1);
    }
    // Who could ski this arm? Not its own colour — the difficulty of the terrain that reaches it.
    const maxRank = armRank(del);
    // Distance is only a *route-quality* guard, and it only makes sense for a journey a skier would
    // actually make. Once the arm is gone, a piece of plumbing that can no longer both be reached
    // and get home is a dead end: no journey can pass through it, so no detour price is worth
    // paying. Plumbing that is still a working through-route stays subject to the budget.
    const post = tryCut(del);
    const dead = (n: string): boolean =>
      post != null && isPlumbing(n) && !(post.to.has(n) && post.home.has(n));
    const redundant =
      post != null &&
      del.every(
        (e) =>
          after.get(e.from) === 0 ||
          after.get(e.to) === 0 ||
          dead(e.from) ||
          dead(e.to) ||
          detour(e.from, e.to, banned, capFor(e), maxRank) != null,
      );
    if (diagFor && key.includes(diagFor))
      console.log(`  [armdiag] ${key} rank=${maxRank} strands=${post == null} redundant=${redundant}`);
    if (!redundant) {
      if (post != null) undo(del);
      continue;
    }
    canGetTo = post.to;
    canGetHome = post.home;
    for (const e of del) {
      deg.set(e.from, deg.get(e.from)! - 1);
      deg.set(e.to, deg.get(e.to)! - 1);
    }
    cuts.push({ del, maxRank });
  }

  // The connectivity verdict composes — each cut leaves every surviving node's abilities intact, so
  // a sequence of them does too. The *distance* verdict does not: a later cut can remove the very
  // detour an earlier one relied on. So re-test the budget against the finished graph and put back
  // any cut that no longer holds. Restoring only ever adds edges, so it can never break the
  // connectivity invariant, and it settles in a couple of rounds.
  for (let round = 0; round < 8; round++) {
    let restored = 0;
    const to2 = reach(false);
    const home2 = reach(true);
    const deadNow = (n: string): boolean => isPlumbing(n) && !(to2.has(n) && home2.has(n));
    for (let i = cuts.length - 1; i >= 0; i--) {
      const k = cuts[i];
      const holds = k.del.every(
        (e) =>
          (deg.get(e.from) ?? 0) === 0 ||
          (deg.get(e.to) ?? 0) === 0 ||
          deadNow(e.from) ||
          deadNow(e.to) ||
          detour(e.from, e.to, NO_BAN, capFor(e), k.maxRank) != null,
      );
      if (holds) continue;
      for (const e of k.del) {
        live.set(e.id, e);
        deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
        deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
      }
      cuts.splice(i, 1);
      restored++;
    }
    if (restored === 0) break;
  }

  // Some plumbing is worthless no matter how it is priced. Take a maximal connected blob of invented
  // nodes and look at the real terrain around it: if every way in and every way out touches the same
  // single junction, then skiing into the blob can only ever bring you back where you started. No
  // journey between two different places can pass through it, so it cannot shorten anything, and no
  // detour price for replacing it is worth paying. That is why a distance budget can never clear one:
  // it keeps asking "how dear is the way round?" about a trip nobody would take.
  //
  // Cutting arms one group at a time can never see this either — the blob stays alive on its
  // remaining arms — so it has to be judged whole.
  interface BlobCut {
    del: GraphEdge[];
    /** Crossings priced per skier ability — a link only an expert uses still has to be replaceable. */
    thru: Map<number, Map<string, number>>;
  }
  const blobCuts: BlobCut[] = [];
  const blobHolds = (k: BlobCut): boolean => {
    for (const [r, thru] of k.thru)
      for (const [pair, d] of thru) {
        const [u, v] = pair.split('>');
        // Only ask about skiers who could actually be standing here. Demanding a green replacement
        // for a crossing that only red terrain leads to invents an obligation nobody can use, and
        // keeps plumbing alive for a skier who can never reach it.
        if ((accessRank.get(u) ?? 0) > r) continue;
        // A crossing that ends meaningfully *higher* than it began, on ground you can already ski
        // down the other way, is nothing but a backtrack — it walks you back up a descent you just
        // made, and no skier wants that preserved. The rise has to be real, though: a flat traverse
        // that gains half a metre is a legitimate link between two pistes, and waiving it on that
        // basis silently deletes ski-outs and costs the skier a whole extra lift.
        const rise = (ele.get(v) ?? 0) - (ele.get(u) ?? 0);
        if (rise > c.maxTraverseClimb && detour(v, u, NO_BAN, d + c.armPruneDetourM, r) != null) continue;
        if (detour(u, v, NO_BAN, d + c.armPruneDetourM, r) == null) return false;
      }
    return true;
  };

  const dropCulDeSacs = (): number => {
    const seen = new Set<string>();
    let dropped = 0;
    const cands: { blob: Set<string>; boundary: Map<string, number>; thru: Map<number, Map<string, number>> }[] = [];
    for (const start of new Set([...out.keys(), ...inn.keys()])) {
      if (seen.has(start) || !isPlumbing(start)) continue;
      const blob = new Set<string>();
      const outside = new Set<string>();
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const n = stack.pop()!;
        blob.add(n);
        for (const e of [...(out.get(n) ?? []), ...(inn.get(n) ?? [])]) {
          if (!live.has(e.id)) continue;
          const o = e.from === n ? e.to : e.from;
          if (!isPlumbing(o)) {
            outside.add(o);
            continue;
          }
          if (seen.has(o)) continue;
          seen.add(o);
          stack.push(o);
        }
      }
      const boundary = new Map<string, number>();
      for (const n of blob)
        for (const e of [...(out.get(n) ?? []), ...(inn.get(n) ?? [])]) {
          if (!live.has(e.id)) continue;
          const o = e.from === n ? e.to : e.from;
          if (!blob.has(o)) boundary.set(o, (boundary.get(o) ?? 0) + 1);
        }
      // What the blob is actually worth: for every way through it, from one piece of real terrain to
      // another, how far is the trip? Touching several junctions is not enough to earn its keep — a
      // portal hanging off three *consecutive* spine nodes takes you nowhere the spine does not
      // already take you, more cheaply. So price each crossing and keep the blob only if losing one
      // would really cost a skier something. A dead end has no crossings at all, so it always goes.
      const thru = new Map<number, Map<string, number>>();
      for (let r = 0; r <= 3; r++) {
        const at = crossings(blob, boundary, r);
        if (at.size) thru.set(r, at);
      }
      cands.push({ blob, boundary, thru });
    }

    // Second pass, and the reason for the split: a blob's crossings have to be enumerated against the
    // graph as it stood *before* any of this pass's cuts. Priced as we go, a later blob loses the
    // journeys that used to reach it through an earlier, now-deleted neighbour — so it looks unused,
    // goes too, and the pair of cuts together wrecks a route neither would have hurt alone.
    // Worst-case pricing. Three portals into the same bowl each look free on their own, because each
    // one's way round runs through the other two — cut all three and the bowl is only reachable the
    // long way. Evaluating one blob at a time can never see that, and neither can re-pricing
    // afterwards, since by then the alternative it trusted is gone. So take every candidate out
    // first, and let a blob go only if it is still worthless with all its rivals already removed.
    const all: GraphEdge[] = [];
    for (const { blob } of cands)
      for (const n of blob)
        for (const e of [...(out.get(n) ?? []), ...(inn.get(n) ?? [])])
          if (live.has(e.id) && !all.includes(e)) all.push(e);
    for (const e of all) live.delete(e.id);
    const worthless = cands.filter((k) => blobHolds({ del: [], thru: k.thru }));
    for (const e of all) live.set(e.id, e);

    for (const { blob, boundary, thru } of worthless) {
      // Never cull a blob that is somebody's only link. A lift top whose sole ski-out runs through
      // invented plumbing still needs it, however pointless the blob looks in isolation.
      let strands = false;
      for (const [o, lost] of boundary) if ((deg.get(o) ?? 0) - lost <= 0) strands = true;
      if (strands) continue;
      if (keepBlob.size && [...blob].some((n) => keepBlob.has(n))) continue;
      const del: GraphEdge[] = [];
      for (const n of blob)
        for (const e of [...(out.get(n) ?? []), ...(inn.get(n) ?? [])])
          if (live.has(e.id) && !del.includes(e)) del.push(e);
      if (!del.length) continue;
      const post = tryCut(del);
      if (!post) continue;
      const k: BlobCut = { del, thru };
      if (!blobHolds(k)) {
        undo(del);
        continue;
      }
      blobCuts.push(k);
      if (diagFor)
        console.log(
          `  [blobdiag] cull {${[...blob].join(',')}} boundary={${[...boundary.keys()].join(',')}} crossings=${[...thru.values()].reduce((a, m) => a + m.size, 0)}`,
        );
      canGetTo = post.to;
      canGetHome = post.home;
      for (const e of del) {
        deg.set(e.from, (deg.get(e.from) ?? 1) - 1);
        deg.set(e.to, (deg.get(e.to) ?? 1) - 1);
        dropped++;
      }
    }
    return dropped;
  };
  if (!process.env.NO_BLOB_CULL) {
    for (;;) if (!dropCulDeSacs()) break;
  }

  // Same composition trap as the arm cuts: each blob was priced against the graph as it stood at the
  // time, and a later cull can remove the very way round an earlier one was counting on. So re-price
  // every cull against the finished graph and put back the ones that no longer hold.
  for (let round = 0; round < 8; round++) {
    let restored = 0;
    for (let i = blobCuts.length - 1; i >= 0; i--) {
      const k = blobCuts[i];
      if (blobHolds(k)) continue;
      for (const e of k.del) {
        live.set(e.id, e);
        deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
        deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
      }
      blobCuts.splice(i, 1);
      restored++;
    }
    if (!restored) break;
  }

  // A cut may leave plumbing that is not a cul-de-sac but is no longer usable either — it can be
  // skied to but not skied out of, or the reverse. It can appear on no journey, so it is not terrain
  // we owe anything to; leaving it would ship a node that is permanently "trapped".
  for (let round = 0; round < 8; round++) {
    const to2 = reach(false);
    const home2 = reach(true);
    const del: GraphEdge[] = [];
    for (const n of new Set([...out.keys(), ...inn.keys()])) {
      if ((to2.has(n) && home2.has(n)) || !isPlumbing(n)) continue;
      for (const e of [...(out.get(n) ?? []), ...(inn.get(n) ?? [])])
        if (live.has(e.id) && !del.includes(e)) del.push(e);
    }
    if (!del.length) break;
    const post = tryCut(del);
    if (!post) break;
    canGetTo = post.to;
    canGetHome = post.home;
    for (const e of del) {
      deg.set(e.from, (deg.get(e.from) ?? 1) - 1);
      deg.set(e.to, (deg.get(e.to) ?? 1) - 1);
    }
  }

  const keptEdges = edges.filter((e) => live.has(e.id));
  const touched = new Set<string>();
  for (const e of keptEdges) {
    touched.add(e.from);
    touched.add(e.to);
  }
  // Nodes the prune stranded are not terrain, they are the invented portal the arm existed to
  // reach. Leaving them behind would make them permanently both "trapped" and "orphan".
  const keptNodes = graph.nodes.filter((n) => touched.has(n.id) || n.kind === 'lift_station');
  const droppedNodes = graph.nodes.length - keptNodes.length;
  console.log(
    `  pruned ${cuts.length}/${groups.size} redundant polygon arm(s) ` +
      `(${edges.length - keptEdges.length} edges, ${droppedNodes} node(s))`,
  );
  return strip({
    ...graph,
    nodes: keptNodes,
    edges: keptEdges,
    points: graph.points.filter((p) => touched.has(p.nodeId)),
  });
}
