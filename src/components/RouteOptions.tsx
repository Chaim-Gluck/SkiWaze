import { useState } from 'react';
import type { Route } from '../types/domain';
import { fmtClock, fmtDistance, fmtDuration } from '../utils/format';

const ROUTE_COLORS = ['#ff9800', '#3949ab', '#00897b'];

interface Props {
  routes: Route[];
  selectedIndex: number;
  onSelect: (i: number) => void;
  selectedStep: number | null;
  onStepClick: (routeIndex: number, legIndex: number) => void;
}

export function RouteOptions({ routes, selectedIndex, onSelect, selectedStep, onStepClick }: Props) {
  return (
    <div className="panel">
      <h3>{routes.length} route option{routes.length === 1 ? '' : 's'}</h3>
      {routes.map((r, i) => (
        <RouteCard
          key={r.id}
          route={r}
          index={i}
          color={ROUTE_COLORS[i % ROUTE_COLORS.length]}
          selected={i === selectedIndex}
          selectedStep={i === selectedIndex ? selectedStep : null}
          onSelect={() => onSelect(i)}
          onStepClick={onStepClick}
        />
      ))}
    </div>
  );
}

function RouteCard({
  route,
  index,
  color,
  selected,
  selectedStep,
  onSelect,
  onStepClick,
}: {
  route: Route;
  index: number;
  color: string;
  selected: boolean;
  selectedStep: number | null;
  onSelect: () => void;
  onStepClick: (routeIndex: number, legIndex: number) => void;
}) {
  const [showSteps, setShowSteps] = useState(false);
  const s = route.stats;
  const colorParts = Object.entries(s.colorBreakdownM).filter(([, m]) => (m ?? 0) > 0);
  const usesLiftDownhill = route.legs.some((l) => l.kind === 'lift' && l.isDownload);
  const usesInferred = route.legs.some((l) => l.synthetic && !l.custom);
  const usesCustom = route.legs.some((l) => l.custom);

  return (
    <div className={`route-card ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <div className="route-head">
        <span className="route-swatch" style={{ background: color }} />
        <strong>{fmtDuration(s.totalDurationS)}</strong>
        <span className="muted">{fmtDistance(s.totalDistanceM)}</span>
        {route.objective === 'longest_streak' && <span className="badge">longest streak</span>}
      </div>

      {usesLiftDownhill && (
        <div className="lift-down-label">🚠⬇ This route rides a lift downhill</div>
      )}

      {usesInferred && (
        <div className="synthetic-label">⚠ Uses an app-added bridge (dotted magenta) — verify it's actually skiable</div>
      )}

      {usesCustom && (
        <div className="custom-link-label">★ Uses one of your custom links (dotted cyan)</div>
      )}

      <div className="route-stats">
        <span>⬇ {fmtDistance(s.descentM)} descent</span>
        <span>🚠 {s.liftCount} lift{s.liftCount === 1 ? '' : 's'}</span>
        <span>🎿 longest run {fmtDistance(s.longestDownhillStreakM)}</span>
      </div>

      {colorParts.length > 0 && (
        <div className="color-bar">
          {colorParts.map(([c, m]) => (
            <span key={c} className={`seg color-${c}`} style={{ flex: m }} title={`${c}: ${fmtDistance(m ?? 0)}`} />
          ))}
        </div>
      )}

      {(s.startTime || s.arriveTime) && (
        <div className="route-times">
          Depart <strong>{fmtClock(s.startTime)}</strong> → arrive <strong>{fmtClock(s.arriveTime)}</strong>
        </div>
      )}

      {route.warnings.length > 0 && (
        <ul className="route-warnings">
          {route.warnings.slice(0, 4).map((w, i) => (
            <li key={i} className={w.code === 'lift_closing_soon' ? 'warn-urgent' : ''}>{w.message}</li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="link-btn"
        onClick={(e) => {
          e.stopPropagation();
          setShowSteps((v) => !v);
        }}
      >
        {showSteps ? 'Hide steps' : `Show ${route.legs.length} steps`}
      </button>

      {showSteps && (
        <ol className="steps">
          {route.legs.map((l, i) => (
            <li
              key={i}
              className={`step step-${l.kind} ${l.custom ? 'step-custom' : l.synthetic ? 'step-synthetic' : ''} ${selectedStep === i ? 'step-active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                onStepClick(index, i);
              }}
            >
              {l.custom ? '★ ' : l.synthetic ? '⚠ ' : ''}{l.description}
              <span className="muted"> · {fmtDuration(l.durationS)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
