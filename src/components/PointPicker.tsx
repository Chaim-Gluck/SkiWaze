import type { MeaningfulPoint } from '../types/domain';

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
  const known = points.some((p) => p.nodeId === valueNodeId);
  const value = valueNodeId ?? '';
  return (
    <div className="field">
      <span style={{ color: accent }}>{label}</span>
      <select
        value={known ? value : '__custom'}
        onChange={(e) => e.target.value !== '__custom' && onPick(e.target.value)}
      >
        <option value="" disabled>
          Select a point…
        </option>
        {!known && valueNodeId && <option value="__custom">{customLabel ?? 'Custom location'}</option>}
        {points.map((p) => (
          <option key={p.id} value={p.nodeId}>
            {p.name}
          </option>
        ))}
      </select>
      <div className="point-actions">
        <button type="button" className="mini" onClick={onUseLocation}>
          📍 My location
        </button>
        <button type="button" className={`mini ${pinActive ? 'active' : ''}`} onClick={onPinMode}>
          {pinActive ? 'Click map…' : '🗺 Pin on map'}
        </button>
      </div>
    </div>
  );
}
