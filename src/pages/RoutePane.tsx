import { useCallback, useEffect, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { ErrorState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import {
  LOCAL_ONLY_NOTICE,
  copyableValues,
  resolvedHostNote,
  routeHeadline,
  segmentStatusLabel,
  segmentTarget,
  segmentTitle,
  unknownFields,
} from "../lib/ssh-route";
import type { SavedConnection, SshRoute } from "../types";

export function RoutePane({ connection }: { connection: SavedConnection }) {
  const [route, setRoute] = useState<SshRoute | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRoute(await api.resolveSshRoute(connection.id));
    } catch (caught) {
      setRoute(null);
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [connection.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !route) return <LoadingState label="Reading the effective configuration…" />;
  if (error && !route) {
    return (
      <ErrorState message={error} action={<button onClick={() => void load()}>Retry</button>} />
    );
  }

  return (
    <section className="feature-page route-page">
      <header className="page-heading">
        <div>
          <h2>Route</h2>
          <p>{route ? routeHeadline(route) : LOCAL_ONLY_NOTICE}</p>
          <small className="route-notice">{LOCAL_ONLY_NOTICE}</small>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Re-read the route"
        >
          <RefreshCw size={16} className={loading ? "spinning" : ""} />
        </button>
      </header>

      {error && route && <p className="inline-warning">Showing the last route. {error}</p>}

      {route && (
        <>
          <ol className="route-segments">
            {route.segments.map((segment, index) => {
              const hostNote = resolvedHostNote(segment);
              const missing = unknownFields(segment);
              return (
                <li key={`${segment.kind}-${segment.alias}-${index}`}>
                  {index > 0 && <ChevronRight size={14} className="route-arrow" />}
                  <div className="route-segment">
                    <header>
                      <strong>{segmentTitle(segment)}</strong>
                      <span className={`route-status route-status-${segment.status}`}>
                        {segmentStatusLabel(segment)}
                      </span>
                    </header>
                    <p className="route-target">{segmentTarget(segment)}</p>
                    {hostNote && <p className="route-note">{hostNote}</p>}
                    {segment.note && <p className="route-note">{segment.note}</p>}
                    {segment.proxyProgram && (
                      <p className="route-note">
                        Proxy program: {segment.proxyProgram}. Its arguments are not shown.
                      </p>
                    )}
                    {Boolean(missing.length) && (
                      <p className="route-note">OpenSSH reported no {missing.join(", ")}</p>
                    )}
                    {Boolean(copyableValues(segment).length) && (
                      <dl className="route-values">
                        {copyableValues(segment).map((entry) => (
                          <div key={`${entry.label}-${entry.value}`}>
                            <dt>{entry.label}</dt>
                            <dd>
                              <code>{entry.value}</code>
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          {route.truncated && (
            <p className="inline-warning">
              This route was longer than Control Room follows. The end of it is not shown.
            </p>
          )}
          <footer className="route-footer">
            <small>
              Read at {new Date(route.resolvedAt).toLocaleTimeString()}. Control Room reads what the
              OpenSSH client resolves and does not work out routing itself.
            </small>
          </footer>
        </>
      )}
    </section>
  );
}
