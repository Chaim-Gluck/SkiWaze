import { useState } from 'react';
import type { LiftType, PisteColor, Preferences, SkillLevel, RouteType } from '../types/domain';
import { ALL_LIFT_TYPES } from '../config/defaults';
import { trueSpeedMps, type SpeedColor } from '../config/speedModel';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Link from '@mui/material/Link';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';

const ROUTE_TYPES: RouteType[] = ['balanced', 'fastest', 'fewest_lifts', 'preferred', 'longest'];
const ROUTE_TYPE_LABEL: Record<RouteType, string> = {
  balanced: 'Balanced (one of each)',
  fastest: 'Fastest',
  fewest_lifts: 'Fewest lifts',
  preferred: 'My preferred runs',
  longest: 'Longest run',
};
const ROUTE_TYPE_HELP: Record<RouteType, string> = {
  balanced: 'One best route for each goal — fastest, fewest lifts, and so on.',
  fastest: 'Your 3 quickest options.',
  fewest_lifts: '3 options that ride the fewest lifts.',
  preferred: '3 options that stay on your preferred colours.',
  longest: 'The 3 longest lift-free runs to your destination.',
};

const COLORS: PisteColor[] = ['green', 'blue', 'red', 'black'];
const SKILL_LEVELS: SkillLevel[] = ['cautious', 'average', 'advanced', 'expert'];
const SKILL_LABEL: Record<SkillLevel, string> = {
  cautious: 'Cautious', average: 'Average', advanced: 'Advanced', expert: 'Expert',
};
const COLOR_LABEL: Record<PisteColor, string> = {
  green: 'Green', blue: 'Blue', red: 'Red', black: 'Black', unknown: 'Unknown',
};
const SLOPE_HEX: Record<PisteColor, string> = {
  green: '#2e7d32', blue: '#1565c0', red: '#d32f2f', black: '#222', unknown: '#ff9800',
};
const LIFT_LABEL: Record<LiftType, string> = {
  gondola: 'Gondola', cable_car: 'Cable car', funicular: 'Funicular', chair_lift: 'Chair lift',
  t_bar: 'T-bar', drag_lift: 'Drag lift', platter: 'Platter', rope_tow: 'Rope tow',
  magic_carpet: 'Magic carpet', mixed_lift: 'Mixed lift', unknown: 'Unknown',
};

interface Props {
  prefs: Preferences;
  onChange: (p: Preferences) => void;
}

