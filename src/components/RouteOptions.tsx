import { useState } from 'react';
import type { Route } from '../types/domain';
import { fmtClock, fmtDistance, fmtDuration } from '../utils/format';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import IconButton from '@mui/material/IconButton';
import BlockIcon from '@mui/icons-material/Block';

const ROUTE_COLORS = ['#ff9800', '#3949ab', '#00897b'];
const SLOPE_HEX: Record<string, string> = {
  green: '#2e7d32', blue: '#1565c0', red: '#d32f2f', black: '#222', unknown: '#ff9800', none: '#ff9800',
};

interface Props {
  routes: Route[];
  selectedIndex: number;
  onSelect: (i: number) => void;
  selectedRange: [number, number] | null;
  onStepClick: (routeIndex: number, fromLeg: number, toLeg: number) => void;
  onMarkClosed: (key: string, label: string) => void;
}

export function RouteOptions({ routes, selectedIndex, onSelect, selectedRange, onStepClick, onMarkClosed }: Props) {
  return (
    <Box>
      {routes.map((r, i) => (
        <RouteCard
          key={r.id}
          route={r}
          index={i}
          color={ROUTE_COLORS[i % ROUTE_COLORS.length]}
          selected={i === selectedIndex}
          selectedRange={i === selectedIndex ? selectedRange : null}
          onSelect={() => onSelect(i)}
          onStepClick={onStepClick}
          onMarkClosed={onMarkClosed}
        />
      ))}
    </Box>
  );
}

function RouteCard({
  route, index, color, selected, selectedRange, onSelect, onStepClick, onMarkClosed,
}: {
  route: Route;
  index: number;
  color: string;
  selected: boolean;
  selectedRange: [number, number] | null;
  onSelect: () => void;
  onStepClick: (routeIndex: number, fromLeg: number, toLeg: number) => void;
  onMarkClosed: (key: string, label: string) => void;
}) {
  const [showSteps, setShowSteps] = useState(false);
  const s = route.stats;
  const colorParts = Object.entries(s.colorBreakdownM).filter(([, m]) => (m ?? 0) > 0);
  const usesLiftDownhill = route.legs.some((l) => l.kind === 'lift' && l.isDownload);
  const usesInferred = route.legs.some((l) => l.synthetic && !l.custom);
  const usesCustom = route.legs.some((l) => l.custom);

  return (
    <Paper
      variant="outlined"
      onClick={onSelect}
      sx={{
        p: 1.25, mb: 1, cursor: 'pointer', borderRadius: 2,
        borderColor: selected ? 'primary.main' : 'divider',
        borderWidth: selected ? 2 : 1,
        bgcolor: selected ? 'action.selected' : 'background.paper',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box sx={{ width: 14, height: 14, borderRadius: '4px', bgcolor: color, flexShrink: 0 }} />
        <Typography sx={{ fontWeight: 700 }} variant="h6">{fmtDuration(s.totalDurationS)}</Typography>
        <Typography variant="body2" color="text.secondary">{fmtDistance(s.totalDistanceM)}</Typography>
        {route.labels && route.labels.length > 0 && (
          <Box sx={{ ml: 'auto', display: 'flex', gap: 0.5, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {route.labels.map((label) => (
              <Chip key={label} size="small" color="primary" variant="outlined" label={label} sx={{ height: 20 }} />
            ))}
          </Box>
        )}
      </Box>

      {usesLiftDownhill && <Alert severity="warning" icon={false} sx={{ py: 0, my: 0.5 }}>🚠⬇ This route rides a lift downhill</Alert>}
      {usesInferred && <Alert severity="warning" sx={{ py: 0, my: 0.5 }}>Uses an app-added bridge (dotted magenta) — verify it's actually skiable</Alert>}
      {usesCustom && <Alert severity="info" icon={false} sx={{ py: 0, my: 0.5 }}>★ Uses one of your custom links (dotted cyan)</Alert>}

      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, mt: 0.75 }}>
        <Typography variant="body2">⬇ {fmtDistance(s.descentM)} descent</Typography>
        <Typography variant="body2">🚠 {s.liftCount} lift{s.liftCount === 1 ? '' : 's'}</Typography>
        <Typography variant="body2">🎿 longest run {fmtDistance(s.longestDownhillStreakM)}</Typography>
      </Box>

      {colorParts.length > 0 && (
        <Box sx={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', mt: 0.75 }}>
          {colorParts.map(([c, m]) => (
            <Box key={c} sx={{ flex: m ?? 0, bgcolor: SLOPE_HEX[c] ?? '#ff9800' }} title={`${c}: ${fmtDistance(m ?? 0)}`} />
          ))}
        </Box>
      )}

      {(s.startTime || s.arriveTime) && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
          Depart <Box component="span" sx={{ fontWeight: 700, color: 'text.primary' }}>{fmtClock(s.startTime)}</Box>
          {' → arrive '}
          <Box component="span" sx={{ fontWeight: 700, color: 'text.primary' }}>{fmtClock(s.arriveTime)}</Box>
        </Typography>
      )}

      {route.warnings.length > 0 && (
        <Box component="ul" sx={{ pl: 2, my: 0.5 }}>
          {route.warnings.slice(0, 4).map((w, i) => (
            <Typography key={i} component="li" variant="body2" color={w.code === 'lift_closing_soon' ? 'error' : 'warning.main'}>
              {w.message}
            </Typography>
          ))}
        </Box>
      )}

      <Button size="small" onClick={(e) => { e.stopPropagation(); setShowSteps((v) => !v); }}>
        {showSteps ? 'Hide steps' : `Show ${route.steps.length} step${route.steps.length === 1 ? '' : 's'}`}
      </Button>

      {showSteps && (
        <List dense disablePadding>
          {route.steps.map((step, i) => {
            const active = !!selectedRange && selectedRange[0] === step.fromLeg && selectedRange[1] === step.toLeg;
            const icon =
              step.kind === 'lift'
                ? step.isDownload ? '🚠⬇' : '🚠'
                : step.custom ? '★' : step.synthetic ? '⚠' : step.kind === 'connector' ? '↔' : '🎿';
            return (
              <ListItem
                key={i}
                disableGutters
                secondaryAction={
                  step.closureKey ? (
                    <IconButton edge="end" size="small" title={`Mark "${step.closureLabel}" closed`}
                      onClick={(e) => { e.stopPropagation(); onMarkClosed(step.closureKey!, step.closureLabel!); }}>
                      <BlockIcon fontSize="small" />
                    </IconButton>
                  ) : undefined
                }
              >
                <ListItemButton
                  selected={active}
                  sx={{ borderRadius: 1 }}
                  onClick={(e) => { e.stopPropagation(); onStepClick(index, step.fromLeg, step.toLeg); }}
                >
                  <ListItemText
                    primary={<><Box component="span" sx={{ mr: 0.5 }}>{icon}</Box>{step.label}</>}
                    secondary={`${fmtDistance(step.distanceM)} · ${fmtDuration(step.durationS)}`}
                    slotProps={{ primary: { variant: 'body2' }, secondary: { variant: 'caption' } }}
                  />
                </ListItemButton>
              </ListItem>
            );
          })}
        </List>
      )}
    </Paper>
  );
}

