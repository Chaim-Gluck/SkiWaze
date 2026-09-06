import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { DisplayStep } from '../types/domain';
import type { LivePosition } from '../hooks/useLiveLocation';
import { posAtS, type RoutePath, type TurnDir } from '../routing/navigation';
import { tr, SHIELD_SLOT } from '../utils/text';
import { fmtClock } from '../utils/format';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Slider from '@mui/material/Slider';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ScienceIcon from '@mui/icons-material/Science';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import ReplayIcon from '@mui/icons-material/Replay';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import TurnSlightLeftIcon from '@mui/icons-material/TurnSlightLeft';
import TurnSlightRightIcon from '@mui/icons-material/TurnSlightRight';
import StraightIcon from '@mui/icons-material/Straight';
import AltRouteIcon from '@mui/icons-material/AltRoute';
import CloseIcon from '@mui/icons-material/Close';

interface StepInfo {
  current?: DisplayStep;
  next?: DisplayStep;
  distToNextM: number;
  turn?: TurnDir;
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
  sim?: {
    path: RoutePath | null;
    onSim: (p: LivePosition | null) => void;
    preview?: boolean;
    /** Modelled pace for the leg being played: see App's `simPace`. */
    pace?: { advanceMps: number; displayMps: number };
    /** Step boundaries, for "skip to next turn". See `stepTransitions`. */
    transitions?: { s: number; lenM: number }[];
  };
}

function fmtDist(m: number, t: TFunction): string {
  return m >= 1000
    ? t('units.km', { value: (m / 1000).toFixed(1) })
    : t('units.m', { value: Math.round(m / 10) * 10 });
}
/**
 * Distance to the next manoeuvre, split into number and unit so the banner can set them at
 * different sizes - the Waze idiom, where the number is the biggest thing on screen and the unit
 * is a small tag under it. Rounded exactly like `fmtDist` so the two never disagree.
 */
function splitDist(m: number, t: TFunction): { value: string; unit: string } {
  return m >= 1000
    ? { value: (m / 1000).toFixed(1), unit: t('units.short.km') }
    : { value: String(Math.round(m / 10) * 10), unit: t('units.short.metre') };
}
function fmtTime(s: number, t: TFunction): string {  const min = Math.round(s / 60);
  return min >= 60
    ? t('units.hourMin', { hours: Math.floor(min / 60), minutes: min % 60 })
    : t('units.min', { value: min });
}
/**
 * Banner text for a step, with the piste shield rendered INSIDE the sentence.
 *
 * Uses `labelBadge`, which drops the colour and puts `SHIELD_SLOT` where the slope number belongs
 * — so "Ski [89] Nambino" instead of an "89" shield sitting outside "Ski 89 · Nambino", which said
 * the number twice. The split is on the sentinel, never on a fixed offset or a word: the catalogue
 * owns the word order, and stripping display prose with a regex has bitten this file before.
 *
 * A step with no slot (a lift, a traverse) falls back to badge-then-text, which is why the badge is
 * emitted separately rather than assumed to be inline.
 */
function stepNodes(t: TFunction, st: DisplayStep | undefined, big?: boolean): ReactNode {
  if (!st) return '—';
  const text = tr(t, st.labelBadge);
  const i = text.indexOf(SHIELD_SLOT);
  if (i < 0) return <><StepBadge step={st} big={big} /> {text}</>;
  // Trim the catalogue's spaces around the slot and let the badge's own symmetric margins do the
  // spacing. A literal space on one side plus `margin-inline-end` on the other made the shield hug
  // the verb it follows instead of sitting between two words.
  const before = text.slice(0, i).replace(/\s+$/, '');
  const after = text.slice(i + SHIELD_SLOT.length).replace(/^\s+/, '');
  return <>{before}<StepBadge step={st} big={big} inline />{after}</>;
}

/**
 * Banner font size for a label of this length.
 *
 * A mapped name is data, not copy, and some of them are long ("Tapis Roulant Grostè Express -
 * Fortini"). Clamping to a fixed size and ellipsing hides the one fact the banner exists to
 * carry, so the type shrinks instead - the instruction stays whole and the card stays one height.
 */
function bannerFont(len: number): number {
  if (len > 46) return 15;
  if (len > 32) return 17;
  return 20;
}

const COLOR_HEX: Record<string, string> = {
  green: '#2e7d32', blue: '#1565c0', red: '#d32f2f', black: '#111111', unknown: '#ff9800',
};
/**
 * Manoeuvre-banner background. Fixed, not a theme token: this bar reads over the map tiles, which
 * do not change with the theme, so tying it to the light panel colour would make it unreadable in
 * exactly the conditions (bright snow) it is most needed.
 */
