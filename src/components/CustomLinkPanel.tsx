import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { bidiName } from '../utils/format';
import type { GraphEdge, MeaningfulPoint, PisteColor } from '../types/domain';
import { fmtDistance } from '../utils/format';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Autocomplete from '@mui/material/Autocomplete';
import Button from '@mui/material/Button';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import PlaceIcon from '@mui/icons-material/Place';
import AddIcon from '@mui/icons-material/Add';

export type LinkColor = PisteColor | 'none';
export type LinkDirection = 'ab' | 'ba' | 'both';

interface Props {
  points: MeaningfulPoint[];
  fromLabel: string | null;
  toLabel: string | null;
  onPickFrom: (nodeId: string) => void;
  onPickTo: (nodeId: string) => void;
  onPinFrom: () => void;
  onPinTo: () => void;
  pinFromActive: boolean;
  pinToActive: boolean;
  onClearFrom: () => void;
  onClearTo: () => void;
  links: GraphEdge[];
  nodeLabel: (nodeId: string) => string;
  onAdd: (color: LinkColor, direction: LinkDirection) => void;
  onDelete: (edgeIds: string[]) => void;
  onLocate: (coords: [number, number][]) => void;
  onClear: () => void;
}

const COLORS: LinkColor[] = ['green', 'blue', 'red', 'black', 'none'];
const SLOPE_HEX: Record<string, string> = { green: '#2e7d32', blue: '#1565c0', red: '#d32f2f', black: '#222', none: '#ff9800' };

interface LinkGroup {
  ids: string[];
  fromNodeId: string;
  toNodeId: string;
  bidirectional: boolean;
  color: PisteColor | 'none';
  lengthM: number;
  geometry: [number, number][];
}

function groupLinks(edges: GraphEdge[]): LinkGroup[] {
  const byStamp = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const stamp = e.id.split('-').slice(0, 2).join('-'); // cust-<stamp>
    const arr = byStamp.get(stamp);
    if (arr) arr.push(e);
    else byStamp.set(stamp, [e]);
  }
  const groups: LinkGroup[] = [];
  for (const arr of byStamp.values()) {
    const ab = arr.find((e) => e.id.endsWith('-ab')) ?? arr[0];
    groups.push({
      ids: arr.map((e) => e.id),
      fromNodeId: ab.from,
      toNodeId: ab.to,
      bidirectional: arr.length > 1,
      color: ab.color ?? 'none',
      lengthM: ab.lengthM,
      geometry: ab.geometry.map((p) => [p.lon, p.lat] as [number, number]),
    });
  }
  return groups;
}

function EndpointRow({
  label, accent, value, points, onPick, onPin, pinActive, onClear,
}: {
  label: string;
  accent: string;
  value: string | null;
  points: MeaningfulPoint[];
  onPick: (nodeId: string) => void;
  onPin: () => void;
  pinActive: boolean;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Box sx={{ mb: 1.5 }}>
      <Typography variant="body2" sx={{ color: accent, fontWeight: 700, mb: 0.5 }}>{label}</Typography>
      <Autocomplete
        size="small"
        options={points}
        value={null}
        getOptionLabel={(o) => bidiName(o.name)}
        onChange={(_, v) => { if (v) onPick(v.nodeId); }}
        renderInput={(params) => <TextField {...params} placeholder={value ?? t('picker.placeholder')} />}
      />
      <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
        <Button size="small" fullWidth variant={pinActive ? 'contained' : 'outlined'} startIcon={<PlaceIcon />} onClick={onPin}>
          {pinActive ? t('picker.clickMap') : t('link.pinAnywhere')}
        </Button>
        {value && <Button size="small" variant="outlined" color="inherit" onClick={onClear}>{t('link.clear')}</Button>}
      </Box>
    </Box>
  );
}

