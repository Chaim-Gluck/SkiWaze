import type { GraphEdge } from '../types/domain';
import type { GraphIndex } from './graphIndex';
import { DEFAULT_GRAPH_CONSTANTS } from '../config/graphConstants';

/**
 * Per-edge scorer shared by the resort-wide "longest runs" card and the Aâ†’B "longest" objective,
 * so the two can't drift apart. Raw skied length is the wrong objective for both: it rewards any
 * detour that racks up metres, which is what produces visible doubling-back.
 *
 * Two things are corrected:
 *  - **Winding**: reward the STRAIGHT-LINE progress an edge makes, with only a small credit for
 *    the extra length, and charge 8× for any metre climbed inside the edge (a way that skis into
 *    a dip and back out).
 *  - **Gradient**: an edge only counts as skiing in proportion to how steeply it descends, ramping
 *    from 0 to full credit at `flatGradeMax`. Without this, a near-level access road still scores
 *    its full length — e.g. Val Thorens' 361 m "Accès UCPA" loop drops 4 m (1.1%) and would beat
 *    the direct 386 m Cairn piste, and the drop=0 connector mesh at a lift base is free metres to
 *    zig-zag through.
 *
 * Penalised edges stay usable for connectivity — they just don't inflate the score.
 */
function makeDescentScorer(index: GraphIndex): (e: GraphEdge) => number {
  const mBetween = (a: { lon: number; lat: number }, b: { lon: number; lat: number }) =>
    Math.hypot((a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180) * 111320, (a.lat - b.lat) * 110540);
  const straightOf = new Map<string, number>();
  const uphillOf = new Map<string, number>();

  // Elevations come off a coarse DEM, not a survey: across our resorts 75-85% of consecutive
  // vertices carry an *identical* value, and isolated samples land tens of metres off. One
  // Madonna vertex reads 1894 m sitting between neighbours at 1943 m and 1920 m — a 49 m
  // plunge and 26 m recovery inside 100 m of piste. Summing raw per-vertex rises therefore
  // measures sampling noise, and the 8x charge below amplifies it: that single bad sample
  // invents 26 m of "climbing" and costs the leg ~208 points, enough to flip its score
  // negative and drop a real piste out of the run.
  //
  // A median-of-3 is not enough: the Madonna artifact is *two* consecutive vertices at 1894 m,
  // and a median filter only deletes a lone outlier. What identifies a bad sample generally is
  // that it sits well below the straight line joining good samples either side of it, over a
  // span too short to be terrain. So we fill any such dip with that chord.
  //
  // Only dips are filled, never bumps. A dip is what manufactures phantom climbing (the DEM
  // plunges and the recovery reads as ascent), whereas a bump that reads as a climb may well be
  // a real one — so leaving bumps alone keeps the penalty honest in the direction that matters.
  // This smooths the *scoring* signal only: edge dropM, and so the descent shown in the UI, is
  // untouched.
  const SPIKE_DEV = 5; // metres below the chord before a sample is treated as bad
  const SPIKE_SPAN = 150; // metres — beyond this a dip is terrain, not a sampling artifact
  const cleanedEle = (g: GraphEdge['geometry']): number[] => {
    const ele = g.map((p) => p.ele ?? 0);
    const at: number[] = [0];
    for (let i = 1; i < g.length; i++) at.push(at[i - 1] + mBetween(g[i - 1], g[i]));
    for (let a = 0; a < ele.length - 2; a++) {
      let fill = -1;
      for (let b = a + 2; b < ele.length && at[b] - at[a] <= SPIKE_SPAN; b++) {
        const span = at[b] - at[a];
        if (span <= 0) continue;
        let allBelow = true;
        for (let i = a + 1; i < b; i++) {
          const chord = ele[a] + ((ele[b] - ele[a]) * (at[i] - at[a])) / span;
          if (ele[i] > chord - SPIKE_DEV) {
            allBelow = false;
            break;
          }
        }
        if (allBelow) fill = b; // keep extending: prefer the widest dip that still qualifies
      }
      if (fill < 0) continue;
      const span = at[fill] - at[a];
      for (let i = a + 1; i < fill; i++) ele[i] = ele[a] + ((ele[fill] - ele[a]) * (at[i] - at[a])) / span;
      a = fill - 1;
    }
    return ele;
  };

  for (const e of index.edgeById.values()) {
    const g = e.geometry;
    straightOf.set(e.id, g.length >= 2 ? mBetween(g[0], g[g.length - 1]) : e.lengthM);
    const ele = cleanedEle(g);
    let up = 0;
    for (let i = 1; i < ele.length; i++) {
      const d = ele[i] - ele[i - 1];
      if (d > 0) up += d;
    }
    uphillOf.set(e.id, up);
  }

  // Gradient at which an edge counts as skiing outright.
  //
  // This used to be `flatGradeMax` (6%), but that constant answers a different question: it is the
  // pipeline's *bidirectionality* threshold — "is this cat-track flat enough that a skier could
  // also traverse it uphill". Borrowing it here charged the flat penalty to real descending piste:
  // Madonna's lower Pozza vecia, a 533 m red dropping 11 m (2.1%), scored w=0.34 and so
  // 0.34*504 - 0.66*0.75*533 = -102, i.e. *negative*. The run therefore abandoned half a kilometre
  // of genuine piste for a 160 m stub that happened to be steeper.
  //
  // 2% is roughly where a groomed slope stops carrying you: below it you are poling, above it you
  // glide. That keeps the penalty aimed at what it was built for — level junction meshes and
  // traverses used as padding — while a piste that actually descends always scores its length.
  const SKI_GRADE_FULL = 0.02;
  return (e: GraphEdge): number => {
    const straight = straightOf.get(e.id) ?? e.lengthM;
    const wind = Math.max(0, e.lengthM - straight); // extra length beyond a straight line
    // How much this edge counts as skiing: 0 when level or climbing, full at SKI_GRADE_FULL.
    const grade = e.lengthM > 0 ? -e.dropM / e.lengthM : 0;
    const w = Math.min(1, Math.max(0, grade / SKI_GRADE_FULL));
    // Blends the two old branches: w=1 reproduces `straight + 0.25*wind`, w=0 the flat penalty.
    let s = w * (straight + 0.25 * wind) - (1 - w) * 0.75 * e.lengthM;
    s -= 8 * (uphillOf.get(e.id) ?? 0);
    // A pipeline-inferred bridge costs exactly its own length, so it can never pay for itself
    // (no bridge padding) — but a run that must cross one to reach real terrain is still viable.
    // The user's own custom links are exempt: those are deliberately drawn, i.e. real terrain.
    if (e.synthetic && !e.custom) s -= e.lengthM;
    // Same deal for a synthesised polygon arm. An arm is invented plumbing joining a rim portal to
    // the polygon's spine, not a run anyone chooses to ski, but it is emitted as ordinary piste and
    // typically descends steeply enough to earn full credit. That let the search weave
    // spine -> arm -> neighbouring arm -> spine, banking ~70-100 m of invented distance a lap
    // (Val Thorens' Combe de Thorens polygon, whose 68 arms total 2.4 km). Charging an arm its own
    // length keeps it usable for reaching real terrain while making it worthless as padding.
    if (e.skeletonArm) s -= e.lengthM;
    // And for a polygon line that only retraces the centreline its own polygon already adopted.
    // Two copies of one run, cross-linked by arms, form a ladder the search climbs sideways to bank
    // the same terrain twice. Charging the copy its own length leaves the real named run underneath
    // it as the only way to earn those metres.
    if (e.spineDuplicate) s -= e.lengthM;
    return s;
  };
}

