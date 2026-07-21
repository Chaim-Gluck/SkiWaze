import { useState } from 'react';
import type { GraphEdge, MeaningfulPoint, PisteColor } from '../types/domain';
import { fmtDistance } from '../utils/format';

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

const COLORS: { value: LinkColor; label: string }[] = [
  { value: 'green', label: 'Green' },
  { value: 'blue', label: 'Blue' },
  { value: 'red', label: 'Red' },
  { value: 'black', label: 'Black' },
  { value: 'none', label: 'Flat / connector' },
];

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
  label,
  accent,
  value,
  points,
  onPick,
  onPin,
  pinActive,
  onClear,
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
  return (
    <div className="field">
      <span style={{ color: accent }}>{label}</span>
      <select value="" onChange={(e) => e.target.value && onPick(e.target.value)}>
        <option value="">{value ?? 'Select a point…'}</option>
        {points.map((p) => (
          <option key={p.id} value={p.nodeId}>{p.name}</option>
        ))}
      </select>
      <div className="point-actions">
        <button type="button" className={`mini ${pinActive ? 'active' : ''}`} onClick={onPin}>
          {pinActive ? 'Click map…' : '🗺 Pin anywhere'}
        </button>
        {value && (
          <button type="button" className="mini" onClick={onClear}>✕ Clear</button>
        )}
      </div>
    </div>
  );
}

export function CustomLinkPanel({
  points,
  fromLabel,
  toLabel,
  onPickFrom,
  onPickTo,
  onPinFrom,
  onPinTo,
  pinFromActive,
  pinToActive,
  onClearFrom,
  onClearTo,
  links,
  nodeLabel,
  onAdd,
  onDelete,
  onLocate,
  onClear,
}: Props) {
  const [color, setColor] = useState<LinkColor>('blue');
  const [direction, setDirection] = useState<LinkDirection>('ab');
  const ready = fromLabel && toLabel;
  const groups = groupLinks(links);

  return (
    <div className="panel">
      <h3>Custom links</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Draw a skiable link the map is missing. Pick each end from the list, or pin it anywhere on
        the map (even mid-slope) — pinned points become custom junctions.
      </p>

      <EndpointRow
        label="Link from"
        accent="#2e7d32"
        value={fromLabel}
        points={points}
        onPick={onPickFrom}
        onPin={onPinFrom}
        pinActive={pinFromActive}
        onClear={onClearFrom}
      />
      <EndpointRow
        label="Link to"
        accent="#c62828"
        value={toLabel}
        points={points}
        onPick={onPickTo}
        onPin={onPinTo}
        pinActive={pinToActive}
        onClear={onClearTo}
      />

      <label className="field">
        <span>Slope color</span>
        <select value={color} onChange={(e) => setColor(e.target.value as LinkColor)}>
          {COLORS.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      </label>

      <div className="field">
        <span>Skiable direction</span>
        <div className="timing">
          <label><input type="radio" checked={direction === 'ab'} onChange={() => setDirection('ab')} /> from → to</label>
          <label><input type="radio" checked={direction === 'ba'} onChange={() => setDirection('ba')} /> to → from</label>
          <label><input type="radio" checked={direction === 'both'} onChange={() => setDirection('both')} /> Both</label>
        </div>
      </div>

      <button type="button" className="secondary" disabled={!ready} onClick={() => onAdd(color, direction)}>
        Add link
      </button>

      {groups.length > 0 && (
        <div className="link-list">
          <div className="link-list-head">
            <span>{groups.length} added link{groups.length === 1 ? '' : 's'}</span>
            <button type="button" className="link-btn" onClick={onClear}>Clear all</button>
          </div>
          <ul>
            {groups.map((grp) => (
              <li key={grp.ids.join(',')} className="link-item">
                <span className={`link-dot color-${grp.color === 'none' ? 'unknown' : grp.color}`} />
                <button
                  type="button"
                  className="link-text locate"
                  title="Show on map"
                  onClick={() => onLocate(grp.geometry)}
                >
                  {nodeLabel(grp.fromNodeId)} {grp.bidirectional ? '↔' : '→'} {nodeLabel(grp.toNodeId)}
                  <span className="muted"> · {grp.color === 'none' ? 'flat' : grp.color} · {fmtDistance(grp.lengthM)}</span>
                </button>
                <button
                  type="button"
                  className="link-del"
                  title="Delete this link"
                  onClick={() => onDelete(grp.ids)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
