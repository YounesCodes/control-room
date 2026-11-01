import { useEffect, useState } from "react";
import { ArrowUpRight, Pause, Play, RefreshCw } from "lucide-react";
import { useOverviewDiagnostics } from "../hooks/use-overview-diagnostics";
import { api, errorMessage } from "../lib/api";
import {
  formatByteRate,
  formatPercent,
  formatReadingTime,
  formatUptime,
} from "../lib/header-metrics";
import { formatKib } from "../lib/host-resources";
import { chartPath, memoryPercent, sumRates } from "../lib/overview-diagnostics";
import { sectionLabel } from "../lib/host-baselines";
import type { DiagnosticState, HostBaselineSummary, OverviewDiagnostics as Sample } from "../types";

export type OverviewDestination = "services" | "docker" | "ports" | "baselines";
export type OverviewNavigate = (
  view: OverviewDestination,
  baselineId?: string,
  comparisonId?: string,
) => void;
const kib = (value: number | null | undefined) => formatKib(value ?? null) ?? "Unavailable";
const numeric = (value: number | null | undefined) =>
  value == null ? "Unavailable" : value.toLocaleString(undefined, { maximumFractionDigits: 1 });

function HistoryChart({
  label,
  history,
  series,
  percent = false,
}: {
  label: string;
  history: Sample[];
  series: { name: string; value: (point: Sample) => number | null }[];
  percent?: boolean;
}) {
  const [inspected, setInspected] = useState<number | null>(null);
  const end = Date.parse(history.at(-1)?.sampledAt ?? "");
  const start = Math.min(Date.parse(history[0]?.sampledAt ?? ""), end - 60_000);
  const max = percent
    ? 100
    : Math.max(1, ...history.flatMap((point) => series.map((line) => line.value(point) ?? 0)));
  const index = inspected == null ? history.length - 1 : Math.min(inspected, history.length - 1);
  const point = history[index];
  const format = percent ? formatPercent : formatByteRate;
  return (
    <figure className="diagnostic-chart">
      <span className="diagnostic-chart-scale" aria-hidden="true">
        {percent ? "100%" : formatByteRate(max)}
      </span>
      <svg
        viewBox="0 0 400 80"
        preserveAspectRatio="none"
        role="img"
        tabIndex={history.length ? 0 : undefined}
        aria-label={`${label} history. ${percent ? "0 to 100 percent." : `Scale 0 to ${formatByteRate(max)}.`} Use arrow keys to inspect readings.`}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          setInspected(
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? history.length - 1
                : Math.max(
                    0,
                    Math.min(history.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1)),
                  ),
          );
        }}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const time = start + ((event.clientX - bounds.left) / bounds.width) * (end - start);
          let nearest = 0;
          history.forEach((point, index) => {
            if (
              Math.abs(Date.parse(point.sampledAt) - time) <
              Math.abs(Date.parse(history[nearest].sampledAt) - time)
            )
              nearest = index;
          });
          setInspected(nearest);
        }}
        onPointerLeave={() => setInspected(null)}
        onBlur={() => setInspected(null)}
      >
        <title>{label} history</title>
        <path className="diagnostic-gridline" d="M0 4H400 M0 40H400 M0 76H400" />
        {series.map((line, index) => (
          <g key={line.name}>
            <path
              className={`diagnostic-trace trace-${index}`}
              d={chartPath(
                history.map((point) => ({
                  time: Date.parse(point.sampledAt),
                  value: line.value(point),
                })),
                start,
                end,
                max,
              )}
            />
            {point && line.value(point) != null && (
              <circle
                className={`diagnostic-point trace-${index}`}
                r="2.5"
                cx={2 + ((Date.parse(point.sampledAt) - start) / Math.max(1, end - start)) * 396}
                cy={76 - Math.min(1, line.value(point)! / Math.max(1, max)) * 72}
              />
            )}
          </g>
        ))}
        {point && (
          <line
            className="diagnostic-cursor"
            x1={2 + ((Date.parse(point.sampledAt) - start) / Math.max(1, end - start)) * 396}
            x2={2 + ((Date.parse(point.sampledAt) - start) / Math.max(1, end - start)) * 396}
            y1="0"
            y2="80"
          />
        )}
      </svg>
      <figcaption>
        <time>{point ? formatReadingTime(point.sampledAt) : "Waiting for readings"}</time>
        <span>
          {series.map((line, index) => (
            <span className={`diagnostic-legend trace-${index}`} key={line.name}>
              {line.name} {format(point ? line.value(point) : null)}
            </span>
          ))}
        </span>
      </figcaption>
    </figure>
  );
}