/**
 * Cost of turning from one leg onto the next, in "wasted metres".
 *
 * Doubling-back is a property of a *pair* of edges, not of either one alone: skiing 1.5 km
 * north-west and then 800 m back south-east is two perfectly straight, perfectly descending
 * legs, so no per-edge scorer can ever see the hairpin. Only a DP that knows which edge you
 * arrived on can price it — hence the edge-based DP below.
 *
 * Bearings are measured *locally at the junction* (the last/first `LOOK` metres) rather than
 * end-to-end, because a long winding piste's overall bearing says nothing about the direction
 * you actually leave or enter it.
 *
 * The charge ramps in from 0 at a 90° turn to its full value at a full reversal, and is scaled
 * by the *shorter* of the two legs — that is the ground you can actually retrace. Using the
 * shorter leg also keeps the dense short-connector mesh at lift bases cheap to thread through
 * (the flat-smoothing post-pass is what cleans those up).
 */
/**
 * Direction each edge actually *leaves* and *arrives at* a junction, measured over the last/first
 * `LOOK` metres of its polyline.
 *
 * End-to-end bearings are useless for this. Madonna's 856 m Rododendro leg runs south-east overall
 * but arrives at its junction heading north-west; judged end-to-end, carrying straight on up the
 * next Rododendro segment scores as a 119° "reversal" that never happens on the snow. Every
 * turn-shaped decision below therefore reads its angles from here.
 */
function makeLocalBearings(index: GraphIndex): {
  entry: Map<string, number>;
  exit: Map<string, number>;
  turn: (prev: GraphEdge, next: GraphEdge) => number;
} {
  const LOOK = 60; // metres of each leg used to measure its direction at the junction
  const mBetween = (a: { lon: number; lat: number }, b: { lon: number; lat: number }) =>
    Math.hypot((a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180) * 111320, (a.lat - b.lat) * 110540);
  const bear = (a: { lon: number; lat: number }, b: { lon: number; lat: number }) =>
    Math.atan2(b.lon - a.lon, b.lat - a.lat);
  const entry = new Map<string, number>();
  const exit = new Map<string, number>();
  for (const e of index.edgeById.values()) {
    const g = e.geometry;
    if (g.length < 2) continue;
    let d = 0;
    let i = 1;
    while (i < g.length - 1 && d < LOOK) d += mBetween(g[i - 1], g[i++]);
    entry.set(e.id, bear(g[0], g[i]));
    let d2 = 0;
    let j = g.length - 2;
    while (j > 0 && d2 < LOOK) {
      d2 += mBetween(g[j], g[j + 1]);
      j--;
    }
    exit.set(e.id, bear(g[j], g[g.length - 1]));
  }
  // Angle swept turning from `prev` onto `next`, in radians (0 = straight on, π = doubling back).
  const turn = (prev: GraphEdge, next: GraphEdge): number => {
    const a = exit.get(prev.id);
    const b = entry.get(next.id);
    if (a === undefined || b === undefined) return 0;
    const d = Math.abs(a - b);
    return Math.min(d, 2 * Math.PI - d);
  };
  return { entry, exit, turn };
}

function makeTurnPenalty(
  turn: (prev: GraphEdge, next: GraphEdge) => number,
): (prev: GraphEdge, next: GraphEdge) => number {
  return (prev: GraphEdge, next: GraphEdge): number => {
    if (samePiste(prev, next)) return 0;
    const back = -Math.cos(turn(prev, next)); // -1 straight on, 0 at a right angle, +1 doubling back
    if (back <= 0) return 0;
    return TURN_PENALTY_WEIGHT * back * Math.min(prev.lengthM, next.lengthM);
  };
}

