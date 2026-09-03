import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { relativeTime } from "../lib/format";
import { HostOsIcon } from "../components/HostOsIcon";
import type { HostCapabilities, SavedConnection } from "../types";
import { ErrorState, LoadingState } from "../components/PanelState";

type CapabilityTone = "ok" | "warn" | "off";

export function OverviewPane({
  connection,
  onCapabilitiesChange,
}: {
  connection: SavedConnection;
  onCapabilitiesChange?: (capabilities: HostCapabilities) => void;
}) {
  const [capabilities, setCapabilities] = useState<HostCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.refreshCapabilities(connection.id);
      setCapabilities(result);
      onCapabilitiesChange?.(result);
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
          onCapabilitiesChange?.(cached);
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

  const systemRows: [string, string][] = [
    ["Hostname", capabilities.hostname ?? "Unavailable"],
    [
      "System",
      [capabilities.osName, capabilities.osVersion].filter(Boolean).join(" ") || "Unavailable",
    ],
    ["Kernel", capabilities.kernel ?? "Unavailable"],
    ["Architecture", capabilities.architecture ?? "Unavailable"],
    ["Default shell", capabilities.defaultShell ?? "Unavailable"],
  ];

  const dockerReachable = capabilities.dockerAccessible || capabilities.dockerAccessibleWithSudo;
  const dockerValue = capabilities.dockerAvailable
    ? capabilities.dockerAccessible
      ? `Version ${capabilities.dockerVersion ?? "unknown"}`
      : capabilities.dockerAccessibleWithSudo
        ? `Version ${capabilities.dockerVersion ?? "unknown"} — reachable with sudo`
        : "Installed — sudo required"
    : "Not detected";
  const dockerTone: CapabilityTone = capabilities.dockerAvailable
    ? capabilities.dockerAccessible
      ? "ok"
      : "warn"
    : "off";

  const capabilityRows: { label: string; value: string; tone: CapabilityTone }[] = [
    {
      label: "systemd",
      value: capabilities.systemdAvailable ? "Available" : "Not detected",
      tone: capabilities.systemdAvailable ? "ok" : "off",
    },
    {
      label: "journald",
      value: capabilities.journaldAvailable ? "Available" : "Not detected",
      tone: capabilities.journaldAvailable ? "ok" : "off",
    },
    {
      label: "sudo",
      value: capabilities.passwordlessSudo ? "Passwordless" : "Password required",
      tone: capabilities.passwordlessSudo ? "ok" : "off",
    },
    { label: "Docker", value: dockerValue, tone: dockerTone },
  ];

  const containersValue = dockerReachable
    ? `${capabilities.runningContainerCount ?? 0} / ${capabilities.totalContainerCount ?? 0}`
    : "—";
  const stats: { label: string; value: string; hint?: string }[] = [
    { label: "Uptime", value: capabilities.uptime ?? "Unavailable" },
    {
      label: "Running services",
      value: capabilities.runningServiceCount?.toString() ?? "—",
    },
    {
      label: "Containers",
      value: containersValue,
      hint: dockerReachable ? "running / total" : "Docker unavailable",
    },
  ];

  return (
    <section className="feature-page overview-page">
      <div className="overview-content">
        <header className="page-heading overview-heading">
          <div className="overview-identity">
            <span className="overview-host-mark">
              <HostOsIcon osId={capabilities.osId} />
            </span>
            <div>
              <h2>Overview</h2>
              <p>
                {capabilities.hostname ?? connection.displayName} · Last inspected{" "}
                {relativeTime(capabilities.detectedAt)}
              </p>
            </div>
          </div>
          <button className="secondary-button" type="button" onClick={refresh} disabled={loading}>
            <RefreshCw size={15} className={loading ? "spinning" : ""} /> Refresh
          </button>
        </header>
        {error && <p className="inline-warning">Showing cached data. Refresh failed: {error}</p>}

        <div className="overview-stats">
          {stats.map((stat) => (
            <div className="overview-stat" key={stat.label}>
              <span className="overview-stat-label">{stat.label}</span>
              <strong className="overview-stat-value">{stat.value}</strong>
              {stat.hint && <span className="overview-stat-hint">{stat.hint}</span>}
            </div>
          ))}
        </div>

        <section className="overview-section">
          <h3 className="overview-section-title">System</h3>
          <dl className="definition-grid">
            {systemRows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="overview-section">
          <h3 className="overview-section-title">Runtime &amp; capabilities</h3>
          <ul className="capability-list">
            {capabilityRows.map((row) => (
              <li className="capability-row" key={row.label}>
                <span className={`cap-dot cap-${row.tone}`} aria-hidden="true" />
                <span className="capability-label">{row.label}</span>
                <span className="capability-value">{row.value}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </section>
  );
}
