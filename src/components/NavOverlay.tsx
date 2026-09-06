import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { DisplayStep } from '../types/domain';
import type { LivePosition } from '../hooks/useLiveLocation';
import { posAtS, type RoutePath } from '../routing/navigation';
import { tr } from '../utils/text';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Slider from '@mui/material/Slider';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ScienceIcon from '@mui/icons-material/Science';
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
  /**
   * GPS simulator. Shown to end users only in Preview mode (`preview: true`), which App offers when
   * navigation cannot work for real — no fix, or a fix far from the resort. In DEV it is always
   * available with the raw scrub controls, because that is what it was built for.
   */
  sim?: { path: RoutePath | null; onSim: (p: LivePosition | null) => void; preview?: boolean };
}

function fmtDist(m: number, t: TFunction): string {
  return m >= 1000
    ? t('units.km', { value: (m / 1000).toFixed(1) })
    : t('units.m', { value: Math.round(m / 10) * 10 });
}
function fmtTime(s: number, t: TFunction): string {
  const min = Math.round(s / 60);
  return min >= 60
    ? t('units.hourMin', { hours: Math.floor(min / 60), minutes: min % 60 })
    : t('units.min', { value: min });
}
/**
 * Banner text for a step. The coloured number shield already conveys the difficulty, so this
 * uses the step's `labelShort` (built without the colour) rather than stripping "(blue)" off
 * the full label — that strip was an English-only regex and would have quietly stopped
 * working in any other language.
 */
function stepText(t: TFunction, st?: DisplayStep): string {
  return st ? tr(t, st.labelShort) : '—';
}

const COLOR_HEX: Record<string, string> = {
  green: '#2e7d32', blue: '#1565c0', red: '#d32f2f', black: '#111111', unknown: '#ff9800',
};
/** First slope number in a run's mapped name ("50 · Ruggenhof" -> "50"), or null. */
function pisteNumber(name?: string): string | null {
  const m = name?.match(/(\d+)/);
  return m ? m[1] : null;
}
/** Waze-style piste "shield": colored badge with the slope number, a colored difficulty dot
 * when the piste has no number (common — many resorts don't number pistes), or a lift glyph. */
function StepBadge({ step, big }: { step?: DisplayStep; big?: boolean }) {
  const { t } = useTranslation();
  if (!step) return null;
  const cls = big ? 'pbadge big' : 'pbadge';
  if (step.kind === 'lift') return <span className={`${cls} lift`} title={t('nav.liftBadge')}>🚡</span>;
  if (step.kind === 'connector') return null;
  const bg = COLOR_HEX[step.color ?? 'unknown'] ?? COLOR_HEX.unknown;
  const num = step.ref ?? pisteNumber(step.name);
  if (num) return <span className={cls} style={{ background: bg }}>{num}</span>;
  return <span className={big ? 'pdot big' : 'pdot'} style={{ background: bg }} title={step.color ? t(`color.${step.color}`) : t('nav.runBadge')} />;
}