/**
 * Whether two legs are the same named piste continuing through a junction.
 *
 * The turn penalty exists to stop the search touring a junction instead of crossing it, or
 * detouring down a ski-in/ski-out spur and back to bank a few metres. Both are *departures*: the
 * run leaves the way it was going, picks up unrelated ground, and returns. Staying on one piste is
 * the opposite, and it cannot pad — a run's own bends are already part of its length however you
 * ski them, so waiving the charge here can never invent distance.
 *
 * It mattered because bearings are sampled over 60 m windows, which reads a genuine switchback as
 * a reversal: Madonna's Graffer turns 117 degrees at one node partway down and was charged 801 for
 * it (the charge scales with the leg you arrive on, so a long approach is punished hardest). That
 * was enough to send the resort's longest run down the 903 m Lame instead of the 1576 m Graffer to
 * the very same junction. Two pistes really doubling back on each other still pay, and
 * `returnsNearVisited` still rejects a chain that retraces ground it has already skied.
 */
function samePiste(a: GraphEdge, b: GraphEdge): boolean {
  if (a.kind !== 'piste' || b.kind !== 'piste') return false;
  if (a.pisteRef && b.pisteRef) return a.pisteRef === b.pisteRef;
  if (a.pisteName && b.pisteName) return a.pisteName === b.pisteName;
  return false;
}

/**
 * How many metres of "you just skied that ground twice" a full reversal costs, per metre of the
 * shorter leg. A hairpin is worse than the ground it wastes — it also stops the result being a
 * *run* — so the charge is a multiple, not 1:1.
 *
 * 3 is the highest value that doesn't start deleting real runs. Measured over all shipped resorts,
 * going 0 → 3 cuts total retraced ground in the top-3 runs from 5.6 km to 1.1 km while every
 * signature descent survives (Mont-de-Lans, Sarenne, Grenzpiste, Ötztal). At 4 the Les 2 Alpes
 * Mont-de-Lans marathon collapses from 16.3 km to 11.0 km, and by 10 Mount Hermon's top run goes
 * too. What survives at 3 is only hairpins the graph *forces* (the junction has no other exit).
 */
const TURN_PENALTY_WEIGHT = 3;

/**
 * How much score (≈ metres of straight-line descent) the reconstruction may give up to take a
 * cleaner-looking line instead of the DP's choice. Small on purpose: the DP is the authority on
 * how long a run is, and the guard below only exists for shapes it cannot see.
 */
const DETOUR_MARGIN = 150;

/**
 * How much an edge may rise before the longest-descent search refuses to use it.
 *
 * A "longest run" that climbs is not a run. The search is a longest-*path* DP, so any edge it is
 * allowed to use is distance it can bank — and a traverse that gains height is the cheapest
 * distance on the mountain, because it costs only its own length. Madonna's A→B longest option
 * skied 345 m down piste 71 for no reason other than to climb a 126 m / +5 m cat-track back onto
 * piste 73 higher up, buying itself 561 m. Pricing the climb is not enough (there is always some
 * price at which the padding still pays); the search simply must not go up.
 *
 * The tolerance is `pisteFlatTolerance` because that is already the elevation change this project
 * treats as indistinguishable from flat: below it, a DEM sample — not the terrain — decides the
 * sign, and genuine level crossings between runs must stay usable.
 */
const MAX_RUN_CLIMB_M = DEFAULT_GRAPH_CONSTANTS.pisteFlatTolerance;

/**
 * How much a run may climb when the alternative is stopping dead.
 *
 * The no-climb rule above is aimed at *padding*: skiing down one piste purely to step back up
 * onto another and bank its length for free. That manoeuvre always requires a choice — the run
 * had a perfectly good descent available and declined it. So the rule can be relaxed exactly
 * where no choice exists: at a node whose every remaining option climbs, a step-up is not a
 * shortcut, it is the only way the run continues at all.
 *
 * Madonna's lower Pozza vecia ends at a node linked to piste 78 by a 49 m connector that rises
 * 4 m; beyond it lie ~1.6 km of Skiweg Fortini and Grotte. Nothing else leaves that node, so the
 * run either takes the step or throws away a quarter of its length.
 *
 * The ceiling is `maxTraverseClimb`, the pipeline's own limit on how much height it will let a
 * skier gain across a traverse — the same question, so the same answer. The scorer still charges
 * for the climb (a rising edge scores no skiing credit, pays 8x its ascent and, when synthetic,
 * its own length again), so an escape that does not open up real terrain will not pay for itself.
 */
const MAX_ESCAPE_CLIMB_M = DEFAULT_GRAPH_CONSTANTS.maxTraverseClimb;

/**
 * Usable continuations from one node: everything that does not climb, or — when that leaves
 * nothing at all — the shallow climbs that let the run escape a dead end.
 */
function usableFrom(edges: GraphEdge[], keep: (e: GraphEdge) => boolean): GraphEdge[] {
  const allowed = edges.filter(keep);
  const level = allowed.filter((e) => e.dropM <= MAX_RUN_CLIMB_M);
  if (level.length) return level;
  return allowed.filter((e) => e.dropM <= MAX_ESCAPE_CLIMB_M);
}

