import type { LiftType, PisteColor, Preferences } from '../types/domain';
import { ALL_LIFT_TYPES } from '../config/defaults';

const COLORS: PisteColor[] = ['green', 'blue', 'red', 'black'];
const COLOR_LABEL: Record<PisteColor, string> = {
  green: 'Green', blue: 'Blue', red: 'Red', black: 'Black', unknown: 'Unknown',
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
      preferredColors: has
        ? prefs.preferredColors.filter((x) => x !== c)
        : [...prefs.preferredColors, c],
    });
  };
  const toggleLift = (t: LiftType) => {
    const has = prefs.allowedLiftTypes.includes(t);
    onChange({
      ...prefs,
      allowedLiftTypes: has
        ? prefs.allowedLiftTypes.filter((x) => x !== t)
        : [...prefs.allowedLiftTypes, t],
    });
  };

  return (
    <div className="panel">
      <h3>Skiing preferences</h3>

      <label className="field">
        <span>Max difficulty I can handle</span>
        <select
          value={prefs.maxDifficulty}
          onChange={(e) => onChange({ ...prefs, maxDifficulty: e.target.value as PisteColor })}
        >
          {COLORS.map((c) => (
            <option key={c} value={c}>{COLOR_LABEL[c]}</option>
          ))}
        </select>
      </label>

      <div className="field">
        <span>Preferred slope colors</span>
        <div className="chips">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`chip color-${c} ${prefs.preferredColors.includes(c) ? 'on' : ''}`}
              onClick={() => toggleColor(c)}
            >
              {COLOR_LABEL[c]}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span>Lift types I'll use</span>
        <div className="chips">
          {ALL_LIFT_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              className={`chip ${prefs.allowedLiftTypes.includes(t) ? 'on' : ''}`}
              onClick={() => toggleLift(t)}
            >
              {LIFT_LABEL[t]}
            </button>
          ))}
        </div>
      </div>

      <label className="check-field">
        <input
          type="checkbox"
          checked={prefs.avoidSyntheticBridges}
          onChange={(e) => onChange({ ...prefs, avoidSyntheticBridges: e.target.checked })}
        />
        <span>Avoid app-added bridges (dotted magenta gap-fills)</span>
      </label>

      <label className="check-field">
        <input
          type="checkbox"
          checked={prefs.preferSkiing}
          onChange={(e) => onChange({ ...prefs, preferSkiing: e.target.checked })}
        />
        <span>Prefer skiing (avoid riding lifts downhill)</span>
      </label>
    </div>
  );
}