const NAV_BAR_BG = '#16233d';

/** How far before a manoeuvre "skip to next turn" drops you. */
const SKIP_LEAD_M = 50;

/**
 * Which way the route swings at the upcoming transition, drawn as a Waze-style manoeuvre arrow.
 *
 * This is the one element that says "this is ahead of you, not around you" without words, which is
 * why it leads the banner rather than the run's colour shield.
 *
 * Only three glyphs, and the turning pair are the *slight* ones - an arrow that goes up and then
 * bends. A square 90-degree glyph reads as an instruction to turn at a junction, which is not what
 * a piste does; the run simply bends, and the arrow only has to say which side.
 */
function TurnArrow({ turn }: { turn?: TurnDir }) {
  const sx = { fontSize: 34 } as const;
  if (turn === 'left') return <TurnSlightLeftIcon sx={sx} />;
  if (turn === 'right') return <TurnSlightRightIcon sx={sx} />;
  return <StraightIcon sx={sx} />;
}
/** First slope number in a run's mapped name ("50 · Ruggenhof" -> "50"), or null. */
function pisteNumber(name?: string): string | null {
  const m = name?.match(/(\d+)/);
  return m ? m[1] : null;
}
/** Waze-style piste "shield": colored badge with the slope number, a colored difficulty dot
 * when the piste has no number (common — many resorts don't number pistes), or a lift glyph. */
function StepBadge({ step, big, inline }: { step?: DisplayStep; big?: boolean; inline?: boolean }) {
  const { t } = useTranslation();
  if (!step) return null;
  const cls = `pbadge${big ? ' big' : ''}${inline ? ' inline' : ''}`;
  if (step.kind === 'lift') return <span className={`${cls} lift`} title={t('nav.liftBadge')}>🚡</span>;
  if (step.kind === 'connector') return null;
  const bg = COLOR_HEX[step.color ?? 'unknown'] ?? COLOR_HEX.unknown;
  const num = step.ref ?? pisteNumber(step.name);
  if (num) return <span className={cls} style={{ background: bg }}>{num}</span>;
  return <span className={`${big ? 'pdot big' : 'pdot'}${inline ? ' inline' : ''}`} style={{ background: bg }} title={step.color ? t(`color.${step.color}`) : t('nav.runBadge')} />;
}