/**
 * Extra per-edge admissibility, beyond "not a lift and within the colour rank".
 *
 * The longest-descent family used to gate on `maxColorRank` alone, which quietly made it the one
 * search in the app that ignored the rest of the skier's preferences: it happily returned routes
 * over `offPiste` freeride terrain with `allowOffPiste` false, over closed runs, and over synthetic
 * bridges the user had asked to avoid. `buildRoute` then charged **0 s** for every such edge
 * (`edgeCost` returns `allowed:false, seconds:0`), so a Paradiski option showed 375 m of black
 * off-piste as a 0-minute route — and, being quicker than the genuine "Fastest" card, it is what
 * first exposed this. Callers pass the same gate the rest of the planner uses.
 */
export type EdgeAllow = (e: GraphEdge) => boolean;

const ALLOW_ALL: EdgeAllow = () => true;

/**
 * Extract up to `k` diverse longest lift-free runs. Candidate starts are ranked by a cheap
 * whole-graph DP, then each is re-solved from its own root and de-duplicated by overlap, so the
 * carousel shows genuinely different runs. Selection is by descent score (which is what keeps a
 * run a real descent rather than padded metres); the results are then presented longest-first,
 * because distance is the number the card shows.
 */
export function longestDownhillRuns(
  index: GraphIndex,
  maxColorRank = Infinity,
  k = 3,
  allow: EdgeAllow = ALLOW_ALL,
): GraphEdge[][] {
  const eleOf = new Map<string, number>();
  for (const [id, n] of index.nodes) eleOf.set(id, n.point.ele ?? 0);

  const colorRank = (e: GraphEdge): number => {
    if (e.kind !== 'piste') return 0; // connectors carry no colour restriction
    switch (e.color) {
      case 'green': return 0;
      case 'blue': return 1;
      case 'red': return 2;
      case 'black': return 3;
      default: return 4;
    }
  };

  // Candidate adjacency: every non-lift edge within the user's colour rank that does not climb
  // (plus a shallow climb where that is the only way on — see MAX_ESCAPE_CLIMB_M).
  const adj = new Map<string, GraphEdge[]>();
  for (const [from, edges] of index.out) {
    const kept = usableFrom(edges, (e) => e.kind !== 'lift' && colorRank(e) <= maxColorRank && allow(e));
    if (kept.length) adj.set(from, kept);
  }

  // Iterative DFS from `roots`. state: 0 unvisited, 1 on-stack (grey), 2 done (black).
  // Edges to grey nodes are back-edges (would form a cycle) and are dropped; all other
  // edges are kept, yielding a DAG. Post-order (finish order) is reverse-topological.
  //
  // The non-lift sub-graph is only *almost* acyclic: flat traverses and capped cat-tracks are
  // bidirectional, so every flat mesh is a knot of 2-cycles. Which way DFS orients them depends
  // on where it entered, and a run can only ever cross a flat in the direction the DAG chose.
  // That makes the DAG start-dependent, which is why we rebuild it per candidate start below.
  const buildDag = (roots: string[]) => {
    const state = new Map<string, number>();
    const dagOut = new Map<string, GraphEdge[]>();
    const finished: string[] = [];
    for (const root of roots) {
      if (state.get(root)) continue;
      const stack: { id: string; i: number }[] = [{ id: root, i: 0 }];
      state.set(root, 1);
      while (stack.length) {
        const top = stack[stack.length - 1];
        const edges = adj.get(top.id) ?? [];
        if (top.i < edges.length) {
          const e = edges[top.i++];
          const s = state.get(e.to) ?? 0;
          if (s === 1) continue; // back-edge -> drop to keep acyclic
          let out = dagOut.get(top.id);
          if (!out) dagOut.set(top.id, (out = []));
          out.push(e);
          if (s === 0) {
            state.set(e.to, 1);
            stack.push({ id: e.to, i: 0 });
          }
        } else {
          state.set(top.id, 2);
          finished.push(top.id);
          stack.pop();
        }
      }
    }
    return { dagOut, finished };
  };

  // Longest-path DP over a DAG, keyed by *edge* rather than node. Finish order is reverse-
  // topological, so a node's DAG targets are already resolved when we process it. Scoring (see
  // makeDescentScorer) rewards real descent rather than raw distance, so the winner is a natural
  // continuous run instead of a distance-maximising zig-zag that weaves through lift-base
  // junctions to rack up metres.
  //
  // The state is the edge you are *on*, not the node you are at, so the DP knows which direction
  // you arrived from and can charge makeTurnPenalty for a hairpin. A node-keyed DP structurally
  // cannot: it would compare continuations without knowing what they turn away from, and so
  // happily ski 1.5 km out and 0.8 km back because both legs descend.
  const scoreOf = makeDescentScorer(index);
  const localTurn = makeLocalBearings(index).turn;
  const turnPenalty = makeTurnPenalty(localTurn);
  const runDp = (dag: { dagOut: Map<string, GraphEdge[]>; finished: string[] }) => {
    const dpEdge = new Map<string, number>(); // best score of a descent *beginning with* this edge
    const nextOf = new Map<string, GraphEdge>();
    const dp = new Map<string, number>(); // best score of a descent starting at this node
    const choice = new Map<string, GraphEdge>();
    for (const id of dag.finished) {
      let bestNode = 0;
      let bestFirst: GraphEdge | undefined;
      for (const e of dag.dagOut.get(id) ?? []) {
        let bestTail = 0; // 0 = stop here, always allowed
        let bestNext: GraphEdge | undefined;
        for (const f of dag.dagOut.get(e.to) ?? []) {
          const v = (dpEdge.get(f.id) ?? 0) - turnPenalty(e, f);
          if (v > bestTail) {
            bestTail = v;
            bestNext = f;
          }
        }
        const val = scoreOf(e) + bestTail;
        dpEdge.set(e.id, val);
        if (bestNext) nextOf.set(e.id, bestNext);
        if (val > bestNode) {
          bestNode = val;
          bestFirst = e;
        }
      }
      dp.set(id, bestNode);
      if (bestFirst) choice.set(id, bestFirst);
    }
    return { ...dag, dpEdge, nextOf, dp, choice };
  };

  // Global pass: one DAG seeded from every node, highest first so it follows gravity. Its DP
  // values are only used to *rank* candidate starts cheaply — each candidate is then re-solved
  // from its own root, where the flats are oriented for that descent.
  const globalRoots = [...index.nodes.keys()].sort(
    (a, b) => eleOf.get(b)! - eleOf.get(a)! || (a < b ? -1 : a > b ? 1 : 0),
  );
  const global = runDp(buildDag(globalRoots));

  const posOf = (id: string) => index.node(id)?.point;
  const reverses = (prev: GraphEdge | undefined, e: GraphEdge): boolean =>
    prev ? !samePiste(prev, e) && localTurn(prev, e) > 1.9 : false; // > ~109°: turns back on the previous leg
  const reconstruct = (
    start: string,
    solved: {
      dagOut: Map<string, GraphEdge[]>;
      dpEdge: Map<string, number>;
      nextOf: Map<string, GraphEdge>;
      choice: Map<string, GraphEdge>;
    },
  ): GraphEdge[] => {
    const { dagOut, dpEdge, nextOf, choice } = solved;
    const chain: GraphEdge[] = [];
    const guard = new Set<string>();
    const visitedPos: { lon: number; lat: number }[] = [];
    const RET = 22; // metres — a continuation whose target lands this close to an
    const startPos = posOf(start);
    if (startPos) visitedPos.push(startPos);
    // earlier-visited node (older than the last 2) is treated as doubling back.
    const returnsNearVisited = (id: string): boolean => {
      const p = posOf(id);
      if (!p) return false;
      for (let i = 0; i < visitedPos.length - 2; i++) {
        const q = visitedPos[i];
        const dx = (p.lon - q.lon) * Math.cos((p.lat * Math.PI) / 180) * 111320;
        const dy = (p.lat - q.lat) * 110540;
        if (Math.hypot(dx, dy) < RET) return true;
      }
      return false;
    };
    let cur: string | undefined = start;
    let prevEdge: GraphEdge | undefined;
    let opt = choice.get(start);
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      if (!opt) break;
      // Value of taking `e` from here, including what it costs to turn onto it.
      const valOf = (e: GraphEdge) =>
        (dpEdge.get(e.id) ?? 0) - (prevEdge ? turnPenalty(prevEdge, e) : 0);
      const optVal = valOf(opt);
      // The DP already prices hairpins, so this is now only a guard against the two things it
      // still cannot see: a step that returns near a node visited *earlier in this chain*
      // (needs path history) and a residual sharp reversal.
      const doublesBack = (e: GraphEdge): boolean => returnsNearVisited(e.to) || reverses(prevEdge, e);
      let next = opt;
      if (doublesBack(opt)) {
        let bestClean: GraphEdge | undefined;
        let bestCleanVal = -Infinity;
        for (const e of dagOut.get(cur) ?? []) {
          if (doublesBack(e)) continue;
          const val = valOf(e);
          if (val > bestCleanVal) {
            bestCleanVal = val;
            bestClean = e;
          }
        }
        // Only swap when the cleaner line gives up little, measured as an absolute margin.
        // A *ratio* of the two values is meaningless here: both continuations usually rejoin
        // and share a long tail, whose score swamps the difference. At Madonna the tail is
        // worth 2070 and the branches 945 vs 1268 — a real 660 m of extra skiing — yet
        // 3015/3338 reads as 90%, so a 15%-tolerance ratio test happily threw the longer
        // branch away. Score units are metres of straight-line descent, so a metre budget is
        // both the right unit and the readable one.
        if (bestClean && optVal - bestCleanVal <= DETOUR_MARGIN) next = bestClean;
      }
      chain.push(next);
      prevEdge = next;
      cur = next.to;
      opt = nextOf.get(next.id);
      const np = posOf(cur);
      if (np) visitedPos.push(np);
    }
    return chain;
  };

  // Flat-smoothing post-pass. OSM maps flat junction areas (lift bases, mid-mountain
  // plateaus) as a dense mesh of near-zero-slope traverse edges. The DAG/DP threads through
  // that mesh to reach the continuing descent and often overshoots then doubles back (a
  // "flat-junction hook"): every leg sits at the same elevation, so it is padding, not
  // skiing. For each maximal run of flat legs (no real descent) we substitute the shortest
  // flat crossing between the run's entry and exit nodes. This strips zig-zags/spurs without
  // touching any descent leg (so vertical drop and the real ski distance are preserved) and
  // can never disconnect the chain (entry and exit are unchanged, the crossing stays inside
  // the same flat sub-mesh). Non-custom synthetic bridges are excluded so smoothing never
  // introduces a dotted-magenta warning edge the original run didn't already use.
  const isFlatLeg = (e: GraphEdge) =>
    e.kind !== 'lift' && e.dropM > -2 && colorRank(e) <= maxColorRank && allow(e) && !(e.synthetic && !e.custom);
  const shortestFlat = (entry: string, exit: string): GraphEdge[] | null => {
    if (entry === exit) return [];
    const dist = new Map<string, number>([[entry, 0]]);
    const prevE = new Map<string, GraphEdge>();
    const pq: { d: number; id: string }[] = [{ d: 0, id: entry }];
    while (pq.length) {
      let bi = 0;
      for (let i = 1; i < pq.length; i++) if (pq[i].d < pq[bi].d) bi = i;
      const { d, id: u } = pq.splice(bi, 1)[0];
      if (u === exit) break;
      if (d > (dist.get(u) ?? Infinity)) continue;
      for (const e of index.outEdges(u)) {
        if (!isFlatLeg(e)) continue;
        const nd = d + e.lengthM;
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          prevE.set(e.to, e);
          pq.push({ d: nd, id: e.to });
        }
      }
    }
    if (!dist.has(exit)) return null;
    const path: GraphEdge[] = [];
    let c = exit;
    while (c !== entry) {
      const e = prevE.get(c);
      if (!e) return null;
      path.unshift(e);
      c = e.from;
    }
    return path;
  };
  const smoothFlats = (chain: GraphEdge[]): GraphEdge[] => {
    const out: GraphEdge[] = [];
    let i = 0;
    while (i < chain.length) {
      if (!isFlatLeg(chain[i])) {
        out.push(chain[i]);
        i++;
        continue;
      }
      let j = i;
      while (j < chain.length && isFlatLeg(chain[j])) j++;
      const orig = chain.slice(i, j);
      const origLen = orig.reduce((s, e) => s + e.lengthM, 0);
      const shortcut = shortestFlat(chain[i].from, chain[j - 1].to);
      if (shortcut && shortcut.reduce((s, e) => s + e.lengthM, 0) < origLen - 1) {
        out.push(...shortcut);
      } else {
        out.push(...orig);
      }
      i = j;
    }
    return out;
  };

  // A descent cannot begin with a climb. Candidate starts must be *tops* (below), but where a
  // resort's real summit is only reachable across a flat plateau mesh, the qualifying top can sit
  // *below* the piste head it feeds. Madonna's longest began at 2145 m, dipped west to 2121 m and
  // then climbed 33 m onto the 2154 m head of Delle Rocce — 525 m of the advertised 6.64 km were
  // approach, not skiing, and the card named a "top" 9 m below the point the run actually starts
  // from. Everything before the chain's high point is exactly that approach, so it is cut.
  const trimToHighPoint = (chain: GraphEdge[]): GraphEdge[] => {
    let bestAt = 0;
    let bestEle = -Infinity;
    for (let i = 0; i < chain.length; i++) {
      const ele = eleOf.get(chain[i].from) ?? 0;
      if (ele > bestEle) {
        bestEle = ele;
        bestAt = i;
      }
    }
    return bestAt ? chain.slice(bestAt) : chain;
  };

  // Candidate starts must be *tops*: nodes you cannot ski into. Otherwise the winner is often a
  // mid-slope node with a piste feeding into it, and the card reports a run that starts somewhere
  // you could only have reached by skiing (e.g. Val Thorens' "Médaille (top)", which has 31 m of
  // Niverolles dropping into it from above). Every real run begins at a top, so this loses nothing
  // and spends the budget on distinct runs instead of suffixes of each other.
  const skiableInto = new Set<string>();
  for (const edges of adj.values())
    for (const e of edges) if (e.dropM < -2) skiableInto.add(e.to);

  // Ranked by the cheap global DP. The global DAG under-reports some starts (its flats may be
  // oriented the wrong way for them), so we take a generous shortlist and re-solve each from its
  // own root — that is what lets a start reach the descent the global orientation had blocked.
  // 200 is well past the point where results stop changing on any resort we ship, while keeping
  // the worst case well under a second.
  const CANDIDATE_STARTS = 200;
  const starts = [...global.dp.entries()]
    .filter(([id, d]) => d > 0 && !skiableInto.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, CANDIDATE_STARTS)
    .map(([id]) => id);

  const candidates: { chain: GraphEdge[]; score: number }[] = [];
  for (const s of starts) {
    const solved = runDp(buildDag([s]));
    const chain = trimToHighPoint(smoothFlats(reconstruct(s, solved)));
    if (chain.length === 0) continue;
    candidates.push({ chain, score: chain.reduce((t, e) => t + scoreOf(e), 0) });
  }
  // Rank by distance — that is what the card promises and what the user reads. Score is used as a
  // quality *gate* rather than the ranking, because the two are anti-correlated: score discounts
  // flat sections and app-added bridges, so a longer valley-crossing run always scores below a
  // shorter steep one (in Val Thorens the 10.8 km run scores 6626 against 6887 for a 9.9 km one).
  // `quality` is score per metre — about 1 for a straight steep descent, collapsing towards 0 for a
  // chain padded with flats, bridges or doubling-back. 0.4 drops the padded variants (it removes a
  // 17.1 km Les 2 Alpes chain that climbs 616 m internally) while keeping every genuine marathon
  // descent we know by name: Sarenne, Mont-de-Lans, Klein Matterhorn→Zermatt, Ötztal. Falling back
  // to the ungated pool means a resort whose runs are all flat-ish still gets an answer.
  const QUALITY_FLOOR = 0.4;
  const lengthOf = (c: GraphEdge[]) => c.reduce((t, e) => t + e.lengthM, 0);
  const viable = candidates.filter((c) => c.score / Math.max(1, lengthOf(c.chain)) >= QUALITY_FLOOR);
  const pool = viable.length ? viable : candidates;
  pool.sort((a, b) => lengthOf(b.chain) - lengthOf(a.chain));

  const runs: GraphEdge[][] = [];
  const usedEdges = new Set<string>();
  for (const { chain } of pool) {
    if (runs.length >= k) break;
    let overlap = 0;
    for (const e of chain) if (usedEdges.has(e.id)) overlap++;
    // Reject near-duplicates (mostly sub-chains of an already-chosen run).
    if (runs.length > 0 && overlap / chain.length > 0.6) continue;
    runs.push(chain);
    for (const e of chain) usedEdges.add(e.id);
  }
  return runs;
}