export function CustomLinkPanel({
  points, fromLabel, toLabel, onPickFrom, onPickTo, onPinFrom, onPinTo,
  pinFromActive, pinToActive, onClearFrom, onClearTo, links, nodeLabel,
  onAdd, onDelete, onLocate, onClear,
}: Props) {
  const { t } = useTranslation();
  const [color, setColor] = useState<LinkColor>('blue');
  const [direction, setDirection] = useState<LinkDirection>('ab');
  const [adding, setAdding] = useState(false);
  const ready = fromLabel && toLabel;
  const groups = groupLinks(links);

  return (
    <Box>
      {adding ? (
        <Box sx={{ mb: 1.5, p: 1.25, border: 1, borderColor: 'divider', borderRadius: 2 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {t('link.intro')}
          </Typography>

          <EndpointRow label={t('link.from')} accent="#2e7d32" value={fromLabel} points={points}
            onPick={onPickFrom} onPin={onPinFrom} pinActive={pinFromActive} onClear={onClearFrom} />
          <EndpointRow label={t('link.to')} accent="#c62828" value={toLabel} points={points}
            onPick={onPickTo} onPin={onPinTo} pinActive={pinToActive} onClear={onClearTo} />

          <TextField select size="small" fullWidth label={t('link.slopeColor')} sx={{ mb: 1.5 }}
            value={color} onChange={(e) => setColor(e.target.value as LinkColor)}>
            {COLORS.map((c) => <MenuItem key={c} value={c}>{c === 'none' ? t('link.colorFlat') : t(`color.${c}`)}</MenuItem>)}
          </TextField>

          <Box sx={{ mb: 1.5 }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>{t('link.direction')}</Typography>
            <ToggleButtonGroup exclusive size="small" value={direction} onChange={(_, v) => v && setDirection(v)}>
              <ToggleButton value="ab">{t('link.dirAb')}</ToggleButton>
              <ToggleButton value="ba">{t('link.dirBa')}</ToggleButton>
              <ToggleButton value="both">{t('link.dirBoth')}</ToggleButton>
            </ToggleButtonGroup>
          </Box>

          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button variant="contained" disabled={!ready} onClick={() => { onAdd(color, direction); setAdding(false); }}>
              {t('link.add')}
            </Button>
            <Button variant="text" color="inherit" onClick={() => setAdding(false)}>{t('link.cancel')}</Button>
          </Box>
        </Box>
      ) : (
        <Button variant="outlined" fullWidth startIcon={<AddIcon />} onClick={() => setAdding(true)} sx={{ mb: groups.length ? 1.5 : 0 }}>
          {t('link.addCustom')}
        </Button>
      )}

      {groups.length > 0 ? (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}>
            <Typography variant="body2" color="text.secondary">{t('link.count', { count: groups.length })}</Typography>
            <Button size="small" onClick={onClear}>{t('link.clearAll')}</Button>
          </Box>
          <List dense disablePadding>
            {groups.map((grp) => (
              <ListItem key={grp.ids.join(',')} disableGutters
                secondaryAction={
                  <IconButton edge="end" size="small" title={t('link.delete')} onClick={() => onDelete(grp.ids)}>
                    <CloseIcon fontSize="small" />
                  </IconButton>
                }>
                <ListItemButton sx={{ borderRadius: 1, alignItems: 'flex-start' }} onClick={() => onLocate(grp.geometry)} title={t('common.showOnMap')}>
                  <Box sx={{ width: 10, height: 10, borderRadius: '50%', mr: 1, mt: 0.5, flexShrink: 0, bgcolor: SLOPE_HEX[grp.color] ?? '#ff9800' }} />
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography variant="body2" noWrap>{nodeLabel(grp.fromNodeId)}</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', lineHeight: 1, my: 0.25 }}>
                      {grp.bidirectional ? '↕' : '↓'}
                    </Typography>
                    <Typography variant="body2" noWrap>{nodeLabel(grp.toNodeId)}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {grp.color === 'none' ? t('link.flat') : t(`color.${grp.color}`)} · {fmtDistance(grp.lengthM)}
                    </Typography>
                  </Box>
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </>
      ) : (
        !adding && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
            {t('link.empty')}
          </Typography>
        )
      )}
    </Box>
  );
}

