import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLanguage } from '../i18n/language-context';
import Paper from '@mui/material/Paper';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import LegendToggleIcon from '@mui/icons-material/LegendToggle';

const SWATCH: Record<string, Record<string, unknown>> = {
  'piste-multi': { height: 3, width: 22, borderRadius: '2px', background: 'linear-gradient(90deg,#2e7d32 0 25%,#1565c0 25% 50%,#d32f2f 50% 75%,#111 75% 100%)' },
  'piste-unrated': { height: 3, width: 22, borderRadius: '2px', background: '#ff9800' },
  'piste-offpiste': { width: 22, borderTop: '3px dashed #111' },
  lift: { width: 22, borderTop: '3px dashed #7b1fa2' },
  connector: { width: 22, borderTop: '3px dashed #00bfa5' },
  synthetic: { width: 22, borderTop: '3px dashed #e040fb' },
  custom: { width: 22, borderTop: '3px dashed #00e5ff' },
  route: { height: 4, width: 22, background: '#ffe082', borderRadius: '3px', boxShadow: '0 0 5px 1px #ffe082' },
};

const ROWS: string[] = [
  'piste-multi',
  'piste-unrated',
  'piste-offpiste',
  'lift',
  'connector',
  'synthetic',
  'custom',
  'route',
];

export function Legend() {
  const { t } = useTranslation();
  // The map shell is pinned LTR; this panel is prose, so it asks for the reading direction back.
  const { rtl } = useLanguage();
  const dir = rtl ? 'rtl' : 'ltr';
  const [open, setOpen] = useState(false);
  return (
    <Paper
      elevation={3}
      dir={dir}
      sx={{
        p: 0.75, borderRadius: 2,
        maxWidth: 240, bgcolor: 'var(--glass)', backdropFilter: 'blur(3px)',
      }}
    >
      {!open ? (
        <IconButton size="small" onClick={() => setOpen(true)} aria-label={t('legend.show')} title={t('legend.title')}>
          <LegendToggleIcon fontSize="small" />
        </IconButton>
      ) : (
        <>
          {/* Header pinned LTR: the close X sits on the panel's top-left corner, where the collapsed
              icon was, so opening and closing is one thumb position in every language. */}
          <Box dir="ltr" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 0.5 }}>
            <IconButton size="small" onClick={() => setOpen(false)} aria-label={t('legend.collapse')} sx={{ p: 0.25 }}>
              <CloseIcon fontSize="small" />
            </IconButton>
            <Typography dir={dir} variant="caption" sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <LegendToggleIcon fontSize="small" /> {t('legend.title')}
            </Typography>
          </Box>
          <Box sx={{ mt: 0.5 }}>
            {ROWS.map((row) => (
              <Box key={row} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                <Box component="span" sx={{ flex: '0 0 auto', ...SWATCH[row] }} />
                <Typography variant="caption">{t(`legend.rows.${row}`)}</Typography>
              </Box>
            ))}
          </Box>
        </>
      )}
    </Paper>
  );
}

