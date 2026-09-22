import { Component, type ErrorInfo, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { WindowControls } from "./WindowControls";

type Props = { children: ReactNode; onReload?: () => void };
type State = { error: Error | null };

/**
 * A pane that fails to render must not take the whole window with it. Without
 * this, React unmounts the entire tree on an uncaught render error and the user
 * is left staring at the black page background with no way back but restarting
 * the app. The failure is shown instead: what happened, that stored data is
 * untouched, and a Reload that starts the session over.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The screen carries the message itself; the console keeps the stack for
    // anyone who has devtools open.
    console.error("Control Room hit a rendering error", error, info.componentStack ?? "");
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { error } = this.state;
    return (
      <div className="crash-shell">
        <header className="crash-titlebar" data-tauri-drag-region>
          <WindowControls />
        </header>
        <section className="crash-screen" role="alert">
          <h1>Something went wrong</h1>
          <p>
            Control Room hit an error while drawing this window. Your Saved Connections, settings,
            and notes were not changed. Reload to start the session over.
          </p>
          <pre className="crash-detail">{error.message || String(error)}</pre>
          <button
            className="primary-button"
            type="button"
            onClick={this.props.onReload ?? (() => window.location.reload())}
          >
            <RotateCcw size={15} /> Reload
          </button>
        </section>
      </div>
    );
  }
}
