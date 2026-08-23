import { fmtDistance } from '../utils/format';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import IconButton from '@mui/material/IconButton';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import MapIcon from '@mui/icons-material/Map';
import MyLocationIcon from '@mui/icons-material/MyLocation';
import DownhillSkiingIcon from '@mui/icons-material/DownhillSkiing';

export interface LongestRunView {
  distanceM: number;
  descentM: number;
  startName: string;
  endName: string;
  /** True when the run crosses a pipeline-inferred gap-fill, which may not be truly skiable. */
  usesInferred?: boolean;
}

interface Props {
  runs: LongestRunView[] | null;
  index: number;
  onFind: () => void;
  onPrev: () => void;
  onNext: () => void;
  onShowOnMap: () => void;
  onNavigateStart: () => void;
  onNavigateEnd: () => void;
}

export function LongestRunPanel({
  runs,
  index,
  onFind,
  onPrev,
  onNext,
  onShowOnMap,
  onNavigateStart,
  onNavigateEnd,
}: Props) {
  const run = runs && runs.length ? runs[index] : null;
  const total = runs?.length ?? 0;

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        The longest possible descents without taking a lift (top to bottom), for your level.
      </Typography>
      <Button variant="outlined" fullWidth onClick={onFind}>
        Find the longest runs
      </Button>

      {run && (
        <Box sx={{ mt: 1.5 }}>
          {total > 1 && (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, mb: 0.5 }}>
              <IconButton size="small" onClick={onPrev} aria-label="Previous run"><ChevronLeftIcon /></IconButton>
              <Typography variant="body2" color="text.secondary">#{index + 1} of {total} longest</Typography>
              <IconButton size="small" onClick={onNext} aria-label="Next run"><ChevronRightIcon /></IconButton>
            </Box>
          )}
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
            <Typography variant="h5" sx={{ fontWeight: 700 }}>{fmtDistance(run.distanceM)}</Typography>
            <Typography variant="body2" color="text.secondary">⬇ {fmtDistance(run.descentM)} descent</Typography>
          </Box>
          <Typography variant="body2" sx={{ my: 0.5 }}>
            <Box component="span" sx={{ color: 'success.main', fontWeight: 600 }}>{run.startName}</Box>
            {' → '}
            <Box component="span" sx={{ color: 'error.main', fontWeight: 600 }}>{run.endName}</Box>
          </Typography>
          {run.usesInferred && (
            <Alert severity="warning" sx={{ py: 0, my: 0.5 }}>
              Uses an app-added bridge (dotted magenta) — verify it's actually skiable
            </Alert>
          )}
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
            <Button size="small" variant="outlined" startIcon={<MapIcon />} onClick={onShowOnMap}>Show on map</Button>
            <Button size="small" variant="outlined" startIcon={<MyLocationIcon />} onClick={onNavigateStart}>To start</Button>
            <Button size="small" variant="outlined" startIcon={<DownhillSkiingIcon />} onClick={onNavigateEnd}>To end</Button>
          </Box>
        </Box>
      )}
    </Box>
  );
}

