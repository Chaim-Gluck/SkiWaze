import type { PisteColor } from '../types/domain';

export type SpeedColor = 'green' | 'blue' | 'red' | 'black';
const COLORS: SpeedColor[] = ['green', 'blue', 'red', 'black'];

/** Running sum/count of observed skiing speeds (m/s) per piste color, from live GPS. */
export interface MeasuredSpeeds {
  byColor: Record<SpeedColor, { sum: number; count: number }>;
}

const KEY = 'skiwaze.measuredSpeeds.v1';

export function emptyMeasured(): MeasuredSpeeds {
  return { byColor: { green: { sum: 0, count: 0 }, blue: { sum: 0, count: 0 }, red: { sum: 0, count: 0 }, black: { sum: 0, count: 0 } } };
}

export function loadMeasured(): MeasuredSpeeds {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyMeasured();
    const parsed = JSON.parse(raw) as Partial<MeasuredSpeeds>;
    const base = emptyMeasured();
    for (const c of COLORS) {
      const b = parsed.byColor?.[c];
      if (b && typeof b.sum === 'number' && typeof b.count === 'number') base.byColor[c] = { sum: b.sum, count: b.count };
    }
    return base;
  } catch {
    return emptyMeasured();
  }
}

export function saveMeasured(m: MeasuredSpeeds): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* ignore quota / private-mode */
  }
}

/** Return a new MeasuredSpeeds with one speed sample (m/s) folded into `color`. */
export function addSample(m: MeasuredSpeeds, color: SpeedColor, speedMps: number): MeasuredSpeeds {
  const byColor = m?.byColor ?? emptyMeasured().byColor;
  const cur = byColor[color] ?? { sum: 0, count: 0 };
  return {
    byColor: { ...byColor, [color]: { sum: cur.sum + speedMps, count: cur.count + 1 } },
  };
}

/** Average measured speed (m/s) per color, only for colors with >= `minSamples`. */
export function measuredAverages(m: MeasuredSpeeds, minSamples: number): Partial<Record<SpeedColor, number>> {
  const out: Partial<Record<SpeedColor, number>> = {};
  const byColor = m?.byColor;
  if (!byColor) return out;
  for (const c of COLORS) {
    const b = byColor[c];
    if (b && b.count >= minSamples) out[c] = b.sum / b.count;
  }
  return out;
}

export function isSpeedColor(c: PisteColor | undefined): c is SpeedColor {
  return c === 'green' || c === 'blue' || c === 'red' || c === 'black';
}
