import { fmtDistance } from '../utils/format';

export interface LongestRunView {
  distanceM: number;
  descentM: number;
  startName: string;
  endName: string;
}

interface Props {
  runs: LongestRunView[] | null;
  index: number;
  onFind: () => void;
  onPrev: () => void;
  onNext: () => void;
  onShowOnMap: () => void;
  onNavigateStart: () => void;
  onNavigateEnd: () => void;
}

export function LongestRunPanel({
  runs,
  index,
  onFind,
  onPrev,
  onNext,
  onShowOnMap,
  onNavigateStart,
  onNavigateEnd,
}: Props) {
  const run = runs && runs.length ? runs[index] : null;
  const total = runs?.length ?? 0;

  return (
    <div className="panel">
      <h3>🏆 Longest runs in the resort</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        The longest possible descents without taking a lift (top to bottom), for your level.
      </p>
      <button type="button" className="secondary" onClick={onFind}>
        Find the longest runs
      </button>

      {run && (
        <div className="longest-result">
          {total > 1 && (
            <div className="longest-carousel">
              <button type="button" className="mini arrow" onClick={onPrev} aria-label="Previous run">‹</button>
              <span className="muted">#{index + 1} of {total} longest</span>
              <button type="button" className="mini arrow" onClick={onNext} aria-label="Next run">›</button>
            </div>
          )}
          <div className="longest-stats">
            <strong>{fmtDistance(run.distanceM)}</strong>
            <span className="muted">⬇ {fmtDistance(run.descentM)} descent</span>
          </div>
          <div className="longest-ends">
            <span className="ep-a">{run.startName}</span>
            <span> → </span>
            <span className="ep-b">{run.endName}</span>
          </div>
          <div className="longest-actions">
            <button type="button" className="mini" onClick={onShowOnMap}>🗺 Show on map</button>
            <button type="button" className="mini" onClick={onNavigateStart}>📍 Navigate to start</button>
            <button type="button" className="mini" onClick={onNavigateEnd}>⛷ Navigate to end</button>
          </div>
        </div>
      )}
    </div>
  );
}
