import { useState } from 'react';
import Paper from '@mui/material/Paper';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import LayersIcon from '@mui/icons-material/Layers';

const SWATCH: Record<string, Record<string, unknown>> = {
  'piste-multi': { height: 3, width: 22, borderRadius: '2px', background: 'linear-gradient(90deg,#1565c0 0 33%,#d32f2f 33% 66%,#111 66% 100%)' },
  lift: { width: 22, borderTop: '3px dashed #7b1fa2' },
  connector: { width: 22, borderTop: '3px dashed #00bfa5' },
  synthetic: { width: 22, borderTop: '3px dashed #e040fb' },
  custom: { width: 22, borderTop: '3px dashed #00e5ff' },
  route: { height: 4, width: 22, background: '#ffe082', borderRadius: '3px', boxShadow: '0 0 5px 1px #ffe082' },
};

const ROWS: { swatch: string; label: string }[] = [
  { swatch: 'piste-multi', label: 'Piste: blue / red / black' },
  { swatch: 'lift', label: 'Lift (up; gondolas also down)' },
  { swatch: 'connector', label: 'Flat link / cat-track (real)' },
  { swatch: 'synthetic', label: 'App-added bridge (verify)' },
  { swatch: 'custom', label: 'Your custom link' },
  { swatch: 'route', label: 'Selected route (glows)' },
];

export function Legend() {
  const [open, setOpen] = useState(true);
  return (
    <Paper
      elevation={3}
      sx={{
        position: 'absolute', bottom: 12, left: 12, zIndex: 5, p: 0.75, borderRadius: 2,
        maxWidth: 240, bgcolor: 'var(--glass)', backdropFilter: 'blur(3px)',
      }}
    >
      <Button
        size="small"
        onClick={() => setOpen((v) => !v)}
        startIcon={open ? <CloseIcon fontSize="small" /> : <LayersIcon fontSize="small" />}
        sx={{ fontWeight: 700, minWidth: 0, py: 0.25 }}
      >
        Legend
      </Button>
      {open && (
        <Box sx={{ mt: 0.5 }}>
          {ROWS.map((r) => (
            <Box key={r.swatch} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
              <Box component="span" sx={{ flex: '0 0 auto', ...SWATCH[r.swatch] }} />
              <Typography variant="caption">{r.label}</Typography>
            </Box>
          ))}
        </Box>
      )}
    </Paper>
  );
}

