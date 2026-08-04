import { useEffect, useState } from 'react';
import type { DisplayStep } from '../types/domain';
import type { LivePosition } from '../hooks/useLiveLocation';
import { posAtS, type RoutePath } from '../routing/navigation';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Slider from '@mui/material/Slider';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import ReplayIcon from '@mui/icons-material/Replay';
import AltRouteIcon from '@mui/icons-material/AltRoute';
import CloseIcon from '@mui/icons-material/Close';

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
    <>
      {/* Top: compact next-turn instruction pill (centred, narrow so it clears the corner icons). */}
      <Box
        sx={{
          position: 'absolute', left: 0, right: 0, top: 0, zIndex: 5, p: 1.25,
          display: 'flex', justifyContent: 'center', pointerEvents: 'none',
        }}
      >
        <Paper
          elevation={8}
          sx={{
            pointerEvents: 'auto', maxWidth: 'min(430px, 76%)', px: 2, py: 1.25, borderRadius: 3,
            bgcolor: offRoute ? 'error.main' : 'background.paper',
            color: offRoute ? 'error.contrastText' : 'text.primary',
          }}
        >
          {waiting ? (
            <Typography sx={{ fontWeight: 800, fontSize: 18 }}>Waiting for your location…</Typography>
          ) : offRoute ? (
            <>
              <Typography sx={{ fontWeight: 800, fontSize: 18 }}>⚠ You're off the route</Typography>
              <Typography variant="body2">Ski back to the blue line, or re-route.</Typography>
            </>
          ) : (
            <>
              <Typography sx={{ fontWeight: 800, fontSize: 18, display: 'flex', alignItems: 'center' }}>
                <StepBadge step={step?.current} big /> {stepText(step?.current)}
              </Typography>
              <Typography variant="body2" sx={{ mt: 0.25 }} color={offRoute ? 'inherit' : 'text.secondary'}>
                {step && step.distToNextM > 5 ? `in ${fmtDist(step.distToNextM)} → ` : 'Then '}
                <StepBadge step={step?.next} />
                {step?.next ? stepText(step.next) : 'arrive at destination'}
              </Typography>
            </>
          )}
        </Paper>
      </Box>

      {/* Bottom: ETA + speed + actions bar (plus the dev simulator strip above it). */}
      <Box
        sx={{
          position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 6,
          px: 1.25, pt: 1.25, pb: 'calc(10px + env(safe-area-inset-bottom, 0px))',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, pointerEvents: 'none',
        }}
      >
        {sim && (
          <Paper elevation={4} sx={{ pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.5, borderRadius: 2 }}>
            <Typography variant="caption" sx={{ fontWeight: 700 }}>DEV sim</Typography>
            <IconButton size="small" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play'}>
              {playing ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
            </IconButton>
            <IconButton
              size="small"
              aria-label="Reset simulator"
              onClick={() => { setPlaying(false); setSimS(0); sim.onSim(null); }}
            >
              <ReplayIcon fontSize="small" />
            </IconButton>
            <Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}>{speed} m/s</Typography>
            <Slider size="small" min={3} max={25} value={speed} onChange={(_, v) => setSpeed(v as number)} sx={{ width: 110 }} />
          </Paper>
        )}
        <Paper
          elevation={8}
          sx={{
            pointerEvents: 'auto', width: 'min(560px, 94%)', px: 1.75, py: 1, borderRadius: 3,
            display: 'flex', alignItems: 'center', gap: 1.5,
            bgcolor: offRoute ? 'error.main' : 'background.paper',
            color: offRoute ? 'error.contrastText' : 'text.primary',
          }}
        >
          {!waiting && speedMps != null && speedMps >= 0 && (
            <div className="nav-speed-circle">
              <span className="ns-num">{Math.round(speedMps * 3.6)}</span>
              <span className="ns-unit">km/h</span>
            </div>
          )}
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {remaining ? (
              <Typography sx={{ fontWeight: 800, fontSize: 17 }} color={offRoute ? 'inherit' : 'primary.main'}>
                {fmtDist(remaining.distM)} · {fmtTime(remaining.timeS)} left
              </Typography>
            ) : (
              <Typography variant="body2" color={offRoute ? 'inherit' : 'text.secondary'}>
                {waiting ? 'Acquiring GPS…' : 'En route'}
              </Typography>
            )}
          </Box>
          {offRoute && (
            <Button
              variant="contained"
              startIcon={<AltRouteIcon />}
              onClick={onReroute}
              sx={{ borderRadius: 5, textTransform: 'none', fontWeight: 700, px: 2, boxShadow: 2, flexShrink: 0 }}
            >
              Re-route
            </Button>
          )}
          <Button
            variant={offRoute ? 'contained' : 'outlined'}
            color="inherit"
            startIcon={<CloseIcon />}
            onClick={onExit}
            sx={{
              borderRadius: 5, textTransform: 'none', fontWeight: 700, px: 2, flexShrink: 0,
              ...(offRoute
                ? { bgcolor: 'background.paper', color: 'text.primary', boxShadow: 2 }
                : { borderColor: 'divider', color: 'text.secondary' }),
            }}
          >
            Exit
          </Button>
        </Paper>
      </Box>
    </>
  );
}

