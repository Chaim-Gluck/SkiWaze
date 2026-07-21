import { closureLabel } from '../routing/closures';

interface Props {
  closedKeys: string[];
  onReopen: (key: string) => void;
  onReopenAll: () => void;
  onLocate: (key: string) => void;
}

/** Lists lifts/runs the user marked closed, with reopen + locate. */
export function ClosedPanel({ closedKeys, onReopen, onReopenAll, onLocate }: Props) {
  return (
    <div className="panel">
      <h3>⛔ Closed today</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Statuses are assumed open. Mark a run or lift closed (⊘ on a route step) and routes will avoid it.
      </p>

      {closedKeys.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>Nothing marked closed.</p>
      ) : (
        <div className="link-list">
          <div className="link-list-head">
            <span>{closedKeys.length} closed</span>
            <button type="button" className="link-btn" onClick={onReopenAll}>Reopen all</button>
          </div>
          <ul>
            {closedKeys.map((key) => (
              <li key={key} className="link-item">
                <span className="link-dot closed-dot" />
                <button
                  type="button"
                  className="link-text locate"
                  title="Show on map"
                  onClick={() => onLocate(key)}
                >
                  {closureLabel(key)}
                </button>
                <button
                  type="button"
                  className="link-del"
                  title="Reopen (remove closure)"
                  onClick={() => onReopen(key)}
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