/**
 * Find the single longest uninterrupted (lift-free) run in the graph — the longest chain of
 * pistes, skiable connectors AND flat/near-flat traverses (cat-tracks), matching how a
 * route's "longest streak" stat is counted (any non-lift leg continues the run).
 *
 * The non-lift sub-graph is almost a DAG (gravity-oriented pistes) but flat_traverse and
 * capped cat-track edges are bidirectional, so a naive elevation ordering drops legs that
 * a real route would ski (a run can cross a flat or coast over a small rise). We instead
 * build a DAG by running DFS from the highest nodes downward and dropping only genuine
 * back-edges; that orients flats/small climbs in the descent direction and never cuts a
 * run short at a cat-track. Longest path is then a simple DP over the DAG.
 *
 * Returns the ordered edge chain of the run (empty if none).
 */
export function longestDownhillStreak(index: GraphIndex, maxColorRank = Infinity, allow: EdgeAllow = ALLOW_ALL): GraphEdge[] {
  return longestDownhillRuns(index, maxColorRank, 1, allow)[0] ?? [];
}

/**
 * Longest lift-free descent from `fromId` to `toId`.
 *
 * "Longest" means the most real skiing, not the most metres: edges are scored by
 * `makeDescentScorer`, the same way the resort-wide longest-runs card scores them. Maximising raw
 * length instead sends the route down near-level access roads and through the drop=0 connector
 * mesh at lift bases purely to accumulate distance, which shows up on the map as absurd loops.
 *
 * The lift-free downhill sub-graph is a DAG (edges only descend), so this is exact and O(V+E):
 * DFS from A dropping back-edges â†’ a DAG whose post-order is reverse-topological; then a
 * longest-distance DP toward B. Returns [] when B isn't reachable from A without a lift (the
 * caller falls back to allowing a lift only in that case).
 */
