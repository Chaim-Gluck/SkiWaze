import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import TramIcon from '@mui/icons-material/Tram';
import DownhillSkiingIcon from '@mui/icons-material/DownhillSkiing';
import HeightIcon from '@mui/icons-material/Height';
import { bidiName, fmtDistance } from '../utils/format';
import { resortStats } from '../utils/resortStats';
import type { ResortGraph } from '../types/domain';

/** Kept in step with MapView's SLOPE_COLOR_EXPR. Local on purpose: this is presentation only. */
const SLOPE_HEX: Record<string, string> = {
  green: '#2e7d32', blue: '#1565c0', red: '#d32f2f', black: '#111111', unknown: '#ff9800',
};

interface Props {
  graph: ResortGraph;
  /** Named points (lift stations, run tops/bottoms) the pickers offer. */
  pointCount: number;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, py: 0.25 }}>
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 0 }}>{label}</Typography>
      <Typography variant="body2" sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{value}</Typography>
    </Box>
  );
}

/** Section heading: a glyph plus its title, so the three blocks are scannable without reading. */
function Heading({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <Typography
      variant="subtitle2"
      sx={{ mb: 0.5, display: 'flex', alignItems: 'center', gap: 0.75,
            '& .MuiSvgIcon-root': { fontSize: 18, color: 'text.secondary' } }}
    >
      {icon}{children}
    </Typography>
  );
}

export function ResortStatsPanel({ graph, pointCount }: Props) {
  const { t } = useTranslation();
  const s = useMemo(() => resortStats(graph), [graph]);

  return (
    <Box className="panel">
      <Heading icon={<TramIcon />}>
        {t('app.resort.liftsHeading', { n: s.liftCount })}
      </Heading>
      {s.liftsByType.map(({ type, count }) => (
        <Row key={type} label={t(`liftType.${type}`)} value={String(count)} />
      ))}

      <Divider sx={{ my: 1.5 }} />

      <Heading icon={<DownhillSkiingIcon />}>
        {t('app.resort.pistesHeading', { count: s.runCount, value: fmtDistance(s.pisteM) })}
      </Heading>
      {/* One grid for the whole list, rows as display:contents - so the run-count and distance
          columns size to their widest cell and line up down the card. Per-row flex cannot do
          that: each row would size its own value independently and the numbers would stagger. */}
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr max-content max-content', columnGap: 2 }}>
        {s.pisteByColor.map(({ color, meters, runs }) => (
          <Box key={color} sx={{ display: 'contents' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, py: 0.25 }}>
              <Box sx={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                         bgcolor: SLOPE_HEX[color] ?? SLOPE_HEX.unknown,
                         border: color === 'black' ? '1px solid rgba(255,255,255,0.45)' : 'none' }} />
              <Typography variant="body2" color="text.secondary">{t(`color.${color}`)}</Typography>
            </Box>
            <Typography
              variant="body2" color="text.secondary"
              sx={{ py: 0.25, textAlign: 'end', whiteSpace: 'nowrap' }}
            >
              {runs > 0 ? t('app.resort.runsCount', { count: runs }) : ''}
            </Typography>
            <Typography
              variant="body2"
              sx={{ py: 0.25, fontWeight: 600, textAlign: 'end', whiteSpace: 'nowrap' }}
            >
              {fmtDistance(meters)}
            </Typography>
          </Box>
        ))}
      </Box>
      {s.offPisteM > 0 && (
        <Row label={t('app.resort.offPiste')} value={fmtDistance(s.offPisteM)} />
      )}

      <Divider sx={{ my: 1.5 }} />

      <Heading icon={<HeightIcon />}>{t('app.resort.elevationHeading')}</Heading>
      <Row
        label={t('app.resort.vertical')}
        value={bidiName(`${t('units.m', { value: Math.round(s.lowEle) })} \u2013 ${t('units.m', { value: Math.round(s.highEle) })}`)}
      />
      <Row
        label={t('app.resort.verticalDrop')}
        value={t('units.m', { value: Math.round(s.highEle - s.lowEle) })}
      />

      <Divider sx={{ my: 1.5 }} />

      {/* Was a caption under every card on desktop only. It is a fact about this resort's data, so
          it belongs here - and mobile gets it for the first time. */}
      <Typography variant="body2" color="text.secondary">
        {t('app.graphStats', { nodes: s.nodeCount, edges: s.edgeCount, points: pointCount })}
      </Typography>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
        {t('app.resort.statsSource')}
      </Typography>
    </Box>
  );
}
