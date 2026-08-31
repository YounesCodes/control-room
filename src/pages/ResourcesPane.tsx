import { useEffect, useRef, useState } from "react";
import { AlertCircle, RefreshCw, X } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import type { ResourceSection, ResourceSnapshot, SavedConnection } from "../types";

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return value === 0 ? "0 B" : "Unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** exponent).toFixed(exponent > 2 ? 1 : 0)} ${units[exponent]}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function collectedLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleTimeString();
}

function SectionError({ message, collectedAt }: { message: string; collectedAt: string }) {
  return (
    <div className="resource-section-error" role="status">
      <AlertCircle size={15} />
      <span>{message}</span>
      <small>Checked {collectedLabel(collectedAt)}</small>
    </div>
  );
}

function SectionHeading({ title, collectedAt }: { title: string; collectedAt: string }) {
  return (
    <header className="resource-section-heading">
      <h3>{title}</h3>
      <span>Collected {collectedLabel(collectedAt)}</span>
    </header>
  );
}

function sectionError<T>(section: ResourceSection<T>): section is ResourceSection<T> & {
  data: null;
  error: string;
} {
  return section.data === null && section.error !== null;
}

export function ResourcesPane({
  connection,
  snapshot,
  onSnapshotChange,
}: {
  connection: SavedConnection;
  snapshot: ResourceSnapshot | null;
  onSnapshotChange: (snapshot: ResourceSnapshot) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationRef = useRef<string | null>(null);

  async function collect() {
    if (operationRef.current) return;
    const operationId = crypto.randomUUID();
    operationRef.current = operationId;
    setLoading(true);
    setError(null);
    try {
      await api.beginResourceCollection(operationId);
      if (operationRef.current !== operationId) {
        await api.cancelResourceCollection(operationId).catch(() => undefined);
        return;
      }
      const next = await api.collectResources(connection.id, operationId);
      if (operationRef.current !== operationId) return;
      onSnapshotChange(next);
    } catch (caught) {
      if (operationRef.current !== operationId) return;
      setError(errorMessage(caught));
    } finally {
      if (operationRef.current === operationId) {
        operationRef.current = null;
        setLoading(false);
      }
    }
  }

  function cancel() {
    const operationId = operationRef.current;
    if (!operationId) return;
    operationRef.current = null;
    setLoading(false);
    setError(null);
    void api.cancelResourceCollection(operationId).catch(() => undefined);
  }

  useEffect(() => {
    void collect();
    return () => cancel();
  }, [connection.id]);

  const cpu = snapshot?.cpu.data;
  const memory = snapshot?.memory.data;
  const memoryUsedPercent = memory?.totalBytes ? (memory.usedBytes / memory.totalBytes) * 100 : 0;
  const swapUsedPercent = memory?.swapTotalBytes
    ? (memory.swapUsedBytes / memory.swapTotalBytes) * 100
    : 0;

  return (
    <section className="feature-page resources-page">
      <header className="page-heading resources-heading">
        <div>
          <h2>Resources</h2>
          <p>Bounded current facts, collected only on request</p>
          {snapshot && <small>Sample collected {collectedLabel(snapshot.collectedAt)}</small>}
        </div>
        {loading ? (
          <button className="secondary-button" type="button" onClick={cancel}>
            <X size={15} /> Cancel
          </button>
        ) : (
          <button className="secondary-button" type="button" onClick={() => void collect()}>
            <RefreshCw size={15} /> Refresh
          </button>
        )}
      </header>

      {error && (
        <div className="inline-error" role="alert">
          {snapshot ? `Refresh failed: ${error}` : error}
        </div>
      )}
      {loading && snapshot && <p className="inline-warning">Refreshing the current sample…</p>}

      {!snapshot ? (
        <div className="panel-state resource-initial-state" aria-live="polite">
          {loading ? <span className="spinner" /> : <AlertCircle size={22} />}
          <h3>{loading ? "Collecting current resources" : "No resource sample"}</h3>
          <p>
            {loading
              ? "Reading a bounded CPU, memory, filesystem, and process snapshot."
              : "Refresh to collect a current resource snapshot."}
          </p>
        </div>
      ) : (
        <div className="resource-sections">
          <section className="resource-section">
            <SectionHeading title="CPU load" collectedAt={snapshot.cpu.collectedAt} />
            {sectionError(snapshot.cpu) ? (
              <SectionError message={snapshot.cpu.error} collectedAt={snapshot.cpu.collectedAt} />
            ) : cpu ? (
              <div className="resource-summary-grid">
                <div>
                  <span>1 minute</span>
                  <strong>{cpu.loadOne.toFixed(2)}</strong>
                </div>
                <div>
                  <span>5 minutes</span>
                  <strong>{cpu.loadFive.toFixed(2)}</strong>
                </div>
                <div>
                  <span>15 minutes</span>
                  <strong>{cpu.loadFifteen.toFixed(2)}</strong>
                </div>
                <div>
                  <span>Logical CPUs</span>
                  <strong>{cpu.cpuCount}</strong>
                </div>
                <p>
                  Load is shown against {cpu.cpuCount} logical CPUs; it is not a CPU percentage.
                </p>
              </div>
            ) : null}
          </section>

          <section className="resource-section">
            <SectionHeading title="Memory and swap" collectedAt={snapshot.memory.collectedAt} />
            {sectionError(snapshot.memory) ? (
              <SectionError
                message={snapshot.memory.error}
                collectedAt={snapshot.memory.collectedAt}
              />
            ) : memory ? (
              <dl className="resource-definition-list">
                <div>
                  <dt>Memory used</dt>
                  <dd>
                    {formatBytes(memory.usedBytes)} / {formatBytes(memory.totalBytes)} ·{" "}
                    {formatPercent(memoryUsedPercent)}
                  </dd>
                </div>
                <div>
                  <dt>Memory available</dt>
                  <dd>{formatBytes(memory.availableBytes)}</dd>
                </div>
                <div>
                  <dt>Swap used</dt>
                  <dd>
                    {formatBytes(memory.swapUsedBytes)} / {formatBytes(memory.swapTotalBytes)} ·{" "}
                    {formatPercent(swapUsedPercent)}
                  </dd>
                </div>
              </dl>
            ) : null}
          </section>

          <section className="resource-section resource-section-wide">
            <SectionHeading title="Filesystems" collectedAt={snapshot.filesystems.collectedAt} />
            {sectionError(snapshot.filesystems) ? (
              <SectionError
                message={snapshot.filesystems.error}
                collectedAt={snapshot.filesystems.collectedAt}
              />
            ) : snapshot.filesystems.data ? (
              <div className="resource-table-scroll">
                <table className="resource-table">
                  <thead>
                    <tr>
                      <th>Mount point</th>
                      <th>Type</th>
                      <th>Used</th>
                      <th>Available</th>
                      <th>Usage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.filesystems.data.map((filesystem, index) => (
                      <tr key={`${filesystem.mountPoint}-${index}`}>
                        <td className="resource-mono">{filesystem.mountPoint}</td>
                        <td>{filesystem.filesystemType}</td>
                        <td>
                          {formatBytes(filesystem.usedBytes)} / {formatBytes(filesystem.totalBytes)}
                        </td>
                        <td>{formatBytes(filesystem.availableBytes)}</td>
                        <td>{filesystem.usedPercent}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!snapshot.filesystems.data.length && (
                  <p className="resource-empty">No filesystems returned.</p>
                )}
              </div>
            ) : null}
          </section>

          <section className="resource-section resource-section-wide">
            <SectionHeading title="Top processes" collectedAt={snapshot.processes.collectedAt} />
            {sectionError(snapshot.processes) ? (
              <SectionError
                message={snapshot.processes.error}
                collectedAt={snapshot.processes.collectedAt}
              />
            ) : snapshot.processes.data ? (
              <>
                <p className="resource-section-note">
                  {snapshot.processes.data.sort}; limited to {snapshot.processes.data.limit} rows.
                  Command arguments are not collected.
                </p>
                <div className="resource-table-scroll">
                  <table className="resource-table">
                    <thead>
                      <tr>
                        <th>PID</th>
                        <th>User</th>
                        <th>Name</th>
                        <th>CPU</th>
                        <th>Memory</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.processes.data.rows.map((process) => (
                        <tr key={process.pid}>
                          <td>{process.pid}</td>
                          <td>{process.user}</td>
                          <td className="resource-mono">{process.name}</td>
                          <td>{formatPercent(process.cpuPercent)}</td>
                          <td>{formatPercent(process.memoryPercent)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}
          </section>
        </div>
      )}
    </section>
  );
}
