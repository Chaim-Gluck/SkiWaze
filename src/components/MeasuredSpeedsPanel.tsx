import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MeasuredSpeeds, SpeedColor } from '../state/measuredSpeeds';
import { measuredAverages } from '../state/measuredSpeeds';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Link from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Divider from '@mui/material/Divider';

const COLORS: SpeedColor[] = ['green', 'blue', 'red', 'black'];
const SLOPE_HEX: Record<SpeedColor, string> = { green: '#2e7d32', blue: '#1565c0', red: '#d32f2f', black: '#222' };

interface Props {
  measured: MeasuredSpeeds;
  estimatedByColor: Record<SpeedColor, number>;
  minSamples: number;
  onApply: () => void;
  onReset: () => void;
}

/**
 * Shows the skier's own measured average speed per color (recorded live while navigating).
 *
 * Collapsed by default: this is a diagnostics readout, not a filter, and for a skier who has not
 * navigated yet every row reads "—". Left open it was 375px of the Preferences section's 825px —
 * on a phone that alone pushed the sheet past every height it could have.
 */
export function MeasuredSpeedsPanel({ measured, estimatedByColor, minSamples, onApply, onReset }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const avg = measuredAverages(measured, minSamples);
  const ready = Object.keys(avg).length > 0;

  return (
    <Box sx={{ mt: 2 }}>
      <Divider sx={{ mb: 1 }} />
      <Link
        component="button" type="button" underline="hover" color="inherit"
        onClick={() => setOpen((v) => !v)}
        sx={{ display: 'flex', alignItems: 'center', gap: 0.5, fontWeight: 700 }}
      >
        {t('speeds.title')} {open ? '▲' : '▼'}
      </Link>
      <Collapse in={open}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1, mt: 0.5 }}>
        {t('speeds.intro')}
      </Typography>
      <Table size="small" sx={{ '& td, & th': { px: 1, py: 0.5 } }}>
        <TableHead>
          <TableRow>
            <TableCell>{t('speeds.colour')}</TableCell>
            <TableCell align="right">{t('speeds.estimated')}</TableCell>
            <TableCell align="right">{t('speeds.measured')}</TableCell>
            <TableCell align="right">{t('speeds.samples')}</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {COLORS.map((c) => {
            const b = measured.byColor?.[c] ?? { sum: 0, count: 0 };
            const kmh = b.count > 0 ? Math.round((b.sum / b.count) * 3.6) : null;
            const est = Math.round(estimatedByColor[c] * 3.6);
            const enough = b.count >= minSamples;
            return (
              <TableRow key={c}>
                <TableCell>
                  <Chip size="small" label={t(`color.${c}`)} sx={{ bgcolor: SLOPE_HEX[c], color: '#fff', fontWeight: 600, height: 20, border: '1px solid rgba(128,128,128,0.5)' }} />
                </TableCell>
                <TableCell align="right"><Typography variant="body2" color="text.secondary">{t('units.kmh', { value: est })}</Typography></TableCell>
                <TableCell align="right"><Typography variant="body2" sx={{ fontWeight: enough ? 700 : 400 }}>{kmh != null ? t('units.kmh', { value: kmh }) : '—'}</Typography></TableCell>
                <TableCell align="right"><Typography variant="body2">{b.count}{enough ? ' ✓' : ''}</Typography></TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <Box sx={{ display: 'flex', gap: 1, mt: 1.5 }}>
        <Button variant="contained" size="small" disabled={!ready} onClick={onApply}>{t('speeds.apply')}</Button>
        <Button variant="outlined" size="small" color="inherit" onClick={onReset}>{t('speeds.reset')}</Button>
      </Box>
      {!ready && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          {t('speeds.unlockHint', { count: minSamples })}
        </Typography>
      )}
      </Collapse>
    </Box>
  );
}

