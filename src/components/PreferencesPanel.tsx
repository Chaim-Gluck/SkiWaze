import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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

const COLORS: PisteColor[] = ['green', 'blue', 'red', 'black'];
const SKILL_LEVELS: SkillLevel[] = ['cautious', 'average', 'advanced', 'expert'];
const SLOPE_HEX: Record<PisteColor, string> = {
  green: '#2e7d32', blue: '#1565c0', red: '#d32f2f', black: '#222', unknown: '#ff9800',
};

interface Props {
  prefs: Preferences;
  onChange: (p: Preferences) => void;
}

export function PreferencesPanel({ prefs, onChange }: Props) {
  const { t } = useTranslation();
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
  const toggleLift = (lt: LiftType) => {
    const has = prefs.allowedLiftTypes.includes(lt);
    onChange({
      ...prefs,
      allowedLiftTypes: has ? prefs.allowedLiftTypes.filter((x) => x !== lt) : [...prefs.allowedLiftTypes, lt],
    });
  };

  return (
    <Box>
      <TextField
        select size="small" fullWidth label={t('prefs.routeType')} sx={{ mb: 1.5 }}
        value={prefs.routeType ?? 'balanced'}
        onChange={(e) => onChange({ ...prefs, routeType: e.target.value as RouteType })}
        helperText={t(`prefs.routeTypeHelp.${prefs.routeType ?? 'balanced'}`)}
      >
        {ROUTE_TYPES.map((rt) => <MenuItem key={rt} value={rt}>{t(`prefs.routeTypeLabel.${rt}`)}</MenuItem>)}
      </TextField>

      <TextField
        select size="small" fullWidth label={t('prefs.maxDifficulty')} sx={{ mb: 1.5 }}
        value={prefs.maxDifficulty}
        onChange={(e) => setMaxDifficulty(e.target.value as PisteColor)}
      >
        {COLORS.map((c) => <MenuItem key={c} value={c}>{t(`color.${c}`)}</MenuItem>)}
      </TextField>

      <TextField
        select size="small" fullWidth label={t('prefs.skillLevel')} sx={{ mb: 2 }}
        value={prefs.skillLevel}
        onChange={(e) => onChange({ ...prefs, skillLevel: e.target.value as SkillLevel })}
      >
        {SKILL_LEVELS.map((s) => <MenuItem key={s} value={s}>{t(`prefs.skill.${s}`)}</MenuItem>)}
      </TextField>

      <Box sx={{ mb: 2, mt: -0.5 }}>
        <Link component="button" type="button" variant="caption" underline="hover" onClick={() => setShowSpeedHelp((v) => !v)}>
          {showSpeedHelp ? t('prefs.hide') : t('prefs.speedHelpLink')}
        </Link>
        <Collapse in={showSpeedHelp}>
          <Box sx={{ mt: 0.75, p: 1, bgcolor: 'action.hover', borderRadius: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {t('prefs.speedHelpBody')}
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.75 }}>
              {SPEED_COLORS.map((c) => (
                <Chip key={c} size="small" variant="outlined"
                  label={t('prefs.speedChip', { color: t(`color.${c}`), value: Math.round(trueSpeedMps(c, prefs.skillLevel) * 3.6) })} />
              ))}
            </Box>
            {prefs.useMeasuredSpeeds && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                {t('prefs.usingMeasured')}
              </Typography>
            )}
          </Box>
        </Collapse>
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>{t('prefs.preferredColors')}</Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 2 }}>
        {COLORS.map((c) => {
          const on = prefs.preferredColors.includes(c);
          return (
            <Chip
              key={c}
              label={t(`color.${c}`)}
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
          {t('prefs.liftTypes', { used: prefs.allowedLiftTypes.length, total: ALL_LIFT_TYPES.length })} {showLiftTypes ? '▲' : '▼'}
        </Link>
        <Collapse in={showLiftTypes}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 0.75 }}>
            {ALL_LIFT_TYPES.map((lt) => {
              const on = prefs.allowedLiftTypes.includes(lt);
              return (
                <Chip
                  key={lt} label={t(`liftType.${lt}`)} onClick={() => toggleLift(lt)} size="small"
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
        label={<Typography variant="body2">{t('prefs.avoidBridges')}</Typography>}
      />
      <FormControlLabel
        control={<Checkbox size="small" checked={prefs.allowOffPiste}
          onChange={(e) => onChange({ ...prefs, allowOffPiste: e.target.checked })} />}
        label={<Typography variant="body2">{t('prefs.allowOffPiste')}</Typography>}
      />
      <FormControlLabel
        control={<Checkbox size="small" checked={prefs.preferSkiing}
          onChange={(e) => onChange({ ...prefs, preferSkiing: e.target.checked })} />}
        label={<Typography variant="body2">{t('prefs.preferSkiing')}</Typography>}
      />
    </Box>
  );
}

