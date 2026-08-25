/**
 * Tunable constants for the graph-build pipeline (node identity, connectors, flats).
 * These are validated per resort against the graph-validate debug report and can be
 * overridden per resort in the pipeline if a resort needs different tolerances.
 */
export interface GraphConstants {
  /** Max horizontal distance (m) to merge two endpoints into the same node. */
  Hmerge: number;
  /** Max vertical distance (m) to merge two endpoints into the same node. */
  Vmerge: number;
  /** Max horizontal distance (m) to consider inferring a connector between distinct nodes. */
  Hconnect: number;
  /** Elevation band (m) within which a segment/gap is considered "flat". */
  Vflat: number;
  /** Minimum |gradient| (rise/run) for an inferred downhill connector to be skiable. */
  minGrade: number;
  /** Maximum |gradient| (rise/run); steeper is treated as a cliff / not skiable. */
  maxGrade: number;
  /** Max vertical rise (m) tolerated on a piste segment before it's dropped as "uphill". */
  pisteFlatTolerance: number;
  /**
   * Minimum rise/run to call a local elevation extremum a DEM sampling spike rather than real
   * terrain. 1.2 is ~50°, steeper than any groomed piste (a black run is ~0.7), so genuine summits
   * and basins survive while a cell standing impossibly proud of nearby ground is repaired.
   */
  spikeGradeMax: number;
  /** Max horizontal distance (m) to bridge a dead-end ("stuck") node to a descent continuation. */
  bridgeRadius: number;
  /** Max horizontal distance (m) for a bidirectional flat bridge across a stuck node. */
  flatBridgeMax: number;
  /** Max distance (m) to snap a dead-end piste endpoint onto another piste's line (T-junction). */
  snapToLineRadius: number;
  /** Rescue pass: max distance (m) to force-connect a trapped node to a reachable one. */
  rescueRadius: number;
  /** Rescue pass: max distance (m) to project a trapped node onto a reachable piste *line*. */
  rescueLineRadius: number;
  /** Max gradient (rise/run) for a piste segment to also be traversable in reverse (cat-track). */
  flatGradeMax: number;
  /** Max absolute rise (m) allowed on any flat traverse (reverse cat-track / rescue) — you can skate a small rise, not climb. */
  maxTraverseClimb: number;
  /** Flat-junction pass: max horizontal distance (m) to bridge a dangling piste end across a flat. */
  flatJunctionRadius: number;
  /** Flat-junction pass: max elevation difference (m) to treat as the same flat area (DEM-noise tolerant). */
  flatJunctionDV: number;
  /** Flat-junction pass: max partners to link per dangling end (keeps it sparse). */
  flatJunctionK: number;
  /**
   * Arm-prune pass: how much *extra* distance (m) a skier may be sent, per edge, to replace a
   * deleted polygon arm. Budgeting the detour against the arm's own length rather than as an
   * absolute radius is what bounds the cost: an arm is only cut when the way round is barely
   * longer than the arm was, so a resort can lose a thousand arms and still lose only metres on
   * any given route.
   */
  armPruneDetourM: number;
  /** Lift-top ski-out pass: max distance (m) to snap a no-ski-out lift top onto a nearby piste line. */
  liftSkiOutRadius: number;
  /**
   * Plateau pass: max horizontal distance (m) over which two hub nodes count as "the same
   * place". Over such a short link the DEM gradient is noise, not terrain — a summit station
   * apron reads as a 25% slope simply because two cells differ by a few metres.
   */
  plateauRadius: number;
  /** Plateau pass: max bidirectional traverses to add per node (keeps the graph sparse). */
  plateauK: number;
  /**
   * Plateau pass: how far (m) a skier may already travel along mapped runs to get between the two
   * points before the link is judged unnecessary. Only genuinely severed pairs are bridged.
   */
  plateauReachBudget: number;
}

export const DEFAULT_GRAPH_CONSTANTS: GraphConstants = {
  Hmerge: 12,
  Vmerge: 4,
  Hconnect: 60,
  Vflat: 3,
  minGrade: 0.03,
  maxGrade: 0.8,
  pisteFlatTolerance: 3,
  spikeGradeMax: 1.2,
  snapToLineRadius: 45,
  bridgeRadius: 150,
  flatBridgeMax: 120,
  rescueRadius: 200,
  rescueLineRadius: 130,
  flatGradeMax: 0.06,
  maxTraverseClimb: 8,
  flatJunctionRadius: 120,
  flatJunctionDV: 8,
  flatJunctionK: 2,
  armPruneDetourM: 25,
  liftSkiOutRadius: 130,
  plateauRadius: 45,
  plateauK: 3,
  plateauReachBudget: 400,
};


