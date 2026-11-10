import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/** Catches render errors and shows the message instead of a blank/black screen. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('SkiWays crashed:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: '#0e1621',
            color: '#eaf2fb',
            padding: 24,
            font: '14px/1.5 "Segoe UI", system-ui, sans-serif',
            overflow: 'auto',
            zIndex: 9999,
          }}
        >
          <h2 style={{ color: '#ff9d9d' }}>Something went wrong</h2>
          <p style={{ color: '#b7c6d4' }}>{this.state.error.message}</p>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#8fa8bd', fontSize: 12 }}>{this.state.error.stack}</pre>
          <button
            type="button"
            onClick={() => location.reload()}
            style={{ marginTop: 12, padding: '8px 14px', borderRadius: 8, cursor: 'pointer' }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