export function longestDownhillPath(
  index: GraphIndex,
  fromId: string,
  toId: string,
  maxColorRank = Infinity,
  penalties?: Map<string, number>,
  allow: EdgeAllow = ALLOW_ALL,
): GraphEdge[] {
  // Prefer a run that never climbs. Only if B is unreachable that way do we allow a rise, so a
  // legitimately awkward pairing still returns something rather than nothing.
  const strict = descentPath(index, fromId, toId, maxColorRank, penalties, false, allow);
  if (strict.length) return strict;
  return descentPath(index, fromId, toId, maxColorRank, penalties, true, allow);
}

function descentPath(
  index: GraphIndex,
  fromId: string,
  toId: string,
  maxColorRank: number,
  penalties: Map<string, number> | undefined,
  allowClimb: boolean,
  allow: EdgeAllow = ALLOW_ALL,
): GraphEdge[] {
  if (fromId === toId) return [];

  const colorRank = (e: GraphEdge): number => {
    if (e.kind !== 'piste') return 0;
    switch (e.color) {
      case 'green': return 0;
      case 'blue': return 1;
      case 'red': return 2;
      case 'black': return 3;
      default: return 4;
    }
  };

  // Candidate adjacency: non-lift edges within the user's colour rank that do not climb
  // (plus a shallow climb where that is the only way on — see MAX_ESCAPE_CLIMB_M).
  const adj = new Map<string, GraphEdge[]>();
  for (const [from, edges] of index.out) {
    const keep = (e: GraphEdge) => e.kind !== 'lift' && colorRank(e) <= maxColorRank && allow(e);
    const kept = allowClimb ? edges.filter(keep) : usableFrom(edges, keep);
    if (kept.length) adj.set(from, kept);
  }

  // DAG rooted at A (only nodes reachable downhill from A matter); drop back-edges (cycles).
  const state = new Map<string, number>(); // 0 unseen, 1 on-stack, 2 done
  const dagOut = new Map<string, GraphEdge[]>();
  const finished: string[] = []; // reverse-topological (descendants first)
  const stack: { id: string; i: number }[] = [{ id: fromId, i: 0 }];
  state.set(fromId, 1);
  while (stack.length) {
    const top = stack[stack.length - 1];
    const edges = adj.get(top.id) ?? [];
    if (top.i < edges.length) {
      const e = edges[top.i++];
      const s = state.get(e.to) ?? 0;
      if (s === 1) continue; // back-edge â†’ drop to stay acyclic
      let out = dagOut.get(top.id);
      if (!out) dagOut.set(top.id, (out = []));
      out.push(e);
      if (s === 0) {
        state.set(e.to, 1);
        stack.push({ id: e.to, i: 0 });
      }
    } else {
      state.set(top.id, 2);
      finished.push(top.id);
      stack.pop();
    }
  }

  if (!state.has(toId)) return []; // B not reachable lift-free from A

  // Longest-descent DP toward B. Processing in `finished` order resolves successors first.
  const scoreOf = makeDescentScorer(index);
  const bestTo = new Map<string, number>([[toId, 0]]);
  const choice = new Map<string, GraphEdge>();
  for (const u of finished) {
    if (u === toId) continue;
    let best = -Infinity;
    let bestE: GraphEdge | undefined;
    for (const e of dagOut.get(u) ?? []) {
      const t = bestTo.get(e.to);
      if (t === undefined) continue; // e.to can't reach B
      // Effective score lets callers de-prioritise already-used edges (diversity), while the
      // returned chain always carries the real edges. A penalty < 1 must always make an edge
      // less attractive, so it shrinks a positive score but deepens a negative one.
      const p = penalties?.get(e.id) ?? 1;
      const s = scoreOf(e);
      const cand = (s >= 0 ? s * p : s / p) + t;
      if (cand > best) {
        best = cand;
        bestE = e;
      }
    }
    if (bestE) {
      bestTo.set(u, best);
      choice.set(u, bestE);
    }
  }
  if (!choice.has(fromId)) return [];

  const chain: GraphEdge[] = [];
  const guard = new Set<string>();
  let cur = fromId;
  while (cur !== toId) {
    if (guard.has(cur)) break;
    guard.add(cur);
    const e = choice.get(cur);
    if (!e) break;
    chain.push(e);
    cur = e.to;
  }
  return cur === toId ? chain : [];
}

