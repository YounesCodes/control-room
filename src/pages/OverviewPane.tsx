import { useEffect, useState } from "react";
import { Pause, Play, RefreshCw } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { relativeTime } from "../lib/format";
import { compactUptime, formatKib, memoryUsage, swapUsage } from "../lib/host-resources";
import { SAMPLE_INTERVAL_MS, useHostResources } from "../lib/use-host-resources";
import { HostOsIcon } from "../components/HostOsIcon";
import { ResourceMeter } from "../components/ResourceMeter";
import type { HostCapabilities, SavedConnection } from "../types";
import { ErrorState, LoadingState } from "../components/PanelState";

type CapabilityTone = "ok" | "warn" | "off";

// Host facts change when someone changes the host, not on a clock, so they are
// cached and reused. Past this age the cache is old enough that presenting it
// as current would be misleading, and the pane says so instead.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function isStale(detectedAt: string): boolean {
  const detected = new Date(detectedAt).getTime();
  return Number.isFinite(detected) && Date.now() - detected > STALE_AFTER_MS;
}

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
  const [live, setLive] = useState(true);
  const resources = useHostResources(connection.id, live);

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

  const latest = resources.latest;
  const memory = memoryUsage(latest);
  const swap = swapUsage(latest);
  const cores = latest?.coreCount ?? null;

  // Six facts rather than five, so the two-column grid has no empty cell. Core
  // count belongs with the other hardware facts anyway.
  const systemRows: [string, string][] = [
    ["Hostname", capabilities.hostname ?? "Unavailable"],
    [
      "System",
      [capabilities.osName, capabilities.osVersion].filter(Boolean).join(" ") || "Unavailable",
    ],
    ["Kernel", capabilities.kernel ?? "Unavailable"],
    ["Architecture", capabilities.architecture ?? "Unavailable"],
    ["Default shell", capabilities.defaultShell ?? "Unavailable"],
    ["Memory", formatKib(latest?.memoryTotalKib ?? null) ?? (live ? "Reading…" : "Unavailable")],
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
  // `title` carries the precise reading on hover; `hint` is the line rendered
  // under the value. Uptime uses the former so the compact value stays compact.
  const stats: { label: string; value: string; hint?: string; title?: string }[] = [
    {
      label: "Uptime",
      value: compactUptime(capabilities.uptime) ?? "Unavailable",
      title: capabilities.uptime ?? undefined,
    },
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

  const loadDetail =
    latest?.load1 !== null && latest?.load1 !== undefined
      ? `load ${latest.load1.toFixed(2)}${cores ? ` over ${cores} cores` : ""}`
      : cores
        ? `${cores} cores`
        : "load unavailable";
  const memoryDetail = memory
    ? `${formatKib(memory.usedKib)} of ${formatKib(memory.totalKib)}${
        swap && swap.percent >= 1 ? ` · swap ${swap.percent.toFixed(0)}%` : ""
      }`
    : "memory unavailable";

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
        {!error && isStale(capabilities.detectedAt) && (
          <p className="inline-warning">
            These host facts were read {relativeTime(capabilities.detectedAt)} and have not been
            re-read since. Refresh to check them against the host.
          </p>
        )}

        <section className="overview-section overview-live">
          <header className="overview-live-heading">
            <div>
              <h3 className="overview-section-title">Live load</h3>
              <p className="overview-live-note">
                Sampled every {Math.round(SAMPLE_INTERVAL_MS / 1000)}s while this pane is open, and
                never stored.
              </p>
            </div>
            <button
              className="secondary-button"
              type="button"
              aria-pressed={live}
              onClick={() => setLive((current) => !current)}
            >
              {live ? <Pause size={14} /> : <Play size={14} />} {live ? "Pause" : "Resume"}
            </button>
          </header>
          {resources.error && (
            <p className="inline-warning">
              Showing the last reading. Sampling failed: {resources.error}
            </p>
          )}
          <div className="resource-meters">
            <ResourceMeter
              label="CPU"
              percent={latest?.cpuPercent ?? null}
              detail={loadDetail}
              history={resources.samples.map((sample) => sample.cpuPercent ?? 0)}
              unavailable="/proc/stat was not readable"
            />
            <ResourceMeter
              label="Memory"
              percent={memory?.percent ?? null}
              detail={memoryDetail}
              history={resources.samples.map((sample) => memoryUsage(sample)?.percent ?? 0)}
              unavailable="/proc/meminfo was not readable"
            />
          </div>
        </section>

        <div className="overview-stats">
          {stats.map((stat) => (
            <div className="overview-stat" key={stat.label}>
              <span className="overview-stat-label">{stat.label}</span>
              <strong className="overview-stat-value" title={stat.title}>
                {stat.value}
              </strong>
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
          <h3 className="overview-section-title">Runtime and capabilities</h3>
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
