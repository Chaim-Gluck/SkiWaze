import { useTranslation } from 'react-i18next';
import { useLanguage } from '../i18n/language-context';
import { fmtDistance } from '../utils/format';
import type { LongestRunView } from './LongestRunPanel';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import DownhillSkiingIcon from '@mui/icons-material/DownhillSkiing';
import MyLocationIcon from '@mui/icons-material/MyLocation';

interface Props {
  runs: LongestRunView[];
  index: number;
  onPrev: () => void;
  onNext: () => void;
  onDetails: () => void;
  onDismiss: () => void;
  onNavigateStart: () => void;
  onSki: () => void;
  bottom: number | string;
}

/**
 * Floating summary of the selected Longest run, mirroring `RoutePreview`.
 *
 * "Show on map" hides the controls sheet on mobile, so without this card the chosen run becomes an
 * anonymous highlight — the user can see a line but not which of the three it is, how long it is,
 * or where it ends. Keeping the identity on screen is the whole point of jumping to the map.
 */
export function LongestPreview({ runs, index, onPrev, onNext, onDetails, onDismiss, onNavigateStart, onSki, bottom }: Props) {
  const { t } = useTranslation();
  const { rtl } = useLanguage();
  const run = runs[index];
  if (!run) return null;
  const total = runs.length;

  return (
    <Paper
      elevation={8}
      sx={{
        position: 'absolute', left: '50%', transform: 'translateX(-50%)',
        bottom, zIndex: 6, width: 'min(560px, 94%)', p: 1.25, borderRadius: 3,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        {/* Chevrons are direction glyphs, not layout: in Hebrew "previous" points right. */}
        <IconButton size="small" onClick={onPrev} disabled={total < 2} aria-label={t('longest.prev')}>
          {rtl ? <ChevronRightIcon /> : <ChevronLeftIcon />}
        </IconButton>
        <Typography variant="caption" sx={{ fontWeight: 700, flex: 1, textAlign: 'center' }}>
          {t('longest.position', { index: index + 1, total })}
        </Typography>
        <IconButton size="small" onClick={onNext} disabled={total < 2} aria-label={t('longest.next')}>
          {rtl ? <ChevronLeftIcon /> : <ChevronRightIcon />}
        </IconButton>
        <IconButton size="small" onClick={onDismiss} aria-label={t('common.dismiss')}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.25, flexWrap: 'wrap', mt: 0.25 }}>
        <Typography sx={{ fontWeight: 800 }} variant="h6">{fmtDistance(run.distanceM)}</Typography>
        <Typography variant="body2" color="text.secondary">
          ⬇ {t('longest.descent', { distance: fmtDistance(run.descentM) })}
        </Typography>
      </Box>

      <Typography variant="body2" sx={{ my: 0.5 }}>
        <Box component="span" sx={{ color: 'success.main', fontWeight: 600 }}>{run.startName}</Box>
        {' → '}
        <Box component="span" sx={{ color: 'error.main', fontWeight: 600 }}>{run.endName}</Box>
      </Typography>

      {run.usesInferred && (
        <Typography variant="caption" color="warning.main" sx={{ display: 'block', mb: 0.5 }}>
          {t('longest.inferredWarning')}
        </Typography>
      )}

      {/* Both journeys belong here, and "to the start" is usually the FIRST one a skier needs: you
          are somewhere else on the mountain and have to reach the top of the run before you can ski
          it. "To end" stays the primary action because it is the one that replays this exact chain
          rather than re-planning. */}
      <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
        <Button
          variant="outlined"
          color="inherit"
          onClick={onDetails}
          sx={{ flex: '0 0 auto', textTransform: 'none', borderColor: 'divider', color: 'text.secondary' }}
        >
          {t('preview.details')}
        </Button>
        <Button
          variant="outlined"
          startIcon={<MyLocationIcon />}
          onClick={onNavigateStart}
          sx={{ flex: 1, minWidth: 120, textTransform: 'none', fontWeight: 700 }}
        >
          {t('longest.toStart')}
        </Button>
        <Button
          variant="contained"
          startIcon={<DownhillSkiingIcon />}
          onClick={onSki}
          sx={{ flex: 1, minWidth: 120, textTransform: 'none', fontWeight: 700 }}
        >
          {t('longest.toEnd')}
        </Button>
      </Box>
    </Paper>
  );
}