/**
 * Straighten plumbing doglegs the diversity penalty introduces.
 *
 * This is the descent-search twin of `smoothDetours` in alternatives.ts, and it exists for the
 * same reason: penalising an accepted run's edges pushes the next search off terrain that may have
 * been the sensible line, and the search then buys its way around it.
 *
 * What makes it acute here is that the penalty only ever touches edges a previous run *used*.
 * Polygon arms and spine duplicates are scored at ~0 by `makeDescentScorer`, so no run picks them
 * and they are never penalised — while the real line beside them is marked down by 0.55 each time.
 * After two runs the real spine is at 0.30 of its score and the untouched plumbing finally wins,
 * which is how Val Thorens' Deux Lacs descent ended up weaving spine → arm → arm → spine over its
 * last 130 m (n1485: arm totalled 198.8 against the spine's 187.0, purely from the penalty).
 *
 * So for each maximal run of consecutive plumbing edges we re-solve just that stretch with an
 * *unpenalised* search and splice the result in when it scores better. Restricting the windows to
 * plumbing keeps this to a couple of extra searches per run, and every edge descends, so a spliced
 * sub-path can never collide with the rest of the chain.
 */
function smoothPlumbing(index: GraphIndex, chain: GraphEdge[], maxColorRank: number, allow: EdgeAllow = ALLOW_ALL): GraphEdge[] {
  const isPlumbing = (e: GraphEdge) => !!(e.skeletonArm || e.spineDuplicate);
  if (!chain.some(isPlumbing)) return chain;

  const scoreOf = makeDescentScorer(index);
  const total = (es: GraphEdge[]) => es.reduce((s, e) => s + scoreOf(e), 0);

  const out = [...chain];
  // Right-to-left so a splice never shifts an index we have not visited yet.
  let end = out.length;
  while (end > 0) {
    if (!isPlumbing(out[end - 1])) {
      end--;
      continue;
    }
    let start = end - 1;
    while (start > 0 && isPlumbing(out[start - 1])) start--;

    const seg = out.slice(start, end);
    const alt = descentPath(index, seg[0].from, seg[seg.length - 1].to, maxColorRank, undefined, false, allow);
    if (alt.length && total(alt) > total(seg) + 1e-6) out.splice(start, seg.length, ...alt);

    end = start;
  }
  return out;
}

