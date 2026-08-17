// Core domain model for SkiWaze. Shared by the offline data pipeline (Node)
// and the web app (browser). Keep this framework-free so both can import it.

/** A geographic point with elevation in meters above sea level. */
export interface GeoPoint {
  lon: number;
  lat: number;
  /** Elevation in meters. May be null before elevation enrichment runs. */
  ele: number | null;
}

/** Piste difficulty, using the European color convention. */
export type PisteColor = 'green' | 'blue' | 'red' | 'black' | 'unknown';

/** Ordered easiest -> hardest, used for "max difficulty" comparisons. */
export const PISTE_COLOR_ORDER: PisteColor[] = ['green', 'blue', 'red', 'black'];

/** Lift categories derived from OSM aerialway tags. */
export type LiftType =
  | 'gondola'
  | 'cable_car'
  | 'funicular'
  | 'chair_lift'
  | 't_bar'
  | 'drag_lift'
  | 'platter'
  | 'rope_tow'
  | 'magic_carpet'
  | 'mixed_lift'
  | 'unknown';

/**
 * Lift types that can carry a skier downhill (downloading), not just up.
 * Everything else is treated as up-only unless a per-lift `canDownload` override says otherwise.
 */
export const DOWNLOADABLE_LIFT_TYPES: ReadonlySet<LiftType> = new Set<LiftType>([
  'gondola',
  'cable_car',
  'funicular',
  'mixed_lift',
]);

/** Kind of graph edge. */
export type EdgeKind = 'piste' | 'lift' | 'connector';

/** Sub-classification for inferred connector edges. */
export type ConnectorKind = 'skiable_down' | 'flat_traverse';

/** Role a node plays, used for building the meaningful-points picker list. */
export type NodeKind = 'lift_station' | 'piste_endpoint' | 'junction' | 'poi';

export interface GraphNode {
  id: string;
  point: GeoPoint;
  kind: NodeKind;
  /** Human-readable label when available (e.g. lift station name, hut name). */
  name?: string;
}

/**
 * A directed edge. Direction is meaningful: a piste is emitted only in the
 * descending direction; a downloadable lift is emitted as two edges (up and down).
 */
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  /** Polyline geometry from `from` to `to`, inclusive of endpoints. */
  geometry: GeoPoint[];
  /** 3D length in meters. */
  lengthM: number;
  /** Signed vertical delta (to.ele - from.ele) in meters; negative = descending. */
  dropM: number;

  // Piste-only
  color?: PisteColor;
  pisteName?: string;
  /** Piste number/reference (e.g. "56"), shown before the name in directions. */
  pisteRef?: string;
  /** True when derived from an OSM area=yes polygon: kept for routing, hidden from the map render. */
  area?: boolean;

  // Lift-only
  liftType?: LiftType;
  liftName?: string;
  /** True if this lift edge carries skiers downhill (download). */
  isDownload?: boolean;
  /** Raw OSM opening_hours string when present. */
  openingHours?: string;

  // Connector-only
  connectorKind?: ConnectorKind;
  /** Gradient as rise/run (negative descending) for connectors. */
  gradient?: number;

  /** True for pipeline-inferred bridges / rescue links / user custom links (not real OSM geometry). */
  synthetic?: boolean;
  /** True specifically for user-added custom links (a subset of synthetic). */
  custom?: boolean;
}

export interface ResortBBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface Resort {
  id: string;
  name: string;
  country: string;
  /** Map default center. */
  center: { lon: number; lat: number };
  bbox: ResortBBox;
  defaultZoom: number;
  /** IANA timezone for interpreting lift opening hours. */
  timezone: string;
}

/** Type of a selectable A/B endpoint shown to the user. */
export type PointType =
  | 'lift_top'
  | 'lift_bottom'
  | 'piste_top'
  | 'piste_bottom'
  | 'poi';

/** A "meaningful point" the user can pick as start/end (plus current-location/pin at runtime). */
export interface MeaningfulPoint {
  id: string;
  name: string;
  type: PointType;
  nodeId: string;
  point: GeoPoint;
}

/** Non-fatal issues detected while building a resort's graph. */
export interface DataWarning {
  code:
    | 'missing_opening_hours'
    | 'missing_elevation'
    | 'unreachable_component'
    | 'suspicious_merge'
    | 'inferred_connector'
    | 'no_wait_time';
  message: string;
  /** Optional related node/edge ids. */
  refs?: string[];
}

/** The full routable graph for one resort, emitted by the pipeline as graph.json. */
export interface ResortGraph {
  resortId: string;
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  points: MeaningfulPoint[];
  warnings: DataWarning[];
}

// ---------------------------------------------------------------------------
// Preferences & routing
// ---------------------------------------------------------------------------