export function NavOverlay({ step, remaining, speedMps, offRoute, waiting, onExit, onReroute, sim }: Props) {
  const { t } = useTranslation();
  const preview = !!sim?.preview;
  // Simulator state. DEV picks an absolute speed in metres per second from a slider, because that
  // is what the tool was built for. Preview instead picks a MULTIPLE of the skier's own modelled
  // pace, so "Normal" plays the route back at the speed the planner costed it at and the speed
  // circle shows the number a real run would show. A fixed 12 m/s dial is what made a red run
  // read 43 km/h for a skier whose model says 33.
  const [simS, setSimS] = useState(0);  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(12); // m/s (DEV)
  const [factor, setFactor] = useState(1); // x modelled pace (Preview)
  const pace = sim?.pace;
  const advanceMps = preview && pace ? pace.advanceMps * factor : speed;
  const displayMps = preview && pace ? pace.displayMps * factor : speed;

  // Where "skip to next turn" would land: `SKIP_LEAD_M` before the first step boundary still ahead
  // of us, clamped to that step's own start when the step is shorter than the lead. Null once every
  // remaining boundary is behind, which is what disables the button at the last step.
  const nextSkipS = useMemo(() => {
    for (const tr of sim?.transitions ?? []) {
      const target = tr.s - Math.min(SKIP_LEAD_M, tr.lenM);
      if (target > simS + 1) return target;
    }
    return null;
  }, [sim?.transitions, simS]);

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
        const ns = s + advanceMps * dt;
        const p = posAtS(sim.path!, ns);
        if (p) sim.onSim({ lon: p.lon, lat: p.lat, accuracy: 5, heading: p.heading, speed: displayMps, ts: Date.now() });
        if (ns >= (sim.path?.totalM ?? 0)) setPlaying(false);
        return ns;
      });
    }, dt * 1000);
    return () => window.clearInterval(id);
  }, [playing, advanceMps, displayMps, sim]);

  return (
    <>
      {/* Top: manoeuvre banner. Full-bleed and flush to the top edge, Waze-style, rather than a
          floating rounded card - a card with gutters wastes the width where the one number a
          moving skier needs has to be biggest.

          Deliberately fixed dark navy rather than `background.paper`: this reads over the map
          tiles, not over the panel, and the map does not change with the theme (same rule as the
          other MapLibre-coupled visuals in the style guide). */}
      <Box
        sx={{
          position: 'absolute', left: 0, right: 0, top: 0, zIndex: 5,
          display: 'flex', flexDirection: 'column', alignItems: 'center', pointerEvents: 'none',
        }}
      >
        <Paper
          elevation={8}
          sx={{
            pointerEvents: 'auto', width: '100%', maxWidth: 640,
            borderRadius: '0 0 18px 18px', overflow: 'hidden',
            bgcolor: offRoute ? 'error.main' : NAV_BAR_BG,
            color: '#fff',
          }}
        >
          <Box sx={{ px: 2, py: 1.25 }}>
          {waiting ? (
            <Typography sx={{ fontWeight: 800, fontSize: 18 }}>{t('nav.waitingLocation')}</Typography>
          ) : offRoute ? (
            <>
              <Typography sx={{ fontWeight: 800, fontSize: 18 }}>⚠ {t('nav.offRoute')}</Typography>
              <Typography variant="body2">{t('nav.offRouteHint')}</Typography>
            </>
          ) : (
            /* The banner answers "what do I do next, and how far away is it" - so the manoeuvre
               is the NEXT step and the distance to it is the largest thing on screen. The run you
               are currently on is context, not instruction, so it drops to the quiet strip below,
               which is where Waze puts the street you are on.

               Size alone was not enough to say "this is ahead of you" - the two lines looked like
               peers. The turn arrow and the explicit "Next" label are what make the hierarchy
               readable without decoding it from the font size. */
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              {/* "NEXT" captions the manoeuvre column, not the row: it labels the arrow and the
                  distance (the "this is ahead of you" part), while the sentence beside it is the
                  instruction itself. On its own row it cost banner height; at the row's start it
                  read as a label on the run name. */}
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 62, flexShrink: 0 }}>
                <Typography
                  variant="caption"
                  sx={{ fontWeight: 800, opacity: 0.5, letterSpacing: 1, textTransform: 'uppercase', lineHeight: 1.2 }}
                >
                  {t('nav.next')}
                </Typography>
                <TurnArrow turn={step?.turn} />
                {step && step.distToNextM > 5 && (
                  <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.4 }}>
                    <Typography sx={{ fontWeight: 900, fontSize: 26, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
                      {splitDist(step.distToNextM, t).value}
                    </Typography>
                    <Typography sx={{ fontSize: 13, fontWeight: 700, opacity: 0.75 }}>
                      {splitDist(step.distToNextM, t).unit}
                    </Typography>
                  </Box>
                )}
              </Box>
              <Typography
                sx={{
                  flex: 1, minWidth: 0, fontWeight: 800,
                  fontSize: bannerFont(step?.next ? tr(t, step.next.labelBadge).length : 0),
                  lineHeight: 1.3,
                  display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                }}
              >
                {step?.next ? stepNodes(t, step.next, true) : t('nav.arriveAtDestination')}
              </Typography>
            </Box>
          )}
          </Box>
        </Paper>

        {/* Non-dismissable: a simulated position must never be mistakable for a real one. */}
        {preview && (
          <Paper
            elevation={6}
            sx={{
              pointerEvents: 'none', mt: 1, px: 1.5, py: 0.4, borderRadius: 5,
              bgcolor: 'var(--sim)', color: '#1a1200', display: 'flex', alignItems: 'center', gap: 0.75,
            }}
          >
            <ScienceIcon fontSize="small" />
            <Typography variant="caption" sx={{ fontWeight: 800, letterSpacing: 0.2 }}>
              {t('preview.banner')}
            </Typography>
          </Paper>
        )}
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
              pointerEvents: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexWrap: 'wrap', rowGap: 0.5, columnGap: 0.75, px: 1, py: 0.5,
              maxWidth: '100%', borderRadius: 2,
              ...(preview ? { border: '2px solid var(--sim)' } : null),
            }}
          >
            {/* No "Preview" caption here: the amber chip under the banner already says it, and the
                word was the single widest item in a strip that has to fit a phone. DEV keeps its
                label, because there is no chip in that path. */}
            {!preview && (
              <Typography variant="caption" sx={{ fontWeight: 700 }}>{t('nav.devSim')}</Typography>
            )}
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
            {/* Skip to the next manoeuvre. Lands `SKIP_LEAD_M` short of it rather than on it, so the
                thing you skipped forward to watch is still ahead of you when playback resumes; on a
                step shorter than that lead it lands at the step's own start instead, which is the
                closest it can get without going backwards. */}
            {sim.transitions && sim.transitions.length > 0 && (
              <Tooltip title={t('preview.skipTurn')}>
                <span>
                  <IconButton
                    size="small"
                    aria-label={t('preview.skipTurn')}
                    disabled={!nextSkipS}
                    onClick={() => {
                      if (nextSkipS == null || !sim.path) return;
                      setSimS(nextSkipS);
                      const p = posAtS(sim.path, nextSkipS);
                      if (p) sim.onSim({ lon: p.lon, lat: p.lat, accuracy: 5, heading: p.heading, speed: playing ? displayMps : 0, ts: Date.now() });
                    }}
                  >
                    <SkipNextIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            )}
            {preview ? (
              // Named presets rather than a metres-per-second slider: an end user is choosing a
              // playback pace, not calibrating a skier's speed.
              <ToggleButtonGroup
                size="small"
                exclusive
                value={factor}
                onChange={(_, v) => { if (v != null) setFactor(v as number); }}
                sx={{ '& .MuiToggleButton-root': { textTransform: 'none', fontWeight: 700, py: 0.1, px: 0.9, fontSize: 12 } }}
              >
                <ToggleButton value={0.6}>{t('preview.slow')}</ToggleButton>
                <ToggleButton value={1}>{t('preview.normal')}</ToggleButton>
                <ToggleButton value={1.8}>{t('preview.fast')}</ToggleButton>
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
        {/* The bottom card is the STATUS card: where you are, and when you get there. The manoeuvre
            banner above it is the INSTRUCTION card and carries nothing else, so a glance up answers
            exactly one question. The run you are on is reference, not instruction, which is why it
            lives down here beside the ETA rather than under the arrow. */}
        <Paper
          elevation={8}
          sx={{
            pointerEvents: 'auto', width: 'min(560px, 94%)', borderRadius: 3,
            position: 'relative', overflow: 'hidden',
            display: 'flex', flexDirection: 'column',
            bgcolor: offRoute ? 'error.main' : 'background.paper',
            color: offRoute ? 'error.contrastText' : 'text.primary',
          }}
        >
          {!waiting && !offRoute && step?.current && (
            <Box
              sx={{
                px: 1.75, py: 0.5, bgcolor: 'action.hover',
                display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0,
              }}
            >
              <Typography variant="caption" sx={{ fontWeight: 700, opacity: 0.7, flexShrink: 0 }}>
                {t('nav.now')}
              </Typography>
              {/* Wrap to two lines rather than ellipsing. A lift's mapped name is routinely long
                  ("Tapis Roulant Grostè Express - Fortini") and it is the one fact this band
                  exists to carry, so cutting it to "Tapis Rou..." fails at its only job. */}
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 600, minWidth: 0, overflow: 'hidden',
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                }}
              >
                {stepNodes(t, step.current)}
              </Typography>
            </Box>
          )}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 1.75, py: 1, pr: 4.5 }}>
          {!waiting && speedMps != null && speedMps >= 0 && (
            <div className="nav-speed-circle">
              <span className="ns-num">{Math.round(speedMps * 3.6)}</span>
              <span className="ns-unit">{t('units.kmhShort')}</span>
            </div>
          )}
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {remaining ? (
              <>
                {/* Distance and countdown belong on ONE line - they are two readings of the same
                    fact - and the clock arrival gets its own line below, because it answers a
                    different question: "22 min left" is a duration, "14:05" is something you
                    compare against a lift closing time or a lunch booking. */}
                <Typography
                  sx={{ fontWeight: 800, fontSize: 17, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                  color={offRoute ? 'inherit' : 'primary.main'}
                >
                  {t('nav.remaining', { distance: fmtDist(remaining.distM, t), time: fmtTime(remaining.timeS, t) })}
                </Typography>
                <Typography variant="caption" color={offRoute ? 'inherit' : 'text.secondary'} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                  {t('preview.eta', { time: fmtClock(new Date(Date.now() + remaining.timeS * 1000).toISOString()) })}
                </Typography>
              </>
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
          {/* Icon only, in the corner: a labelled button the width of "Exit" sat in the middle of
              the bar and squeezed the remaining-distance line into a wrap. The word survives in the
              tooltip and the aria-label, so nothing is lost to a screen reader. Bottom corner, not
              top, because the "Now" band owns the top edge. */}
          <Tooltip title={t('nav.exit')}>
            <IconButton
              size="small"
              aria-label={t('nav.exit')}
              onClick={onExit}
              sx={{
                position: 'absolute', bottom: 4, insetInlineEnd: 4,
                color: offRoute ? 'error.contrastText' : 'text.secondary',
              }}
            >
              <CloseIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
          </Box>
        </Paper>
      </Box>
    </>
  );
}