function StateSummary({ states }: { states: DiagnosticState[] | null | undefined }) {
  if (states == null) return <p className="diagnostic-empty">Unavailable</p>;
  if (!states.length) return <p className="diagnostic-empty">None found</p>;
  return (
    <dl className="diagnostic-states">
      {states.map((item, index) => (
        <div
          key={`${item.state}:${index}`}
          data-attention={/failed|unhealthy|dead/.test(item.state) || undefined}
        >
          <dt>{item.state}</dt>
          <dd>{item.count}</dd>
        </div>
      ))}
    </dl>
  );
}

export function OverviewDiagnostics({
  target,
  active,
  windows,
  onNavigate,
}: {
  target: string;
  active: boolean;
  windows: boolean;
  onNavigate?: OverviewNavigate;
}) {
  const [seconds, setSeconds] = useState(5);
  const [paused, setPaused] = useState(false);
  const reading = useOverviewDiagnostics(target, active && !paused, seconds);
  const [network, setNetwork] = useState("");
  const [sort, setSort] = useState<"cpu" | "memory">("cpu");
  const [descending, setDescending] = useState(true);
  const [baselines, setBaselines] = useState<HostBaselineSummary[]>([]);
  const [baselineError, setBaselineError] = useState<string | null>(null);
  const [changes, setChanges] = useState<string[]>([]);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  useEffect(() => {
    if (windows) return;
    let current = true;
    void api
      .listHostBaselines(target)
      .then(async (items) => {
        if (!current) return;
        const recent = [...items]
          .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))
          .slice(0, 4);
        setBaselines(recent);
        if (recent.length < 2) return;
        try {
          const comparison = await api.compareHostBaselines(recent[1].id, recent[0].id);
          if (current)
            setChanges(
              comparison.sections
                .filter(
                  (section) =>
                    section.comparable &&
                    section.added.length + section.removed.length + section.changed.length > 0,
                )
                .map(
                  (section) =>
                    `${sectionLabel(section.kind)}: ${section.added.length} added, ${section.removed.length} removed, ${section.changed.length} changed`,
                ),
            );
        } catch (error) {
          if (current) setComparisonError(errorMessage(error));
        }
      })
      .catch((error) => {
        if (current) setBaselineError(errorMessage(error));
      });
    return () => {
      current = false;
    };
  }, [target, windows]);
  const sample = reading.sample;
  const memory = sample?.memory;
  const status = !reading.enabled
    ? "Paused"
    : reading.stale
      ? "Stale"
      : reading.error
        ? "Unavailable"
        : sample
          ? "Live"
          : "Reading";
  const selectedNetwork =
    network && sample?.interfaces?.some((item) => item.name === network) ? network : "";
  const networkRate = (point: Sample, key: "receiveBytesPerSecond" | "transmitBytesPerSecond") =>
    selectedNetwork
      ? (point.interfaces?.find((item) => item.name === selectedNetwork)?.[key] ?? null)
      : sumRates(
          point.interfaces
            ?.filter((item) => windows || item.name !== "lo")
            .map((item) => item[key]),
        );
  const processes = [...(sample?.processes ?? [])]
    .sort((a, b) => {
      const first = sort === "cpu" ? a.cpuPercent : a.memoryKib;
      const second = sort === "cpu" ? b.cpuPercent : b.memoryKib;
      if (first == null) return second == null ? a.pid - b.pid : 1;
      if (second == null) return -1;
      return (descending ? second - first : first - second) || a.pid - b.pid;
    })
    .slice(0, 20);
  const changeSort = (next: "cpu" | "memory") => {
    setSort(next);
    setDescending(next === sort ? !descending : true);
  };
  const link = (
    view: OverviewDestination,
    label: string,
    baselineId?: string,
    comparisonId?: string,
  ) => (
    <button
      type="button"
      className="diagnostic-link"
      disabled={!onNavigate}
      onClick={() => onNavigate?.(view, baselineId, comparisonId)}
    >
      {label}
      <ArrowUpRight size={13} aria-hidden="true" />
    </button>
  );
  return (
    <>
      <header className="diagnostic-toolbar">
        <div className="diagnostic-title">
          <h2>Overview</h2>
          <span role="status" className="diagnostic-status" data-state={status.toLowerCase()}>
            {status}
          </span>
          <time title={sample?.sampledAt}>{sample ? formatReadingTime(sample.sampledAt) : ""}</time>
        </div>
        <div className="diagnostic-controls">
          <label>
            Refresh{" "}
            <select
              aria-label="Refresh interval"
              value={seconds}
              onChange={(event) => setSeconds(Number(event.target.value))}
            >
              {[2, 5, 10, 30].map((value) => (
                <option key={value} value={value}>
                  {value}s
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setPaused((value) => !value)}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh diagnostics"
            onClick={reading.refresh}
            disabled={reading.sampling || !reading.enabled}
          >
            <RefreshCw size={15} className={reading.sampling ? "spinning" : ""} />
          </button>
        </div>
      </header>
      {reading.error && (
        <p className="inline-warning" role="alert">
          {sample ? "Showing stale readings. " : "Diagnostics unavailable. "}
          {reading.error}
        </p>
      )}
      {!!sample?.warnings.length && <p className="inline-warning">{sample.warnings.join(" · ")}</p>}
      <div className="diagnostic-grid">
        <section className="diagnostic-panel" aria-labelledby="diagnostic-cpu">
          <header>
            <h3 id="diagnostic-cpu">CPU</h3>
            <strong>{formatPercent(sample?.cpuPercent)}</strong>
          </header>
          <HistoryChart
            label="CPU utilization"
            history={reading.history}
            percent
            series={[{ name: "CPU", value: (point) => point.cpuPercent }]}
          />
          <dl className="diagnostic-facts">
            <div>
              <dt>Load 1 / 5 / 15m</dt>
              <dd>
                {sample?.load.length === 3
                  ? sample.load.map((value) => value.toFixed(2)).join(" / ")
                  : windows
                    ? "Unsupported on Windows"
                    : "Unavailable"}
              </dd>
            </div>
            <div>
              <dt>Uptime</dt>
              <dd>{formatUptime(sample?.uptimeSeconds)}</dd>
            </div>
          </dl>
          <details
            className="diagnostic-cores"
            open={!!sample?.cores.length && sample.cores.length <= 16}
          >
            <summary>
              {sample?.cores.length
                ? `${sample.cores.length} logical processors`
                : "Per-core usage unavailable"}
            </summary>
            <div>
              {sample?.cores.map((core) => (
                <div key={core.name} title={`${core.name}: ${formatPercent(core.percent)}`}>
                  <span>{core.name}</span>
                  <meter
                    min="0"
                    max="100"
                    value={core.percent ?? 0}
                    aria-label={`${core.name} usage`}
                    hidden={core.percent == null}
                  />
                  <span>{formatPercent(core.percent)}</span>
                </div>
              ))}
            </div>
          </details>
        </section>
        <section className="diagnostic-panel" aria-labelledby="diagnostic-memory">
          <header>
            <h3 id="diagnostic-memory">Memory</h3>
            <strong>{formatPercent(memoryPercent(memory))}</strong>
          </header>
          <HistoryChart
            label="Memory usage"
            history={reading.history}
            percent
            series={[{ name: "Used", value: (point) => memoryPercent(point.memory) }]}
          />
          <dl className="diagnostic-facts">
            <div>
              <dt>Used / total</dt>
              <dd>
                {kib(
                  memory?.totalKib != null &&
                    memory.availableKib != null &&
                    memoryPercent(memory) != null
                    ? memory.totalKib - memory.availableKib
                    : null,
                )}{" "}
                / {kib(memory?.totalKib)}
              </dd>
            </div>
            <div>
              <dt>Available</dt>
              <dd>{kib(memory?.availableKib)}</dd>
            </div>
            <div>
              <dt>Buffers</dt>
              <dd>{windows ? "Unsupported" : kib(memory?.buffersKib)}</dd>
            </div>
            <div>
              <dt>Cache</dt>
              <dd>{kib(memory?.cacheKib)}</dd>
            </div>
            <div>
              <dt>{windows ? "Page file used / total" : "Swap used / total"}</dt>
              <dd>
                {kib(
                  memory?.swapTotalKib != null &&
                    memory.swapFreeKib != null &&
                    memory.swapFreeKib <= memory.swapTotalKib
                    ? memory.swapTotalKib - memory.swapFreeKib
                    : null,
                )}{" "}
                / {kib(memory?.swapTotalKib)}
              </dd>
            </div>
          </dl>
        </section>
        <section className="diagnostic-panel" aria-labelledby="diagnostic-network">
          <header>
            <h3 id="diagnostic-network">Network</h3>
            <select
              aria-label="Network interface"
              title="Combined traffic includes virtual interfaces and can count the same transfer more than once. Select an interface to isolate traffic."
              value={selectedNetwork}
              onChange={(event) => setNetwork(event.target.value)}
            >
              <option value="">{windows ? "All interfaces" : "All except loopback"}</option>
              {sample?.interfaces?.map((item) => (
                <option key={item.name}>{item.name}</option>
              ))}
            </select>
          </header>
          <HistoryChart
            label="Network traffic"
            history={reading.history}
            series={[
              { name: "Down", value: (point) => networkRate(point, "receiveBytesPerSecond") },
              { name: "Up", value: (point) => networkRate(point, "transmitBytesPerSecond") },
            ]}
          />
          <div className="diagnostic-table-scroll">
            <table>
              <caption className="sr-only">
                Per-interface traffic. Errors and drops are cumulative since the interface started.
              </caption>
              <thead>
                <tr>
                  <th>Interface</th>
                  <th>Down</th>
                  <th>Up</th>
                  <th>Errors</th>
                  <th>Drops</th>
                </tr>
              </thead>
              <tbody>
                {sample?.interfaces?.map((item) => (
                  <tr key={item.name}>
                    <th scope="row">
                      <button className="diagnostic-link" onClick={() => setNetwork(item.name)}>
                        {item.name}
                      </button>
                    </th>
                    <td>{formatByteRate(item.receiveBytesPerSecond)}</td>
                    <td>{formatByteRate(item.transmitBytesPerSecond)}</td>
                    <td>{numeric(item.errors)}</td>
                    <td>{numeric(item.drops)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!sample?.interfaces?.length && (
            <p className="diagnostic-empty">
              {sample?.interfaces ? "No interfaces found" : "Interface counters unavailable"}
            </p>
          )}
        </section>
        <section className="diagnostic-panel" aria-labelledby="diagnostic-processes">
          <header>
            <h3 id="diagnostic-processes">Processes</h3>
            <span title="Up to 20 CPU and 20 memory consumers, limited to processes readable by this account. CPU is a share of total host capacity.">
              Top 20 · {sort === "cpu" ? "CPU" : "Memory"}
            </span>
          </header>
          <div className="diagnostic-table-scroll diagnostic-process-list">
            <table>
              <caption className="sr-only">
                Top visible processes. CPU is a percentage of total host capacity.
              </caption>
              <thead>
                <tr>
                  <th>Process</th>
                  <th>PID</th>
                  <th
                    aria-sort={sort === "cpu" ? (descending ? "descending" : "ascending") : "none"}
                  >
                    <button onClick={() => changeSort("cpu")}>
                      CPU {sort === "cpu" ? (descending ? "↓" : "↑") : ""}
                    </button>
                  </th>
                  <th
                    aria-sort={
                      sort === "memory" ? (descending ? "descending" : "ascending") : "none"
                    }
                  >
                    <button onClick={() => changeSort("memory")}>
                      Memory {sort === "memory" ? (descending ? "↓" : "↑") : ""}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {processes.map((item) => (
                  <tr key={item.pid}>
                    <th scope="row">{item.name}</th>
                    <td>{item.pid}</td>
                    <td>{formatPercent(item.cpuPercent)}</td>
                    <td>{kib(item.memoryKib)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!processes.length && (
            <p className="diagnostic-empty">
              {sample?.processes ? "No visible processes" : "Process counters unavailable"}
            </p>
          )}
        </section>
        <section className="diagnostic-panel diagnostic-wide" aria-labelledby="diagnostic-storage">
          <header>
            <h3 id="diagnostic-storage">Storage</h3>
            <span>Local filesystems · Whole disk I/O</span>
          </header>
          <div className="diagnostic-storage-grid">
            <div className="diagnostic-table-scroll">
              <table>
                <caption className="sr-only">Local filesystem capacity</caption>
                <thead>
                  <tr>
                    <th>Mount / device</th>
                    <th>Used</th>
                    <th>Available</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {sample?.filesystems?.map((fs, index) => (
                    <tr key={`${fs.mount}:${index}`}>
                      <th scope="row">
                        <span title={fs.device}>{fs.mount}</span>
                        <meter
                          min="0"
                          max="100"
                          value={(fs.usedKib / fs.totalKib) * 100}
                          aria-label={`${fs.mount} used`}
                        />
                      </th>
                      <td>
                        {kib(fs.usedKib)}{" "}
                        <small>{Math.round((fs.usedKib / fs.totalKib) * 100)}%</small>
                      </td>
                      <td>{kib(fs.availableKib)}</td>
                      <td>{kib(fs.totalKib)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!sample?.filesystems?.length && (
                <p className="diagnostic-empty">
                  {sample?.filesystems ? "No local filesystems" : "Filesystem capacity unavailable"}
                </p>
              )}
            </div>
            <div>
              <HistoryChart
                label="Disk throughput"
                history={reading.history}
                series={[
                  {
                    name: "Read",
                    value: (point) => sumRates(point.disks?.map((disk) => disk.readBytesPerSecond)),
                  },
                  {
                    name: "Write",
                    value: (point) =>
                      sumRates(point.disks?.map((disk) => disk.writeBytesPerSecond)),
                  },
                ]}
              />
              <div className="diagnostic-table-scroll">
                <table>
                  <caption className="sr-only">Whole disk throughput and I/O statistics</caption>
                  <thead>
                    <tr>
                      <th>Disk</th>
                      <th>Read</th>
                      <th>Write</th>
                      <th>IOPS</th>
                      <th>Busy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sample?.disks?.map((disk) => (
                      <tr key={disk.name}>
                        <th scope="row">{disk.name}</th>
                        <td>{formatByteRate(disk.readBytesPerSecond)}</td>
                        <td>{formatByteRate(disk.writeBytesPerSecond)}</td>
                        <td>{numeric(disk.operationsPerSecond)}</td>
                        <td>{formatPercent(disk.busyPercent)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!sample?.disks?.length && (
                  <p className="diagnostic-empty">
                    {sample?.disks ? "No disks found" : "Disk counters unavailable"}
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>
        <section
          className="diagnostic-panel diagnostic-wide"
          aria-labelledby="diagnostic-workloads"
        >
          <header>
            <h3 id="diagnostic-workloads">Workloads</h3>
            <span title="Workloads refresh every 30 seconds, after a performance reading completes.">
              {reading.workloads
                ? `${!reading.enabled || reading.error || Date.now() - Date.parse(reading.workloads.collectedAt) > 45_000 ? "Stale · " : ""}Read ${formatReadingTime(reading.workloads.collectedAt)}`
                : "Waiting for inventory"}
            </span>
          </header>
          <div className="diagnostic-workloads">
            {(
              [
                ["services", windows ? "Services" : "Systemd", reading.workloads?.services],
                ["docker", "Docker", reading.workloads?.containers],
                ["ports", "Listening ports", reading.workloads?.listeners],
              ] as const
            ).map(([view, label, states]) => (
              <section key={view}>
                <h4>{link(view, label)}</h4>
                <StateSummary states={states} />
              </section>
            ))}
          </div>
          {!!reading.workloads?.warnings.length && (
            <p className="inline-warning">{reading.workloads.warnings.join(" · ")}</p>
          )}
        </section>
        {!windows && (
          <section
            className="diagnostic-panel diagnostic-wide"
            aria-labelledby="diagnostic-baselines"
          >
            <header>
              <h3 id="diagnostic-baselines">Baselines</h3>
              {link("baselines", "Open baselines")}
            </header>
            {!!changes.length && (
              <p className="diagnostic-saved-changes">
                Latest saved comparison · {changes.join(" · ")}
              </p>
            )}
            {comparisonError && (
              <p className="inline-warning">Saved comparison unavailable: {comparisonError}</p>
            )}
            {baselineError ? (
              <p className="inline-warning">{baselineError}</p>
            ) : !baselines.length ? (
              <p className="diagnostic-empty">No saved baselines</p>
            ) : (
              <ul className="diagnostic-baselines">
                {baselines.slice(0, 3).map((baseline, index) => (
                  <li key={baseline.id}>
                    <span>{baseline.label || new Date(baseline.capturedAt).toLocaleString()}</span>
                    <span>
                      {baseline.label ? new Date(baseline.capturedAt).toLocaleString() : ""}
                    </span>
                    {link(
                      "baselines",
                      baseline.changesSincePrevious == null
                        ? "Inspect"
                        : `${baseline.changesSincePrevious} ${baseline.changesSincePrevious === 1 ? "change" : "changes"}`,
                      baseline.id,
                      baselines[index + 1]?.id,
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </>
  );
}