export interface SpeedConfig {
  /**
   * PER-COLOUR PROGRESS-SPEED OVERRIDE (m/s), applied only when the user opts into their measured
   * speeds. Empty by default — the base speed is derived from the model (see config/speedModel.ts)
   * from colour + skill, so it can never get "stuck" stale in localStorage.
   */
  skiSpeedByColor: Partial<Record<Exclude<PisteColor, 'unknown'>, number>>;
  /** Average ride speed (m/s) per lift type. */
  liftSpeedByType: Partial<Record<LiftType, number>>;
  /** Average wait time (seconds) per lift type. */
  liftWaitByType: Partial<Record<LiftType, number>>;
  /** Fallback ski speed when a piste color is unknown. */
  fallbackSkiSpeed: number;
  /** Fallback lift ride speed. */
  fallbackLiftSpeed: number;
  /** Fallback lift wait time. */
  fallbackLiftWait: number;
  /** Traverse/skate speed for flat connectors. */
  flatTraverseSpeed: number;
}

export interface Preferences {
  /** Hardest color the skier will take. */
  maxDifficulty: PisteColor;
  /** Colors the skier prefers (non-preferred are penalized, not banned). */
  preferredColors: PisteColor[];
  /** Lift types the skier is willing to use. */
  allowedLiftTypes: LiftType[];
  /** When true, exclude app-added (synthetic) bridges from routing (user custom links still allowed). */
  avoidSyntheticBridges: boolean;
  /** When true, strongly prefer skiing over riding lifts (especially downhill lifts). */
  preferSkiing: boolean;
  /** Which "Find route" mode to use: balanced (one per objective) or a single objective ×3. */
  routeType: RouteType;
  /** When true, use the user's measured GPS speeds (as per-colour overrides) instead of the model. */
  useMeasuredSpeeds?: boolean;
  /** How fast the skier goes; scales all skiing (not lift) speeds. */
  skillLevel: SkillLevel;
  speeds: SpeedConfig;
}

/** Self-rated skiing pace. Scales base ski speeds via SKILL_SPEED_MULTIPLIER. */
export type SkillLevel = 'cautious' | 'average' | 'advanced' | 'expert';

export type RouteObjective = 'fastest' | 'fewest_lifts' | 'preferred' | 'longest_ab';

/**
 * What the "Find route" flow returns. `balanced` (default) shows one best route per objective
 * (deduped); the others each show up to 3 distinct routes optimised for that single objective.
 */
export type RouteType = 'balanced' | 'fastest' | 'fewest_lifts' | 'preferred' | 'longest';

export type TimingMode = 'now' | 'arrive_by';

export interface TripTiming {
  mode: TimingMode;
  /** ISO time; required when mode === 'arrive_by' (target arrival) — otherwise "now". */
  time?: string;
}

export interface RouteRequest {
  resortId: string;
  fromNodeId: string;
  toNodeId: string;
  timing: TripTiming;
  prefs: Preferences;
  /** Closure keys (lift:<name> / piste:<ref|name> / edge:<id>) to exclude from routing. */
  closedKeys?: string[];
}

export interface RouteLeg {
  edgeId: string;
  kind: EdgeKind;
  fromNodeId: string;
  toNodeId: string;
  description: string;
  distanceM: number;
  durationS: number;
  color?: PisteColor;
  liftType?: LiftType;
  isDownload?: boolean;
  synthetic?: boolean;
  custom?: boolean;
  warnings: RouteWarning[];
}

export interface RouteWarning {
  code:
    | 'lift_closing_soon'
    | 'lift_closed'
    | 'using_default_speed'
    | 'using_default_wait'
    | 'missing_opening_hours'
    | 'above_preferred_color'
    | 'questionable_edge'
    | 'custom_edge';
  message: string;
}

export interface RouteStats {
  totalDistanceM: number;
  totalDurationS: number;
  descentM: number;
  ascentM: number;
  liftCount: number;
  liftTypes: LiftType[];
  /** Distance skied per color. */
  colorBreakdownM: Partial<Record<PisteColor, number>>;
  /** Longest uninterrupted (lift-free) downhill distance within the route. */
  longestDownhillStreakM: number;
  /** ISO departure time when computed. */
  startTime?: string;
  /** ISO arrival time when computed. */
  arriveTime?: string;
}

/**
 * A consolidated, human-readable route step covering one or more consecutive legs
 * (same run/lift; tiny connectors absorbed). Display-only — routing uses `legs`.
 */
export interface DisplayStep {
  kind: EdgeKind;
  label: string;
  distanceM: number;
  durationS: number;
  color?: PisteColor;
  /** Slope number (OSM ref) when the piste has one; many resorts don't number pistes. */
  ref?: string;
  isDownload?: boolean;
  synthetic: boolean;
  custom: boolean;
  /** Inclusive leg-index range this step covers (for map highlight). */
  fromLeg: number;
  toLeg: number;
  /** Key to mark this run/lift closed, or null when not directly closable. */
  closureKey: string | null;
  closureLabel: string | null;
}

export interface Route {
  id: string;
  objective: RouteObjective;
  /** Objective badges to show on the card (e.g. ["Fastest", "Fewest lifts"] when deduped). */
  labels?: string[];
  legs: RouteLeg[];
  /** Grouped, readable steps derived from `legs` (presentation only). */
  steps: DisplayStep[];
  stats: RouteStats;
  warnings: RouteWarning[];
}
