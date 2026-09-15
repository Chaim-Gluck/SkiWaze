import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { DisplayStep } from '../types/domain';
import type { LivePosition } from '../hooks/useLiveLocation';
import { posAtS, type RoutePath, type TurnDir } from '../routing/navigation';
import { tr, SHIELD_SLOT } from '../utils/text';
import { fmtClock } from '../utils/format';
import { COLOR_HEX as NAV_COLOR_HEX } from './navChip';
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
  if (len > 46) return 14;
  if (len > 32) return 16;
  return 18;
}

const COLOR_HEX = NAV_COLOR_HEX;
/**
 * Background for the WHOLE nav overlay - manoeuvre banner, ETA card and speed dial alike. Fixed,
 * not a theme token: these read over the map tiles, which do not change with the theme, so tying
 * them to the light panel colour would make them unreadable in exactly the conditions (bright snow)
 * they are most needed. The overlay was previously half-converted - the banner fixed, the card and
 * the dial following `background.paper` - which in light mode left one dark card beside a white one.
 * Defined in App.css so the CSS-styled dial shares the one definition.
 */
const NAV_BAR_BG = 'var(--nav-bar)';
/** Secondary text on the same background. Replaces `text.secondary`, which inverts with the theme. */
const NAV_BAR_MUTED = 'rgba(255,255,255,0.72)';

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
  const sx = { fontSize: 28 } as const;
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
  const { t, i18n } = useTranslation();
  // The bottom bar is pinned to the physical corners in EVERY language (see the split-corner
  // comment below), so the two elements need a direction-aware `flexDirection` rather than the
  // inherited RTL row order. `direction: 'ltr'` is NOT an option: stylis-plugin-rtl rewrites it
  // to `rtl` and produces the exact opposite of what it says.
  const rtl = i18n.dir() === 'rtl';
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

  // Publish where the manoeuvre card ENDS, so the map's own controls (Layers, Legend) can sit level
  // with the simulation chip beside it rather than below the whole overlay.
  //
  // Two things are deliberate. It is measured, not assumed: the card is one to three lines depending
  // on how long the run's name is, so a constant would be wrong most of the time. And it publishes
  // the card's BOTTOM EDGE relative to its offset parent, not its height - reconstructing the edge
  // from a height means adding back the overlay's own top inset, which is an assumption about a
  // layout constant living in another component, and it is silently wrong the moment either side is
  // repadded. `.map-shell` and `.map-wrap` are both `position: relative` and coincide, so the
  // resulting y is in the same frame the map's controls are positioned in.
  const bannerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bannerRef.current;
    const root = document.documentElement;
    if (!el) return;
    const publish = () => {
      const parent = el.offsetParent as HTMLElement | null;
      const top = parent ? parent.getBoundingClientRect().top : 0;
      root.style.setProperty('--nav-banner-h', `${Math.round(el.getBoundingClientRect().bottom - top)}px`);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    window.addEventListener('resize', publish);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', publish);
      root.style.removeProperty('--nav-banner-h');
    };
  }, []);


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
          px: 1, pt: 1,
          // On desktop there is width to spare, so the card gives it back to the map's own controls
          // rather than displacing them: it is capped narrower and the gutters are SYMMETRIC, both
          // sized to clear the wider of the two columns (Layers/Legend at left, the Fab column at
          // right). Reserving only what each side actually needs would centre the card in the free
          // space rather than on the map, and it read as visibly off-centre. Phones have no such
          // room, which is why the controls drop below the card there instead (see MapView).
          '@media (min-width: 821px)': { px: '260px' },
        }}
      >
        {/* A floating card, inset on all four sides rather than flush to the top edge. Full-bleed
            read as chrome and sat on top of the map's own controls; an inset card lets a sliver of
            map show past every corner, which is what tells the eye it is an overlay and leaves the
            controls beside it reachable. */}
        <Paper
          ref={bannerRef}
          elevation={8}
          sx={{
            pointerEvents: 'auto', width: '100%', maxWidth: 620,
            '@media (min-width: 821px)': { maxWidth: 460 },
            borderRadius: 3, overflow: 'hidden',
            bgcolor: offRoute ? 'error.main' : NAV_BAR_BG,
            color: '#fff',
          }}
        >
          <Box sx={{ px: 1.75, py: 0.6 }}>
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
               are currently on is context, not instruction, so it lives on the chip under the
               arrow on the map, which is where Waze puts the street you are on.

               There is no "NEXT" caption: the turn arrow already says "this is ahead of you", so
               the word was a label restating its own glyph, and it cost the column the width of
               five uppercase letters. Size alone was never the thing carrying the hierarchy - the
               arrow is. */
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              {/* A fixed `minWidth` even though the caption is gone: it keeps the manoeuvre column
                  a stable width, so the instruction beside it does not shift sideways every time
                  the distance goes from "1.2 km" to "90 m". */}
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 62, flexShrink: 0 }}>
                <TurnArrow turn={step?.turn} />
                {step && step.distToNextM > 5 && (
                  <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.4 }}>
                    <Typography className="num-hero" sx={{ fontWeight: 900, fontSize: 22, lineHeight: 1.05, fontVariantNumeric: 'tabular-nums' }}>
                      {splitDist(step.distToNextM, t).value}
                    </Typography>
                    <Typography sx={{ fontSize: 11, fontWeight: 700, opacity: 0.75 }}>
                      {splitDist(step.distToNextM, t).unit}
                    </Typography>
                  </Box>
                )}
              </Box>
              {/* Half-height hairline, not a full-height Divider: it separates the manoeuvre column
                  from the instruction without drawing a box around either. Logical-flow only - the
                  row reverses under RTL and the rule travels with it. */}
              <Box sx={{ alignSelf: 'center', width: '1px', height: 32, bgcolor: 'rgba(255,255,255,0.18)', flexShrink: 0 }} />
              <Typography
                sx={{
                  flex: 1, minWidth: 0, fontWeight: 800, textAlign: 'center',
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
              pointerEvents: 'none', mt: 0.75, px: 0.9, py: 0.15, borderRadius: 5,
              bgcolor: 'var(--sim)', color: '#1a1200', display: 'flex', alignItems: 'center', gap: 0.4,
            }}
          >
            <ScienceIcon sx={{ fontSize: 13 }} />
            <Typography sx={{ fontWeight: 700, fontSize: 10.5, letterSpacing: 0.1, lineHeight: 1.4 }}>
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
              // Tighter than the cards around it: this is a transient control surface, not a
              // reading, so it should take the least width it can and give the map back.
              flexWrap: 'wrap', rowGap: 0.25, columnGap: 0.25, px: 0.5, py: 0.25,
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
        {/* The bar is SPLIT into the two bottom corners: the speed dial free-standing at the
            bottom-left, the remaining/ETA card at the bottom-right, with the middle of the screen
            left clear. That middle is where the skier's own arrow and its current-run chip sit, so
            a full-width bar across the bottom covers exactly the part of the map the rider is
            skiing into. Two consequences: the dial needs `.standalone` (an opaque fill and a
            shadow, because over bare snow or satellite imagery the translucent version has nothing
            behind it), and the hairline that used to separate the two is gone - they are now two
            separate objects with air between them, so a rule between them would be drawing a
            boundary that the layout already states.
            Pinned to the PHYSICAL corners in every language, hence `flexDirection` rather than the
            inherited RTL row order: left/right here are positions on the map, not reading order,
            and a Hebrew skier's speed does not belong on the other side of the screen from an
            English one's. */}
        {/* Speed dial stays pinned to the bottom-LEFT corner; the ETA card is CENTRED. The two
            flanking slots are the same fixed width, which is what puts the card dead centre under
            `space-between` - centring it with `justifyContent: 'center'` instead would make it
            drift as soon as the dial appears or disappears. */}
        <Box
          sx={{
            width: '100%', display: 'flex', flexDirection: rtl ? 'row-reverse' : 'row',
            alignItems: 'flex-end', justifyContent: 'space-between', gap: 1,
          }}
        >
          {!waiting && speedMps != null && speedMps >= 0 ? (
            <div className="nav-speed-circle standalone">
              <span className="ns-num">{Math.round(speedMps * 3.6)}</span>
              <span className="ns-unit">{t('units.kmhShort')}</span>
            </div>
          ) : (
            // An empty slot of the SAME width, not a conditional: the card is centred by the two
            // flanks being equal, so a zero-width slot here would shove it off centre the moment
            // the dial is absent (waiting for a fix, or no speed yet). Tracks `.nav-speed-circle`'s
            // width in App.css - change both together or the card stops being centred.
            <Box sx={{ width: 48, flexShrink: 0 }} />
          )}
        <Paper
          elevation={8}
          sx={{
            pointerEvents: 'auto', minWidth: 0, maxWidth: '100%', borderRadius: 3,
            // Centred now, so no corner-parity nudge: that extra inline margin existed only to make
            // the card look level with the dial when both sat in opposite corners.
            mb: 0.5,
            position: 'relative', overflow: 'hidden',
            display: 'flex', flexDirection: 'column',
            bgcolor: offRoute ? 'error.main' : NAV_BAR_BG,
            color: offRoute ? 'error.contrastText' : '#fff',
          }}
        >
          {/* Exit is an absolutely positioned corner icon, not a row of its own: a dedicated band
              for one control costs the card as much height as the reading it exists to show. Icon
              only - a labelled button the width of "Exit" squeezed the remaining-distance line into
              a wrap. The word survives in the tooltip and the aria-label. `insetInlineEnd` so it
              follows the document direction under RTL. */}
          <Tooltip title={t('nav.exit')}>
            <IconButton
              size="small"
              aria-label={t('nav.exit')}
              onClick={onExit}
              sx={{
                // Vertically CENTRED, not pinned to the corner: since the "Now" strip moved up to
                // the manoeuvre card this Paper is a single row, and a top-corner X on a one-row
                // card reads as jammed into the edge rather than as belonging to the row. It stays
                // at the inline end so it is still out of the reading path, and `insetInlineEnd`
                // keeps it following the document direction under RTL.
                position: 'absolute', top: '50%', transform: 'translateY(-50%)',
                // Physically right in both directions, because the card is pinned to the RIGHT
                // corner in both: the X must sit on the screen edge, never on the side facing the
                // middle of the map. Under RTL `insetInlineStart` IS the physical right.
                ...(rtl ? { insetInlineStart: 9 } : { insetInlineEnd: 9 }),
                zIndex: 1, p: 0.75,
                color: offRoute ? 'error.contrastText' : NAV_BAR_MUTED,
              }}
            >
              <CloseIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
          {/* Padding on the card's physical right clears the corner button so a long remaining/ETA
              line cannot run under it. */}
          {/* Roomier than the manoeuvre card's padding on purpose. This card is a free-standing
              object in a corner rather than a full-width band, so its text has an edge on BOTH
              sides: 20px of air at the reading end, and 52px at the other so the arrival clock
              never crowds the ✕. */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 2.5, py: 0.6, ...(rtl ? { paddingInlineStart: 6.5 } : { paddingInlineEnd: 6.5 }) }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {remaining ? (
              <>
                {/* ARRIVAL CLOCK ON TOP. It is the reading you act on: "19:47" is what you compare
                    against a lift closing time or a lunch booking, while "36 min left" is the same
                    fact expressed relative to now and only tells you how long to keep going.
                    Distance and countdown share the line below - they are two readings of one
                    thing, so splitting them would say there are three facts here. */}
                {/* 700, not 800. Hebrew is capped at 600 by the `:lang(he)` weight rule, so the
                    two languages were rendering this line 200 apart and only the English one read
                    as shouting - worst on "ETA", which is all-caps and so carries no descenders or
                    lowercase to break up the mass. Dropping to 700 closes most of that gap and
                    leaves Hebrew untouched, since the cap still catches it. */}
                {/* Colours go through `sx`, not the `color` prop. On this card the prop lost to the
                    Paper's own inherited `color: #fff` and both lines rendered plain white - which
                    is why the accent this line used to carry was dead code for as long as it
                    existed. The clock takes the card's plain white: `#4aa8ff` on this navy is ~3.4:1,
                    under the body-text bar and read in glare on snow, and blue already means
                    "interactive" everywhere else in the app. Size and weight already separate it
                    from the caption below, so colour had no job left to do. */}
                <Typography
                  sx={{
                    fontWeight: 700, fontSize: 16, lineHeight: 1.25, whiteSpace: 'nowrap',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {t('preview.eta', { time: fmtClock(new Date(Date.now() + remaining.timeS * 1000).toISOString()) })}
                </Typography>
                <Typography variant="caption" sx={{ display: 'block', lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: offRoute ? 'inherit' : NAV_BAR_MUTED }}>
                  {t('nav.remaining', { distance: fmtDist(remaining.distM, t), time: fmtTime(remaining.timeS, t) })}
                </Typography>
              </>
            ) : (
              <Typography variant="body2" sx={{ color: offRoute ? 'inherit' : NAV_BAR_MUTED }}>
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
          </Box>
        </Paper>
        {/* Balances the speed dial so the card lands dead centre. Always present, even when the
            dial is not, because the dial's slot is held open too. Width tracks `.nav-speed-circle`
            in App.css. */}
        <Box sx={{ width: 48, flexShrink: 0 }} />
        </Box>
      </Box>
    </>
  );
}

