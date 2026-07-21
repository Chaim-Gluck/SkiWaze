import { useState } from 'react';
import type { Route } from '../types/domain';
import { fmtClock, fmtDistance, fmtDuration } from '../utils/format';

const ROUTE_COLORS = ['#ff9800', '#3949ab', '#00897b'];

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
    <div className="panel">
      <h3>{routes.length} route option{routes.length === 1 ? '' : 's'}</h3>
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
    </div>
  );
}

function RouteCard({
  route,
  index,
  color,
  selected,
  selectedRange,
  onSelect,
  onStepClick,
  onMarkClosed,
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
        {showSteps ? 'Hide steps' : `Show ${route.steps.length} steps`}
      </button>

      {showSteps && (
        <ol className="steps">
          {route.steps.map((step, i) => {
            const active = !!selectedRange && selectedRange[0] === step.fromLeg && selectedRange[1] === step.toLeg;
            const icon =
              step.kind === 'lift'
                ? step.isDownload ? '🚠⬇' : '🚠'
                : step.custom ? '★' : step.synthetic ? '⚠' : step.kind === 'connector' ? '↔' : '🎿';
            return (
              <li
                key={i}
                className={`step step-${step.kind} ${step.custom ? 'step-custom' : step.synthetic ? 'step-synthetic' : ''} ${active ? 'step-active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onStepClick(index, step.fromLeg, step.toLeg);
                }}
              >
                <span className="step-body">
                  <span className="step-ico">{icon}</span> {step.label}
                  <span className="muted"> · {fmtDistance(step.distanceM)} · {fmtDuration(step.durationS)}</span>
                </span>
                {step.closureKey && (
                  <button
                    type="button"
                    className="step-close"
                    title={`Mark "${step.closureLabel}" closed`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onMarkClosed(step.closureKey!, step.closureLabel!);
                    }}
                  >
                    ⊘
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