/**
 * Up to `k` diverse longest lift-free Aâ†’B descents. After each found run, its edges are
 * penalised so the next longest search is pushed onto different terrain; runs overlapping an
 * accepted one by more than `maxOverlap` (by distance) are rejected. Returns [] if B isn't
 * reachable from A without a lift.
 */
export function longestDownhillPaths(
  index: GraphIndex,
  fromId: string,
  toId: string,
  maxColorRank = Infinity,
  k = 3,
  maxOverlap = 0.7,
  allow: EdgeAllow = ALLOW_ALL,
): GraphEdge[][] {
  const accepted: GraphEdge[][] = [];
  const penalties = new Map<string, number>();
  const maxAttempts = k * 4;

  for (let attempt = 0; attempt < maxAttempts && accepted.length < k; attempt++) {
    const found = longestDownhillPath(index, fromId, toId, maxColorRank, penalties, allow);
    if (found.length === 0) break;

    // Keep the straightened run, but penalise what the search actually walked — penalties exist to
    // push the *next* search onto new terrain, and the dogleg is terrain it should not retry.
    const chain = smoothPlumbing(index, found, maxColorRank, allow);

    const isDup = accepted.some(
      (r) => r.length === chain.length && r.every((e, i) => e.id === chain[i].id),
    );
    const candLen = chain.reduce((s, e) => s + e.lengthM, 0) || 1;
    const candIds = new Set(chain.map((e) => e.id));
    let overlap = 0;
    for (const r of accepted) {
      let shared = 0;
      for (const e of r) if (candIds.has(e.id)) shared += e.lengthM;
      overlap = Math.max(overlap, shared / candLen);
    }
    if (!isDup && (accepted.length === 0 || overlap <= maxOverlap)) accepted.push(chain);
    // Shrink this run's edges so the next search diverges — but only partly, so a variant that
    // shares a common top trunk then splits off (e.g. a different bottom via another piste) can
    // still reuse the trunk and surface instead of being forced onto unrelated terrain.
    for (const e of found) penalties.set(e.id, (penalties.get(e.id) ?? 1) * 0.55);
  }
  return accepted;
}
