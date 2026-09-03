import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';

/**
 * "Arrive by" time entry, rendered entirely by us.
 *
 * This replaced `<TextField type="datetime-local">`. A native datetime input hands the popup to the
 * browser, and that popup is chrome we cannot reach: it is drawn in the OS/browser locale rather
 * than the app's, so a Hebrew user got an English calendar, and no theme or CSS of ours applies to
 * it. Anything the user must read has to be React we render.
 *
 * The date is gone with it, deliberately. You plan an arrival while standing on the mountain, so
 * the answer is always today — or, when the time you pick has already passed, tomorrow. A day
 * field would be a control nobody sets.
 */
export function ArriveTimePicker({
  value,
  onChange,
}: {
  /** A `datetime-local` string (`YYYY-MM-DDTHH:mm`). Kept as the wire format so the planner call sites are untouched. */
  value: string;
  onChange: (next: string) => void;
}) {
  const { t } = useTranslation();

  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const [datePart = '', timePart = ''] = value.split('T');
  const hh = Number(timePart.slice(0, 2));
  const mm = Number(timePart.slice(3, 5));
  const hour = Number.isFinite(hh) ? hh : 12;
  const minute = Number.isFinite(mm) ? mm : 0;

  /** Resolve an hour:minute to the next time it actually occurs, so a past time means tomorrow. */
  const atClock = (h: number, m: number) => {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return stamp(d);
  };

  const fromNow = (mins: number) => onChange(stamp(new Date(Date.now() + mins * 60000)));

  const isTomorrow = datePart !== stamp(new Date()).slice(0, 10);

  // 5-minute steps are the useful granularity, but the value can arrive off-grid (the default is
  // now + 1 h, and the quick chips are relative to the clock). Keep such a minute as an option
  // rather than silently snapping the user's choice to something they did not pick.
  const minutes = Array.from({ length: 12 }, (_, i) => i * 5);
  if (!minutes.includes(minute)) minutes.push(minute);
  minutes.sort((a, b) => a - b);

  return (
    <Box sx={{ mt: 1 }}>
      {/* The row follows the reading direction, so in Hebrew it starts on the right like the chips
          below it — only the HH:MM pair inside is pinned LTR, because a clock reads the same way in
          every language. Nesting is what separates the two concerns: pinning the whole row also
          left-aligned it. "Tomorrow" is outside the pin, so it lands after the clock either way. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box dir="ltr" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <TextField
            select
            size="small"
            label={t('app.plan.hour')}
            value={hour}
            onChange={(e) => onChange(atClock(Number(e.target.value), minute))}
            sx={{ width: 96 }}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <MenuItem key={h} value={h}>
                {pad(h)}
              </MenuItem>
            ))}
          </TextField>
          <Typography sx={{ fontWeight: 700, color: 'text.secondary' }}>:</Typography>
          <TextField
            select
            size="small"
            label={t('app.plan.minute')}
            value={minute}
            onChange={(e) => onChange(atClock(hour, Number(e.target.value)))}
            sx={{ width: 96 }}
          >
            {minutes.map((m) => (
              <MenuItem key={m} value={m}>
                {pad(m)}
              </MenuItem>
            ))}
          </TextField>
        </Box>
        {/* Sits on the clock row, not under the chips: it qualifies the time you just picked. The
            selects are a fixed width so this appearing never reflows them. */}
        {isTomorrow && (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t('app.plan.tomorrow')}
          </Typography>
        )}
      </Box>

      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 1 }}>
        <Chip size="small" variant="outlined" label={t('app.plan.plus30')} onClick={() => fromNow(30)} />
        <Chip size="small" variant="outlined" label={t('app.plan.plus1h')} onClick={() => fromNow(60)} />
        <Chip size="small" variant="outlined" label={t('app.plan.plus2h')} onClick={() => fromNow(120)} />
      </Box>
    </Box>
  );
}
