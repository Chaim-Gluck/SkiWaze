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

export function NavOverlay({ step, remaining, offRoute, waiting, onExit, onReroute, sim }: Props) {
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
        {waiting ? (
          <div className="nav-line1">Waiting for your location…</div>
        ) : offRoute ? (
          <>
            <div className="nav-line1">⚠ You're off the route</div>
            <div className="nav-line2">Ski back to the blue line, or re-route from here.</div>
          </>
        ) : (
          <>
            <div className="nav-line1">{stepText(step?.current)}</div>
            <div className="nav-line2">
              {step && step.distToNextM > 5 ? `in ${fmtDist(step.distToNextM)} → ` : 'Then '}
              {step?.next ? stepText(step.next) : 'arrive at destination'}
            </div>
          </>
        )}
        {remaining && !waiting && (
          <div className="nav-remaining">
            {fmtDist(remaining.distM)} · {fmtTime(remaining.timeS)} left
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
