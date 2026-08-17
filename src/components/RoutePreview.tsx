import type { Route } from '../types/domain';
import { fmtDistance, fmtDuration } from '../utils/format';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import CloseIcon from '@mui/icons-material/Close';

const SLOPE_HEX: Record<string, string> = {
  green: '#2e7d32', blue: '#1565c0', red: '#d32f2f', black: '#222', unknown: '#ff9800', none: '#ff9800',
};

interface Props {
  routes: Route[];
  selectedIndex: number;
  onSelect: (i: number) => void;
  onStart: () => void;
  onDetails: () => void;
  onDismiss: () => void;
  bottom: number | string;
}

/**
 * Waze-style route preview shown over the map after "Find routes": switch between the options and
 * start navigation without digging into the controls sheet/sidebar. Positioned absolutely inside
 * the map area so it centres over the map on both desktop and mobile.
 */
export function RoutePreview({ routes, selectedIndex, onSelect, onStart, onDetails, onDismiss, bottom }: Props) {
  const n = routes.length;
  const r = routes[selectedIndex];
  if (!r) return null;
  const s = r.stats;
  const colorParts = Object.entries(s.colorBreakdownM).filter(([, m]) => (m ?? 0) > 0);
  const usesLiftDownhill = r.legs.some((l) => l.kind === 'lift' && l.isDownload);
  const cycle = (d: number) => onSelect((selectedIndex + d + n) % n);

  return (
    <Paper
      elevation={8}
      sx={{
        position: 'absolute', left: '50%', transform: 'translateX(-50%)',
        bottom, zIndex: 6, width: 'min(560px, 94%)', p: 1.25, borderRadius: 3,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <IconButton size="small" onClick={() => cycle(-1)} disabled={n < 2} aria-label="Previous option">
          <ChevronLeftIcon />
        </IconButton>
        <Typography variant="caption" sx={{ fontWeight: 700, flex: 1, textAlign: 'center' }}>
          Option {selectedIndex + 1} of {n}
        </Typography>
        <IconButton size="small" onClick={() => cycle(1)} disabled={n < 2} aria-label="Next option">
          <ChevronRightIcon />
        </IconButton>
        <IconButton size="small" onClick={onDismiss} aria-label="Dismiss">
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.25, flexWrap: 'wrap', mt: 0.25 }}>
        <Typography sx={{ fontWeight: 800 }} variant="h6">{fmtDuration(s.totalDurationS)}</Typography>
        <Typography variant="body2" color="text.secondary">{fmtDistance(s.totalDistanceM)}</Typography>
        <Typography variant="body2" color="text.secondary">🚠 {s.liftCount} lift{s.liftCount === 1 ? '' : 's'}</Typography>
        {r.labels && r.labels.length > 0 && (
          <Box sx={{ ml: 'auto', display: 'flex', gap: 0.5, flexWrap: 'wrap', justifyContent: 'flex-end', alignSelf: 'center' }}>
            {r.labels.map((label) => (
              <Chip key={label} size="small" color="primary" variant="outlined" label={label} sx={{ height: 20 }} />
            ))}
          </Box>
        )}
      </Box>

      {colorParts.length > 0 && (
        <Box sx={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', mt: 0.75 }}>
          {colorParts.map(([c, m]) => (
            <Box key={c} sx={{ flex: m ?? 0, bgcolor: SLOPE_HEX[c] ?? '#ff9800' }} title={`${c}: ${fmtDistance(m ?? 0)}`} />
          ))}
        </Box>
      )}

      {usesLiftDownhill && (
        <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 0.5 }}>
          🚠⬇ This route rides a lift downhill
        </Typography>
      )}

      <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
        <Button variant="outlined" color="inherit" onClick={onDetails} sx={{ flex: '0 0 auto', textTransform: 'none', borderColor: 'divider', color: 'text.secondary' }}>
          Details
        </Button>
        <Button variant="contained" color="success" startIcon={<PlayArrowIcon />} onClick={onStart} sx={{ flex: 1, textTransform: 'none', fontWeight: 700 }}>
          Start
        </Button>
      </Box>
    </Paper>
  );
}
