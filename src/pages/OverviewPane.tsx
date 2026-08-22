import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { relativeTime } from "../lib/format";
import type { HostCapabilities, SavedConnection } from "../types";
import { ErrorState, LoadingState } from "../components/PanelState";

export function OverviewPane({ connection }: { connection: SavedConnection }) {
  const [capabilities, setCapabilities] = useState<HostCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.refreshCapabilities(connection.id);
      setCapabilities(result);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let current = true;
    setLoading(true);
    void api
      .cachedCapabilities(connection.id)
      .then((cached) => {
        if (!current) return;
        if (cached) {
          setCapabilities(cached);
          setLoading(false);
        } else {
          return refresh();
        }
      })
      .catch((caught) => {
        if (current) {
          setError(errorMessage(caught));
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [connection.id]);

  if (loading && !capabilities) return <LoadingState label="Discovering host capabilities…" />;
  if (error && !capabilities) {
    return <ErrorState message={error} action={<button onClick={refresh}>Retry</button>} />;
  }
  if (!capabilities) return null;

  const rows = [
    ["Hostname", capabilities.hostname ?? "Unavailable"],
    [
      "System",
      [capabilities.osName, capabilities.osVersion].filter(Boolean).join(" ") || "Unavailable",
    ],
    ["Kernel", capabilities.kernel ?? "Unavailable"],
    ["Architecture", capabilities.architecture ?? "Unavailable"],
    ["Uptime", capabilities.uptime ?? "Unavailable"],
    ["Default shell", capabilities.defaultShell ?? "Unavailable"],
    ["systemd", capabilities.systemdAvailable ? "Available" : "Unavailable"],
    ["journald", capabilities.journaldAvailable ? "Available" : "Unavailable"],
    [
      "Docker",
      capabilities.dockerAvailable
        ? capabilities.dockerAccessible
          ? `Version ${capabilities.dockerVersion ?? "unknown"}`
          : "Installed, permission required"
        : "Not detected",
    ],
    [
      "Containers",
      capabilities.dockerAccessible
        ? `${capabilities.runningContainerCount ?? 0} running / ${capabilities.totalContainerCount ?? 0} total`
        : "Unavailable",
    ],
    ["Running services", capabilities.runningServiceCount?.toString() ?? "Unavailable"],
  ];

  return (
    <section className="feature-page overview-page">
      <header className="page-heading">
        <div>
          <h2>{capabilities.hostname ?? connection.displayName}</h2>
          <p>Last inspected {relativeTime(capabilities.detectedAt)}</p>
        </div>
        <button className="secondary-button" type="button" onClick={refresh} disabled={loading}>
          <RefreshCw size={15} className={loading ? "spinning" : ""} /> Refresh
        </button>
      </header>
      {error && <p className="inline-warning">Showing cached data. Refresh failed: {error}</p>}
      <dl className="definition-grid">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
