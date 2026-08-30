import { useState } from 'react';
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

const ROWS: { swatch: string; label: string }[] = [
  { swatch: 'piste-multi', label: 'Piste: green / blue / red / black' },
  { swatch: 'piste-unrated', label: 'Unrated / connection piste' },
  { swatch: 'piste-offpiste', label: 'Off-piste / freeride — unpatrolled (toggle on)' },
  { swatch: 'lift', label: 'Lift (up; gondolas also down)' },
  { swatch: 'connector', label: 'Flat link / cat-track (real)' },
  { swatch: 'synthetic', label: 'App-added bridge (verify)' },
  { swatch: 'custom', label: 'Your custom link' },
  { swatch: 'route', label: 'Selected route (glows)' },
];

export function Legend() {
  const [open, setOpen] = useState(false);
  return (
    <Paper
      elevation={3}
      sx={{
        p: 0.75, borderRadius: 2,
        maxWidth: 240, bgcolor: 'var(--glass)', backdropFilter: 'blur(3px)',
      }}
    >
      {!open ? (
        <IconButton size="small" onClick={() => setOpen(true)} aria-label="Show legend" title="Legend">
          <LegendToggleIcon fontSize="small" />
        </IconButton>
      ) : (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="caption" sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <LegendToggleIcon fontSize="small" /> Legend
            </Typography>
            <IconButton size="small" onClick={() => setOpen(false)} aria-label="Collapse legend" sx={{ p: 0.25 }}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Box>
          <Box sx={{ mt: 0.5 }}>
            {ROWS.map((r) => (
              <Box key={r.swatch} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                <Box component="span" sx={{ flex: '0 0 auto', ...SWATCH[r.swatch] }} />
                <Typography variant="caption">{r.label}</Typography>
              </Box>
            ))}
          </Box>
        </>
      )}
    </Paper>
  );
}