export function PreferencesPanel({ prefs, onChange }: Props) {
  const [showSpeedHelp, setShowSpeedHelp] = useState(false);
  const [showLiftTypes, setShowLiftTypes] = useState(false);
  const SPEED_COLORS: SpeedColor[] = ['green', 'blue', 'red', 'black'];
  // Preferred colors are a CONTIGUOUS difficulty band (green<blue<red<black) — no gaps. Clicking
  // a color outside the band extends it (filling any gap); clicking one inside shrinks the band
  // from whichever end it's nearer. Never clears the last color.
  const toggleColor = (c: PisteColor) => {
    const idx = COLORS.indexOf(c);
    const sel = COLORS.map((x, i) => (prefs.preferredColors.includes(x) ? i : -1)).filter((i) => i >= 0);
    let lo: number;
    let hi: number;
    if (sel.length === 0) {
      lo = idx;
      hi = idx;
    } else {
      const mn = Math.min(...sel);
      const mx = Math.max(...sel);
      if (idx < mn) { lo = idx; hi = mx; }               // extend down (fills a gap)
      else if (idx > mx) { lo = mn; hi = idx; }           // extend up (fills a gap)
      else if (mn === mx) return;                          // clicking the only color: keep it
      else if (idx - mn <= mx - idx) { lo = idx + 1; hi = mx; } // shrink from the easy end
      else { lo = mn; hi = idx - 1; }                      // shrink from the hard end
    }
    onChange({ ...prefs, preferredColors: COLORS.slice(lo, hi + 1) });
  };

  // Lowering max ability clamps the preferred band to what you can still ski (drops harder
  // colours). Raising it never auto-adds colours. Keeps the band contiguous.
  const setMaxDifficulty = (max: PisteColor) => {
    const maxIdx = COLORS.indexOf(max);
    const sel = COLORS.map((x, i) => (prefs.preferredColors.includes(x) ? i : -1)).filter((i) => i >= 0);
    let preferredColors = prefs.preferredColors;
    if (sel.length) {
      const lo = Math.min(Math.min(...sel), maxIdx);
      const hi = Math.min(Math.max(...sel), maxIdx);
      preferredColors = COLORS.slice(lo, hi + 1);
    }
    onChange({ ...prefs, maxDifficulty: max, preferredColors });
  };
  const toggleLift = (t: LiftType) => {
    const has = prefs.allowedLiftTypes.includes(t);
    onChange({
      ...prefs,
      allowedLiftTypes: has ? prefs.allowedLiftTypes.filter((x) => x !== t) : [...prefs.allowedLiftTypes, t],
    });
  };

  return (
    <Box>
      <TextField
        select size="small" fullWidth label="Find route: what matters most" sx={{ mb: 1.5 }}
        value={prefs.routeType ?? 'balanced'}
        onChange={(e) => onChange({ ...prefs, routeType: e.target.value as RouteType })}
        helperText={ROUTE_TYPE_HELP[prefs.routeType ?? 'balanced']}
      >
        {ROUTE_TYPES.map((t) => <MenuItem key={t} value={t}>{ROUTE_TYPE_LABEL[t]}</MenuItem>)}
      </TextField>

      <TextField
        select size="small" fullWidth label="Max difficulty I can handle" sx={{ mb: 1.5 }}
        value={prefs.maxDifficulty}
        onChange={(e) => setMaxDifficulty(e.target.value as PisteColor)}
      >
        {COLORS.map((c) => <MenuItem key={c} value={c}>{COLOR_LABEL[c]}</MenuItem>)}
      </TextField>

      <TextField
        select size="small" fullWidth label="My skiing speed" sx={{ mb: 2 }}
        value={prefs.skillLevel}
        onChange={(e) => onChange({ ...prefs, skillLevel: e.target.value as SkillLevel })}
      >
        {SKILL_LEVELS.map((s) => <MenuItem key={s} value={s}>{SKILL_LABEL[s]}</MenuItem>)}
      </TextField>

      <Box sx={{ mb: 2, mt: -0.5 }}>
        <Link component="button" type="button" variant="caption" underline="hover" onClick={() => setShowSpeedHelp((v) => !v)}>
          {showSpeedHelp ? 'Hide' : 'How are times estimated?'}
        </Link>
        <Collapse in={showSpeedHelp}>
          <Box sx={{ mt: 0.75, p: 1, bgcolor: 'action.hover', borderRadius: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              We estimate your real speed on each run colour, then add the extra distance your turns
              create — steeper runs mean more turns — so times reflect real skiing, not a straight line.
              Your "skiing speed" above tunes it (better skiers keep more speed on steep runs).
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.75 }}>
              {SPEED_COLORS.map((c) => (
                <Chip key={c} size="small" variant="outlined"
                  label={`${COLOR_LABEL[c]} ~${Math.round(trueSpeedMps(c, prefs.skillLevel) * 3.6)} km/h`} />
              ))}
            </Box>
            {prefs.useMeasuredSpeeds && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                Currently using your measured speeds.
              </Typography>
            )}
          </Box>
        </Collapse>
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>Preferred slope colors</Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 2 }}>
        {COLORS.map((c) => {
          const on = prefs.preferredColors.includes(c);
          return (
            <Chip
              key={c}
              label={COLOR_LABEL[c]}
              onClick={() => toggleColor(c)}
              size="small"
              variant={on ? 'filled' : 'outlined'}
              color={on ? 'primary' : 'default'}
              icon={
                <Box
                  component="span"
                  sx={{
                    width: 12,
                    height: 12,
                    borderRadius: '50%',
                    ml: 0.75,
                    bgcolor: SLOPE_HEX[c],
                    border: '1px solid rgba(128,128,128,0.7)',
                    flexShrink: 0,
                  }}
                />
              }
              sx={{ fontWeight: 600 }}
            />
          );
        })}
      </Box>

      <Box sx={{ mb: 1 }}>
        <Link component="button" type="button" variant="body2" underline="hover" color="text.secondary"
          onClick={() => setShowLiftTypes((v) => !v)}
          sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          Lift types I'll use ({prefs.allowedLiftTypes.length}/{ALL_LIFT_TYPES.length}) {showLiftTypes ? '▲' : '▼'}
        </Link>
        <Collapse in={showLiftTypes}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 0.75 }}>
            {ALL_LIFT_TYPES.map((t) => {
              const on = prefs.allowedLiftTypes.includes(t);
              return (
                <Chip
                  key={t} label={LIFT_LABEL[t]} onClick={() => toggleLift(t)} size="small"
                  color={on ? 'primary' : 'default'} variant={on ? 'filled' : 'outlined'}
                />
              );
            })}
          </Box>
        </Collapse>
      </Box>

      <FormControlLabel
        control={<Checkbox size="small" checked={prefs.avoidSyntheticBridges}
          onChange={(e) => onChange({ ...prefs, avoidSyntheticBridges: e.target.checked })} />}
        label={<Typography variant="body2">Avoid app-added bridges (dotted magenta gap-fills)</Typography>}
      />
      <FormControlLabel
        control={<Checkbox size="small" checked={prefs.preferSkiing}
          onChange={(e) => onChange({ ...prefs, preferSkiing: e.target.checked })} />}
        label={<Typography variant="body2">Prefer skiing (avoid riding lifts downhill)</Typography>}
      />
    </Box>
  );
}

