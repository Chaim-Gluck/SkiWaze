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
  /**
   * A resort escalator or moving walkway (OSM `conveying=*` on a footway/steps). Deliberately NOT
   * part of ALL_LIFT_TYPES and not offered in the preferences UI: it is a piece of resort plumbing
   * that gets you between two parts of the mountain, not a ski lift anyone chooses to avoid.
   * Because it is absent from `allowedLiftTypes`, `cost.ts` exempts it from that gate — otherwise
   * every returning user's persisted array would lack it and silently strand the sector behind it.
   */
  | 'people_mover'
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

/**
 * Lift types that are *physically* capable of carrying a skier downhill, whether or not they do
 * by default. A chair can be ridden down when the operator allows it; you can never ride a drag
 * lift down. Used to decide whether an OSM `oneway=no` tag is believable.
 */
export const AERIAL_LIFT_TYPES: ReadonlySet<LiftType> = new Set<LiftType>([
  'gondola',
  'cable_car',
  'funicular',
  'mixed_lift',
  'chair_lift',
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
  /**
   * OSM way id this edge was cut from. Set for piste-derived edges (including the flat/reverse
   * connectors a piste emits). Splitting a way keeps it, so every fragment of a polygon ring is
   * traceable back to the one polygon — which per-edge geometry alone cannot tell you.
   */
  srcWayId?: number;
  /**
   * Build-time only: the portal node a synthesised polygon arm springs from. Set on every edge an
   * arm emits so the prune pass (which runs last, once overrides can no longer move edges around)
   * can regroup an arm from a flat edge list. Stripped before the graph is written, so it never
   * reaches the app.
   */
  armPortal?: string;
  /**
   * True for a synthesised polygon **arm**: an invented stub carrying a rim portal in to the
   * polygon's spine. An arm is plumbing, not terrain — it exists so a skier can enter or leave the
   * polygon at that portal, and nobody chooses to ski one. It stays fully routable (arms are
   * load-bearing for connectivity, which is why they are deliberately *not* flagged `synthetic` —
   * that flag is wired to "avoid app-added bridges" and would let a user disconnect a polygon), but
   * the longest-run scorer pays it no distance credit. Without that, the longest search weaves
   * spine → arm → neighbouring arm → spine to bank invented metres.
   */
  skeletonArm?: boolean;

  /**
   * True for polygon-derived geometry that merely **retraces the spine the same polygon already
   * adopted**. A class A/B′ polygon reuses a real OSM centreline as its spine, but still emits its
   * own skeleton lines, and those frequently land within a few metres of — sometimes exactly on —
   * that adopted centreline. The result is two parallel copies of one run, cross-linked by short
   * arms, and the router hops between them: measured on Val Thorens `w22868803` (a novice polygon
   * whose spine is Combe de Thorens `w99075767`), whose last 500 m alternated between the two
   * copies five times with 80–95° turns and 2–9 m fragments.
   *
   * These stay routable — a duplicate can still be the only thing carrying a portal — but routing
   * charges them a multiplier so the real adopted centreline wins, and the longest-run scorer pays
   * them no distance credit, exactly like an arm.
   */
  spineDuplicate?: boolean;

  /**
   * True for the short link between a **lift station with a terminal building** and the piste
   * network beside it. Its vertical is *inside the building* - stairs or an escalator - not a
   * climb on snow, so `cost.ts` does not charge `CLIMB_SECONDS_PER_M` on it.
   *
   * A big terminal is several storeys: the DEM samples the ground at the footprint (often the
   * boarding level, or the road outside), while skiers leave from the top floor. Paradiski's
   * Vanoise Express base reads 1541 m against 1550-1552 m for the two runs that touch it, and
   * both rasters agree, so this is not a bad datum to be overridden - it is the building. Charged
   * as terrain that was 10.9 m x 12 s/m = 131 s of imaginary poling just to walk out of a major
   * inter-sector cable car, enough to push routes off it entirely.
   *
   * Gated on `DOWNLOADABLE_LIFT_TYPES` because that set is exactly the types that HAVE a terminal
   * building. A chairlift base or a drag top is an open-air ramp, so an apparent climb into one is
   * evidence of a mis-seated station and must stay visible: fleet-wide 13 station snaps exceed
   * `maxTraverseClimb`, and the 9 non-downloadable ones include two platter *tops* that our own
   * lift-type rule says should be sources, i.e. probable elevation faults. Exempting those would
   * hide them.
   *
   * `'ramp'` is recorded rather than simply left unset so the two cases stay distinguishable
   * downstream: `probe:stationclimb` needs the exact snap population, and inferring it from edge
   * shape instead swept in rescue links, plateau bridges and ski-in links (58 hits against 13).
   */
  stationAccess?: 'building' | 'ramp';

  // Lift-only
  liftType?: LiftType;
  liftName?: string;
  /** True if this lift edge carries skiers downhill (download). */
  isDownload?: boolean;
  /** Raw OSM opening_hours string when present. */
  openingHours?: string;
  /**
   * Published ride time in seconds, from OSM `aerialway:duration`. Present ONLY when the tag
   * exists — never a value we derived — so the router can tell a measured fact from its own
   * estimate and fall back to length/speed when it's absent.
   */
  rideSeconds?: number;

  // Connector-only
  connectorKind?: ConnectorKind;
  /** Gradient as rise/run (negative descending) for connectors. */
  gradient?: number;

  /** True for pipeline-inferred bridges / rescue links / user custom links (not real OSM geometry). */
  synthetic?: boolean;
  /** True specifically for user-added custom links (a subset of synthetic). */
  custom?: boolean;
  /**
   * True when OSM tags this run `piste:difficulty=freeride|extreme` — unmarked, unpatrolled
   * off-piste terrain rather than an actual piste. Excluded from routing unless the skier opts in
   * via `Preferences.allowOffPiste`. See NormPiste.offPiste for why the trigger is difficulty only.
   */
  offPiste?: boolean;
  /**
   * OSM tags this run `oneway=no`, so the mapper has stated outright that it may be travelled in
   * both directions. `buildGraph` uses that to waive the *gradient* half of the near-flat reverse
   * test (never the `maxTraverseClimb` cap) - see `pisteBidirectionalFor` in normalize.ts.
   *
   * The flag has to survive onto the edges because a LATER pass re-derives direction and would
   * otherwise re-decide the question under a different, stricter rule. `applyOverrides` re-checks
   * every edge touching a corrected node using `pisteFlatTolerance` (3 m), which knows nothing
   * about the grant, so an explicitly two-way run with a 4-8 m rise silently lost its uphill half
   * the moment anything pinned a neighbouring height - even when the correction left the rise
   * unchanged. Measured: 31 such runs across 10 resorts, 4 from hand pins and 27 from the
   * elevation-consensus pass, which applies its corrections through the same code.
   */
  taggedTwoWay?: boolean;
}

export interface ResortBBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface Resort {
  id: string;
  /** Full display name, shown where there is room (the resort dropdown). */
  name: string;
  /**
   * Compact label for the two places `name` does not fit: the collapsed resort picker
   * (`maxWidth: 280`) and the global-view flag label, which is 10-13 px map text that wraps at
   * 10 ems into a multi-line block under a tiny flag. Falls back to `name` when unset, so only
   * resorts whose full name spells out their sub-areas need it.
   */
  shortName?: string;
  country: string;
  /** Map default center. */
  center: { lon: number; lat: number };
  bbox: ResortBBox;
  /**
   * Rectangles to SUBTRACT from `bbox` (build-time only). Real ski areas are not rectangles, so
   * where a neighbouring resort shares a corner there is no single box that holds all of ours and
   * none of theirs. A piste/lift with the majority of its points inside one of these is dropped.
   */
  excludeBboxes?: ResortBBox[];
  defaultZoom: number;
  /** IANA timezone for interpreting lift opening hours. */
  timezone: string;
  /** Official resort site (best-effort) for live lift/slope status — surfaced in the load notice. */
  infoUrl?: string;
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
    | 'pothole_repaired'
    | 'coincident_nodes_unified'
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
  /**
   * When true, allow routing over off-piste/freeride terrain (`GraphEdge.offPiste`).
   *
   * Defaults to **false**, and deliberately so: this is unmarked, unpatrolled, avalanche-exposed
   * terrain, and a route that silently includes it is a safety problem, not a routing preference.
   * Opting in is the skier's decision to make explicitly.
   */
  allowOffPiste: boolean;
  /**
   * When true, a named piste counts fully as skiing however shallow it runs — "allow a bit of
   * poling".
   *
   * This is a matter of taste, not a fact about the mountain, which is why it is a preference and
   * not a constant: some skiers will happily pole a flat stretch to link a much longer descent,
   * others count only the pitch and would rather have a shorter, steeper run. See
   * `makeDescentScorer` for why the opt-in is scoped to *named pistes* and never to connectors,
   * synthetic bridges, polygon arms or spine duplicates.
   */
  allowPoling: boolean;
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
 * A badge on a route card. This is a KEY, never display text.
 *
 * It used to be the English string ("Fastest", "Alternative"), and `reconcileLabels` in plan.ts
 * compares badges to decide which card wins a badge — so the display string was load-bearing
 * routing logic. Translating it would have silently broken reconciliation rather than failing
 * loudly. Routing emits keys; only the UI turns a key into words (see utils/routeLabels.ts).
 */
export type RouteLabel = RouteObjective | 'alternative';

/**
 * A translatable string produced by a pure routing module: a catalogue key plus its
 * interpolation params. Same seam as `RouteLabel` above — routing never builds a finished
 * sentence, because these modules also run under Node in the pipeline probes, where there is
 * no `t()` and no language. Params may nest another TextRef (a piste label inside a leg
 * description); `utils/text.ts` resolves them.
 */
export interface TextRef {
  key: string;
  params?: Record<string, string | number | TextRef>;
}

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
  description: TextRef;
  distanceM: number;
  durationS: number;
  color?: PisteColor;
  liftType?: LiftType;
  isDownload?: boolean;
  synthetic?: boolean;
  custom?: boolean;
  /**
   * App-invented plumbing emitted as ordinary piste: a polygon skeleton arm, or a polygon line
   * that only retraces the centreline its own polygon adopted as a spine. Not terrain anyone
   * chooses to ski, so it must not count as "skiing" when ranking routes (see ranking.ts).
   */
  plumbing?: boolean;
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
    | 'off_piste'
    | 'custom_edge';
  message: TextRef;
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
  /**
   * Which question this route answers. Recorded on the route rather than read from the app's
   * current toggle so a later flip of that toggle cannot relabel a route that was already planned:
   * under `arrive_by` the *departure* time is the answer, under `now` it is the arrival.
   */
  timingMode?: TimingMode;
}

/**
 * A consolidated, human-readable route step covering one or more consecutive legs
 * (same run/lift; tiny connectors absorbed). Display-only — routing uses `legs`.
 */
export interface DisplayStep {
  kind: EdgeKind;
  /** Full label, including the slope colour. */
  label: TextRef;
  /**
   * The same label without the colour, for the turn-by-turn banner where the colour is
   * already shown as a badge. Carried explicitly because the banner used to strip
   * "(blue)" off `label` with an English-only regex.
   */
  labelShort: TextRef;
  /**
   * The label with the slope NUMBER dropped as well, for surfaces that render the piste shield
   * beside it. Without this the nav banner printed the number twice - once in the shield and again
   * inside "Ski 89 · Nambino". Same reasoning as `labelShort`: whatever a badge already says, the
   * sentence must not repeat.
   */
  labelBadge: TextRef;
  /** Raw run/lift name as mapped (never translated) — the badge reads its slope number from it. */
  name?: string;
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
  closureLabel: TextRef | null;
}

export interface Route {
  id: string;
  objective: RouteObjective;
  /** Objective badge KEYS to show on the card (e.g. ["fastest", "fewest_lifts"] when deduped). */
  labels?: RouteLabel[];
  legs: RouteLeg[];
  /** Grouped, readable steps derived from `legs` (presentation only). */
  steps: DisplayStep[];
  stats: RouteStats;
  warnings: RouteWarning[];
}
