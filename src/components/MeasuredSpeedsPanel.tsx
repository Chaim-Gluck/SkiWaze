import type { MeasuredSpeeds, SpeedColor } from '../state/measuredSpeeds';
import { measuredAverages } from '../state/measuredSpeeds';

const COLORS: SpeedColor[] = ['green', 'blue', 'red', 'black'];
const LABEL: Record<SpeedColor, string> = { green: 'Green', blue: 'Blue', red: 'Red', black: 'Black' };

interface Props {
  measured: MeasuredSpeeds;
  estimatedByColor: Record<SpeedColor, number>;
  minSamples: number;
  onApply: () => void;
  onReset: () => void;
}

/** Shows the skier's own measured average speed per color (recorded live while navigating). */
export function MeasuredSpeedsPanel({ measured, estimatedByColor, minSamples, onApply, onReset }: Props) {
  const avg = measuredAverages(measured, minSamples);
  const ready = Object.keys(avg).length > 0;

  return (
    <div className="measured">
      <div className="measured-head">My measured speeds</div>
      <p className="measured-note">
        Your real GPS pace vs the current estimate. Apply to use your measured speeds for time estimates.
      </p>
      <table className="measured-table">
        <thead>
          <tr><th>Colour</th><th>Estimated</th><th>Measured</th><th>Samples</th></tr>
        </thead>
        <tbody>
          {COLORS.map((c) => {
            const b = measured.byColor?.[c] ?? { sum: 0, count: 0 };
            const kmh = b.count > 0 ? Math.round((b.sum / b.count) * 3.6) : null;
            const est = Math.round(estimatedByColor[c] * 3.6);
            const enough = b.count >= minSamples;
            return (
              <tr key={c} className={enough ? 'ok' : ''}>
                <td><span className={`chip color-${c}`}>{LABEL[c]}</span></td>
                <td className="measured-est">{est} km/h</td>
                <td>{kmh != null ? `${kmh} km/h` : '—'}</td>
                <td className="measured-count">{b.count}{enough ? ' ✓' : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="measured-actions">
        <button type="button" className="primary" disabled={!ready} onClick={onApply}>Use my measured speeds</button>
        <button type="button" onClick={onReset}>Reset</button>
      </div>
      {!ready && <div className="measured-hint">Ski at least {minSamples} seconds on a color while navigating to unlock it.</div>}
    </div>
  );
}
