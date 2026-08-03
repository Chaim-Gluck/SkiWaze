import type { LiftType, PisteColor, Preferences, SkillLevel } from '../types/domain';
import { ALL_LIFT_TYPES } from '../config/defaults';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';

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
  const toggleColor = (c: PisteColor) => {
    const has = prefs.preferredColors.includes(c);
    onChange({
      ...prefs,
      preferredColors: has ? prefs.preferredColors.filter((x) => x !== c) : [...prefs.preferredColors, c],
    });
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
        select size="small" fullWidth label="Max difficulty I can handle" sx={{ mb: 1.5 }}
        value={prefs.maxDifficulty}
        onChange={(e) => onChange({ ...prefs, maxDifficulty: e.target.value as PisteColor })}
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

      <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>Lift types I'll use</Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 1 }}>
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

