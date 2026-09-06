/**
 * Corroboration gate on the near-flat lift-direction rule.
 *
 * `buildGraph` orients a lift bottom = lower station, except when the whole lift's rise is under
 * `liftFlatDirectionM` (10 m), where it hands the decision to the way's drawn direction instead.
 * The premise is that a couple of metres over a short carpet is DEM noise, and mappers draw a lift
 * bottom -> top ~99 % of the time, so on flat ground the drawing is the better witness.
 *
 * That premise fails whenever the drop is small but REAL. Measured fleet-wide the rule flips 39
 * lifts, and for 17 of them a second raster agrees the drawn-first end genuinely is the higher one
 * by several metres - so the rule was overriding good evidence and emitting a magic carpet, rope
 * tow or people mover running downhill, which both hands out a free descent and takes away the
 * uphill service the lift exists to provide.
 *
 * This pass asks the second raster before letting the drawing win. It only ever *withholds* the
 * exemption, restoring the ordinary elevation-derived orientation; it can never flip a lift the
 * drawing rule was not already flipping, and it never touches a lift over the flat threshold.
 *
 * Deliberate limits:
 * - It is a **veto, not a vote**. Where the second raster disagrees or the margin is inside noise
 *   the drawing still wins, which is the case the rule was written for (Madonna's Tapis Roulant
 *   Grostè Express reads +1.3 m in our field and -0.5 m in Terrarium).
 * - Terrarium is **not fully independent** of our elevation field, which averages skadi and
 *   Terrarium wherever the two agree within 8 m. It separates these cases cleanly, but do not
 *   describe it as a second opinion in the strict sense. Published resort information about which
 *   way a carpet runs beats both rasters and belongs in an override.
 * - The margin is a MARGIN, not a threshold to tune down. Under it the two sources are saying the
 *   same thing to within their own precision, which is not corroboration of anything.
 */
import type { GraphConstants } from '../../src/config/graphConstants';
import type { NormLift } from './normalize';
import { sampleTerrarium } from './terrarium';

/**
 * Both readings must put the drawn-first end this far above the drawn-last end before the drawing
 * loses. Chosen as the point where the two sources stop being able to agree by accident.
 */
export const CORROB_MARGIN_M = 2;

export interface LiftDirectionCheck {
  wayId: number;
  name?: string;
  liftType: string;
  /** Drop along the drawing in our own field. Positive = drawn-first end is higher. */
  oursM: number;
  terrM: number | null;
  smoothM: number | null;
  rejected: boolean;
}

export interface LiftDirectionResult {
  /** Lift way ids whose drawn direction must NOT override the elevation-derived orientation. */
  reject: Set<number>;
  checks: LiftDirectionCheck[];
}

/**
 * Examines every lift the near-flat rule would flip and returns the ones where a second raster
 * corroborates the drop, i.e. where the drawing should not have been believed.
 */
export async function corroborateLiftDirections(
  lifts: NormLift[],
  c: GraphConstants,
): Promise<LiftDirectionResult> {
  const reject = new Set<number>();
  const checks: LiftDirectionCheck[] = [];

  for (const lift of lifts) {
    const first = lift.points[0];
    const last = lift.points[lift.points.length - 1];
    if (!first || !last || first === last) continue;
    if (first.ele == null || last.ele == null) continue;

    const oursM = first.ele - last.ele;
    // Only a lift the rule would actually flip is in scope. `oursM <= 0` means the drawing and the
    // elevation already agree on which end is the bottom, so the exemption changes nothing; at or
    // above the flat threshold the elevation decides regardless.
    if (oursM <= 0 || oursM >= c.liftFlatDirectionM) continue;

    const a = await sampleTerrarium(first.lat, first.lon);
    const b = await sampleTerrarium(last.lat, last.lon);
    const terrM = a.point != null && b.point != null ? a.point - b.point : null;
    const smoothM = a.smooth != null && b.smooth != null ? a.smooth - b.smooth : null;

    // Both readings must agree, and the point sample alone is not enough: Terrarium carries
    // single-pixel spikes, which is exactly what the smoothed median exists to absorb.
    const rejected =
      terrM != null && smoothM != null && terrM > CORROB_MARGIN_M && smoothM > CORROB_MARGIN_M;
    if (rejected) reject.add(lift.wayId);

    checks.push({
      wayId: lift.wayId,
      name: lift.name,
      liftType: lift.liftType,
      oursM,
      terrM,
      smoothM,
      rejected,
    });
  }

  return { reject, checks };
}
