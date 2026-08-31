/**
 * The one definition of what each skeleton part looks like.
 *
 * The skeleton builder distinguishes its parts by *colour only* — a spine and an arm are both just
 * lines, told apart by their stroke. That is fine to look at and impossible to filter on, so the
 * emitter maps each colour back to a `role`. Keeping both sides of that mapping honest requires a
 * single table: with the literals scattered across the builder, the emitter and the debug map's
 * legend, changing one shade would silently desync the layer from what it claims to show.
 */
export const SKEL_COLORS = {
  /** The polygon outline these parts sit inside. Not emitted — the `areas` layer already draws it. */
  rim: '#9aa4b2',
  /** A real OSM centreline, clipped to the ring and adopted as the spine (class A/B'). */
  spine: '#1560ff',
  /** A spine the polygon had to invent because no centreline lay inside it (class B). */
  spineSynth: '#4da3ff',
  /** Link joining two spine pieces that would otherwise be separate components. */
  stitch: '#00e0d0',
  /** Portal → spine arm. */
  arm: '#e11d9c',
  /** Arm routed via a local hub rather than straight to the spine. */
  armHub: '#7c3aed',
  /** Arm whose search found no target — the shape to look at when connectivity is missing. */
  armNoTarget: '#0ea5a4',
  /** Invented mid-boundary crossing between two touching polygons. */
  gateway: '#7ddb4a',
  /** A real graph node on the rim. */
  portal: '#ff8c1a',
  /** A portal the interior grid could not reach. */
  stranded: '#e11',
} as const;

/** Colour → role, for the parts the debug layer filters on. Anything else is an arm. */
export const SKEL_ROLE: Record<string, string> = {
  [SKEL_COLORS.spine]: 'spine',
  [SKEL_COLORS.spineSynth]: 'spine_synth',
  [SKEL_COLORS.stitch]: 'stitch',
};