export function NavOverlay({ step, remaining, speedMps, offRoute, waiting, onExit, onReroute, sim }: Props) {
  const { t } = useTranslation();
  const preview = !!sim?.preview;
  // Simulator state. `speed` is metres per second: end users pick it from three named presets,
  // DEV gets the raw slider.
  const [simS, setSimS] = useState(0);  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(12); // m/s

  // Seed a position at the route start the moment Preview opens. Without this the overlay would sit
  // on "waiting for location" until the user pressed play — the very state Preview exists to escape.
  useEffect(() => {
    if (!preview || !sim?.path) return;
    const p = posAtS(sim.path, 0);
    if (p) sim.onSim({ lon: p.lon, lat: p.lat, accuracy: 5, heading: p.heading, speed: 0, ts: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, sim?.path]);

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
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.75, maxWidth: '92%' }}>
        {/* Non-dismissable: a simulated position must never be mistakable for a real one. */}
        {preview && (
          <Paper
            elevation={6}
            sx={{
              pointerEvents: 'none', px: 1.5, py: 0.4, borderRadius: 5,
              bgcolor: 'var(--sim)', color: '#1a1200', display: 'flex', alignItems: 'center', gap: 0.75,
            }}
          >
            <ScienceIcon fontSize="small" />
            <Typography variant="caption" sx={{ fontWeight: 800, letterSpacing: 0.2 }}>
              {t('preview.banner')}
            </Typography>
          </Paper>
        )}
        <Paper
          elevation={8}
          sx={{
            pointerEvents: 'auto', maxWidth: 'min(430px, 76%)', px: 2, py: 1.25, borderRadius: 3,
            bgcolor: offRoute ? 'error.main' : 'background.paper',
            color: offRoute ? 'error.contrastText' : 'text.primary',
          }}
        >
          {waiting ? (
            <Typography sx={{ fontWeight: 800, fontSize: 18 }}>{t('nav.waitingLocation')}</Typography>
          ) : offRoute ? (
            <>
              <Typography sx={{ fontWeight: 800, fontSize: 18 }}>⚠ {t('nav.offRoute')}</Typography>
              <Typography variant="body2">{t('nav.offRouteHint')}</Typography>
            </>
          ) : (
            <>
              <Typography sx={{ fontWeight: 800, fontSize: 18, display: 'flex', alignItems: 'center' }}>
                <StepBadge step={step?.current} big /> {stepText(t, step?.current)}
              </Typography>
              <Typography variant="body2" sx={{ mt: 0.25 }} color={offRoute ? 'inherit' : 'text.secondary'}>
                {step && step.distToNextM > 5 ? t('nav.inDistance', { distance: fmtDist(step.distToNextM, t) }) : t('nav.then')}
                <StepBadge step={step?.next} />
                {step?.next ? stepText(t, step.next) : t('nav.arriveAtDestination')}
              </Typography>
            </>
          )}
        </Paper>
        </Box>
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
          <Paper
            elevation={4}
            sx={{
              pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.5,
              borderRadius: 2,
              ...(preview ? { border: '2px solid var(--sim)' } : null),
            }}
          >
            <Typography variant="caption" sx={{ fontWeight: 700 }}>
              {preview ? t('preview.controls') : t('nav.devSim')}
            </Typography>
            <IconButton size="small" onClick={() => setPlaying((p) => !p)} aria-label={playing ? t('nav.pause') : t('nav.play')}>
              {playing ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
            </IconButton>
            <IconButton
              size="small"
              aria-label={t('nav.resetSim')}
              onClick={() => {
                setPlaying(false);
                setSimS(0);
                // In Preview, resetting must re-seed at the route start rather than clear the
                // position — clearing would drop the overlay back to "waiting for location", which
                // is exactly the dead end Preview exists to avoid.
                const p = preview && sim.path ? posAtS(sim.path, 0) : null;
                sim.onSim(p ? { lon: p.lon, lat: p.lat, accuracy: 5, heading: p.heading, speed: 0, ts: Date.now() } : null);
              }}
            >
              <ReplayIcon fontSize="small" />
            </IconButton>
            {preview ? (
              // Named presets rather than a metres-per-second slider: an end user is choosing a
              // playback pace, not calibrating a skier's speed.
              <ToggleButtonGroup
                size="small"
                exclusive
                value={speed}
                onChange={(_, v) => { if (v != null) setSpeed(v as number); }}
                sx={{ '& .MuiToggleButton-root': { textTransform: 'none', fontWeight: 700, py: 0.1, px: 1 } }}
              >
                <ToggleButton value={6}>{t('preview.slow')}</ToggleButton>
                <ToggleButton value={12}>{t('preview.normal')}</ToggleButton>
                <ToggleButton value={22}>{t('preview.fast')}</ToggleButton>
              </ToggleButtonGroup>
            ) : (
              <>
                <Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}>{t('units.mps', { value: speed })}</Typography>
                <Slider size="small" min={3} max={25} value={speed} onChange={(_, v) => setSpeed(v as number)} sx={{ width: 110 }} />
              </>
            )}
            {preview && sim.path && sim.path.totalM > 0 && (
              <Typography variant="caption" sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', minWidth: 34, textAlign: 'end' }}>
                {Math.min(100, Math.round((simS / sim.path.totalM) * 100))}%
              </Typography>
            )}
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
              <span className="ns-unit">{t('units.kmhShort')}</span>
            </div>
          )}
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {remaining ? (
              <Typography sx={{ fontWeight: 800, fontSize: 17 }} color={offRoute ? 'inherit' : 'primary.main'}>
                {t('nav.remaining', { distance: fmtDist(remaining.distM, t), time: fmtTime(remaining.timeS, t) })}
              </Typography>
            ) : (
              <Typography variant="body2" color={offRoute ? 'inherit' : 'text.secondary'}>
                {waiting ? t('nav.acquiringGps') : t('nav.enRoute')}
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
              {t('nav.reroute')}
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
            {t('nav.exit')}
          </Button>
        </Paper>
      </Box>
    </>
  );
}

