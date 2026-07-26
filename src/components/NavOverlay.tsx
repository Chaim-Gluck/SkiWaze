import { useEffect, useState } from 'react';
import type { DisplayStep } from '../types/domain';
import type { LivePosition } from '../hooks/useLiveLocation';
import { posAtS, type RoutePath } from '../routing/navigation';

interface StepInfo {
  current?: DisplayStep;
  next?: DisplayStep;
  distToNextM: number;
}

interface Props {
  step?: StepInfo;
  remaining?: { distM: number; timeS: number };
  speedMps?: number | null;
  offRoute: boolean;
  waiting: boolean;
  onExit: () => void;
  onReroute: () => void;
  /** Dev-only GPS simulator (plays a synthetic position along the active route). */
  sim?: { path: RoutePath | null; onSim: (p: LivePosition | null) => void };
}

function fmtDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`;
}
function fmtTime(s: number): string {
  const min = Math.round(s / 60);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}
function stepText(st?: DisplayStep): string {
  return st?.label ?? '—';
}

const COLOR_HEX: Record<string, string> = {
  green: '#2e7d32', blue: '#1565c0', red: '#d32f2f', black: '#111111', unknown: '#ff9800',
};
/** First slope number in a step label ("Ski 50 · …" -> "50"), or null. */
function pisteNumber(label?: string): string | null {
  const m = label?.match(/(\d+)/);
  return m ? m[1] : null;
}
/** Waze-style piste "shield": colored badge with the slope number, a colored difficulty dot
 * when the piste has no number (common — many resorts don't number pistes), or a lift glyph. */
function StepBadge({ step, big }: { step?: DisplayStep; big?: boolean }) {
  if (!step) return null;
  const cls = big ? 'pbadge big' : 'pbadge';
  if (step.kind === 'lift') return <span className={`${cls} lift`} title="lift">🚡</span>;
  if (step.kind === 'connector') return null;
  const bg = COLOR_HEX[step.color ?? 'unknown'] ?? COLOR_HEX.unknown;
  const num = step.ref ?? pisteNumber(step.label);
  if (num) return <span className={cls} style={{ background: bg }}>{num}</span>;
  return <span className={big ? 'pdot big' : 'pdot'} style={{ background: bg }} title={step.color ?? 'run'} />;
}

export function NavOverlay({ step, remaining, speedMps, offRoute, waiting, onExit, onReroute, sim }: Props) {
  // Dev simulator state
  const [, setSimS] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(12); // m/s

  useEffect(() => {
    if (!playing || !sim?.path) return;
    const dt = 0.5;
    const id = window.setInterval(() => {
      setSimS((s) => {
        const ns = s + speed * dt;
        const p = posAtS(sim.path!, ns);
        if (p) sim.onSim({ lon: p.lon, lat: p.lat, accuracy: 5, heading: p.heading, speed, ts: Date.now() });
        if (ns >= (sim.path?.totalM ?? 0)) setPlaying(false);
        return ns;
      });
    }, dt * 1000);
    return () => window.clearInterval(id);
  }, [playing, speed, sim]);

  return (
    <div className="nav-overlay">
      <div className={offRoute ? 'nav-banner off' : 'nav-banner'}>
        <div className="nav-main">
          {waiting ? (
            <div className="nav-line1">Waiting for your location…</div>
          ) : offRoute ? (
            <>
              <div className="nav-line1">⚠ You're off the route</div>
              <div className="nav-line2">Ski back to the blue line, or re-route from here.</div>
            </>
          ) : (
            <>
              <div className="nav-line1"><StepBadge step={step?.current} big /> {stepText(step?.current)}</div>
              <div className="nav-line2">
                {step && step.distToNextM > 5 ? `in ${fmtDist(step.distToNextM)} → ` : 'Then '}
                <StepBadge step={step?.next} />
                {step?.next ? stepText(step.next) : 'arrive at destination'}
              </div>
            </>
          )}
        </div>
        {!waiting && (
          <div className="nav-side">
            {speedMps != null && speedMps >= 0 && (
              <div className="nav-speed-circle">
                <span className="ns-num">{Math.round(speedMps * 3.6)}</span>
                <span className="ns-unit">km/h</span>
              </div>
            )}
            {remaining && (
              <span className="nav-remaining">{fmtDist(remaining.distM)} · {fmtTime(remaining.timeS)} left</span>
            )}
          </div>
        )}
      </div>

      <div className="nav-actions">
        <button type="button" className="nav-btn reroute" onClick={onReroute}>Re-route from here</button>
        <button type="button" className="nav-btn exit" onClick={onExit}>Exit</button>
      </div>

      {sim && (
        <div className="nav-sim">
          <span>DEV sim</span>
          <button type="button" onClick={() => setPlaying((p) => !p)}>{playing ? '⏸' : '▶'}</button>
          <button
            type="button"
            onClick={() => {
              setPlaying(false);
              setSimS(0);
              sim.onSim(null);
            }}
          >
            ⟲
          </button>
          <label>
            {speed} m/s
            <input type="range" min={3} max={25} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
          </label>
        </div>
      )}
    </div>
  );
}
