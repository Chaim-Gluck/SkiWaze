import type { MeaningfulPoint } from '../types/domain';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MyLocationIcon from '@mui/icons-material/MyLocation';
import PlaceIcon from '@mui/icons-material/Place';

interface Props {
  label: string;
  accent: string;
  points: MeaningfulPoint[];
  valueNodeId: string | null;
  customLabel?: string | null;
  onPick: (nodeId: string) => void;
  onUseLocation: () => void;
  onPinMode: () => void;
  pinActive: boolean;
}

export function PointPicker({
  label,
  accent,
  points,
  valueNodeId,
  customLabel,
  onPick,
  onUseLocation,
  onPinMode,
  pinActive,
}: Props) {
  const selected = points.find((p) => p.nodeId === valueNodeId) ?? null;
  // A pinned/located point isn't in `points`; show it as a synthetic (non-selectable) option.
  const custom: MeaningfulPoint | null =
    !selected && valueNodeId
      ? ({ id: '__custom', nodeId: valueNodeId, name: customLabel ?? 'Custom location' } as MeaningfulPoint)
      : null;
  const options = custom ? [custom, ...points] : points;
  const value = custom ?? selected;

  return (
    <Box sx={{ mb: 1.5 }}>
      <Typography variant="body2" sx={{ color: accent, fontWeight: 700, mb: 0.5 }}>
        {label}
      </Typography>
      <Autocomplete
        size="small"
        options={options}
        value={value}
        getOptionLabel={(o) => o.name}
        isOptionEqualToValue={(o, v) => o.nodeId === v.nodeId}
        onChange={(_, v) => {
          if (v && v.id !== '__custom') onPick(v.nodeId);
        }}
        renderInput={(params) => <TextField {...params} placeholder="Select a point…" />}
      />
      <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
        <Button size="small" variant="outlined" fullWidth startIcon={<MyLocationIcon />} onClick={onUseLocation}>
          My location
        </Button>
        <Button
          size="small"
          fullWidth
          variant={pinActive ? 'contained' : 'outlined'}
          startIcon={<PlaceIcon />}
          onClick={onPinMode}
        >
          {pinActive ? 'Click map…' : 'Pin on map'}
        </Button>
      </Box>
    </Box>
  );
}

