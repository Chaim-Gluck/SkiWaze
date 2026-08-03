import type { MeasuredSpeeds, SpeedColor } from '../state/measuredSpeeds';
import { measuredAverages } from '../state/measuredSpeeds';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Divider from '@mui/material/Divider';

const COLORS: SpeedColor[] = ['green', 'blue', 'red', 'black'];
const LABEL: Record<SpeedColor, string> = { green: 'Green', blue: 'Blue', red: 'Red', black: 'Black' };
const SLOPE_HEX: Record<SpeedColor, string> = { green: '#2e7d32', blue: '#1565c0', red: '#d32f2f', black: '#222' };

interface Props {
  measured: MeasuredSpeeds;
  estimatedByColor: Record<SpeedColor, number>;
  minSamples: number;
  onApply: () => void;
  onReset: () => void;
}

/** Shows the skier's own measured average speed per color (recorded live while navigating). */
export function MeasuredSpeedsPanel({ measured, estimatedByColor, minSamples, onApply, onReset }: Props) {
  const avg = measuredAverages(measured, minSamples);
  const ready = Object.keys(avg).length > 0;

  return (
    <Box sx={{ mt: 2 }}>
      <Divider sx={{ mb: 1.5 }} />
      <Typography sx={{ fontWeight: 700, mb: 0.5 }}>My measured speeds</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Your real GPS pace vs the current estimate. Apply to use your measured speeds for time estimates.
      </Typography>
      <Table size="small" sx={{ '& td, & th': { px: 1, py: 0.5 } }}>
        <TableHead>
          <TableRow>
            <TableCell>Colour</TableCell>
            <TableCell align="right">Estimated</TableCell>
            <TableCell align="right">Measured</TableCell>
            <TableCell align="right">Samples</TableCell>
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
                  <Chip size="small" label={LABEL[c]} sx={{ bgcolor: SLOPE_HEX[c], color: '#fff', fontWeight: 600, height: 20, border: '1px solid rgba(128,128,128,0.5)' }} />
                </TableCell>
                <TableCell align="right"><Typography variant="body2" color="text.secondary">{est} km/h</Typography></TableCell>
                <TableCell align="right"><Typography variant="body2" sx={{ fontWeight: enough ? 700 : 400 }}>{kmh != null ? `${kmh} km/h` : '—'}</Typography></TableCell>
                <TableCell align="right"><Typography variant="body2">{b.count}{enough ? ' ✓' : ''}</Typography></TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <Box sx={{ display: 'flex', gap: 1, mt: 1.5 }}>
        <Button variant="contained" size="small" disabled={!ready} onClick={onApply}>Use my measured speeds</Button>
        <Button variant="outlined" size="small" color="inherit" onClick={onReset}>Reset</Button>
      </Box>
      {!ready && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          Ski at least {minSamples} seconds on a color while navigating to unlock it.
        </Typography>
      )}
    </Box>
  );
}

