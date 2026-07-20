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
  /** Max horizontal distance (m) to bridge a dead-end ("stuck") node to a descent continuation. */
  bridgeRadius: number;
  /** Max horizontal distance (m) for a bidirectional flat bridge across a stuck node. */
  flatBridgeMax: number;
  /** Max distance (m) to snap a dead-end piste endpoint onto another piste's line (T-junction). */
  snapToLineRadius: number;
  /** Rescue pass: max distance (m) to force-connect a trapped node to a reachable one. */
  rescueRadius: number;
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
}

export const DEFAULT_GRAPH_CONSTANTS: GraphConstants = {
  Hmerge: 12,
  Vmerge: 4,
  Hconnect: 60,
  Vflat: 3,
  minGrade: 0.03,
  maxGrade: 0.8,
  pisteFlatTolerance: 3,
  snapToLineRadius: 45,
  bridgeRadius: 150,
  flatBridgeMax: 120,
  rescueRadius: 200,
  flatGradeMax: 0.06,
  maxTraverseClimb: 8,
  flatJunctionRadius: 120,
  flatJunctionDV: 8,
  flatJunctionK: 2,
};
