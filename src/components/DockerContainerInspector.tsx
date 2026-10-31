import type { PublishedPortSelection } from "../lib/port-inspector";
import { FileClock, RefreshCw } from "lucide-react";
import { ErrorState, LoadingState } from "./PanelState";
import type { CachedValue, DockerContainer, DockerContainerDetails } from "../types";

function displayTime(value: string | null) {
  if (!value) return "Not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function Overview({ details }: { details: DockerContainerDetails }) {
  const flags = [
    details.paused && "paused",
    details.restarting && "restarting",
    details.oomKilled && "OOM killed",
    details.dead && "dead",
  ].filter(Boolean);
  return (
    <>
      <dl className="detail-list container-detail-list">
        <div>
          <dt>State</dt>
          <dd>
            {details.state}
            {flags.length ? ` · ${flags.join(", ")}` : ""}
          </dd>
        </div>
        <div>
          <dt>Health</dt>
          <dd>
            {details.healthStatus ?? "No health check"}
            {details.failingStreak ? ` · ${details.failingStreak} failures` : ""}
          </dd>
        </div>
        <div>
          <dt>Exit code</dt>
          <dd>{details.exitCode}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{displayTime(details.startedAt)}</dd>
        </div>
        <div>
          <dt>{details.running ? "Previous stop" : "Finished"}</dt>
          <dd>{displayTime(details.finishedAt)}</dd>
        </div>
        <div>
          <dt>Restart policy</dt>
          <dd>
            {details.restartPolicy || "None"}
            {details.restartMaximumRetryCount
              ? ` · ${details.restartMaximumRetryCount} retries`
              : ""}
          </dd>
        </div>
      </dl>
      <details className="container-technical-details">
        <summary>Technical identifiers</summary>
        <dl className="detail-list container-detail-list">
          <div>
            <dt>Container ID</dt>
            <dd className="technical">{details.id}</dd>
          </div>
          <div>
            <dt>Image reference</dt>
            <dd className="technical">{details.imageReference || "Unknown"}</dd>
          </div>
          <div>
            <dt>Image content ID</dt>
            <dd className="technical">{details.imageContentId || "Unknown"}</dd>
          </div>
        </dl>
      </details>
    </>
  );
}

function Ports({
  details,
  onOpenPort,
}: {
  details: DockerContainerDetails;
  onOpenPort?: (port: PublishedPortSelection) => void;
}) {
  if (!details.publishedPorts.length) return <p className="inspector-empty">No published ports</p>;
  return (
    <div className="docker-published-ports">
      {details.publishedPorts.map((port) => (
        <button
          type="button"
          className="secondary-button"
          key={port.hostAddress + ":" + port.hostPort + ":" + port.containerPort}
          aria-label={
            "Open " +
            (port.hostAddress.includes(":") ? "[" + port.hostAddress + "]" : port.hostAddress) +
            ":" +
            port.hostPort +
            " → " +
            port.containerPort +
            " in Ports"
          }
          onClick={() => onOpenPort?.({ ...port, containerId: details.id })}
        >
          {port.hostAddress.includes(":") ? "[" + port.hostAddress + "]" : port.hostAddress}:
          {port.hostPort} → {port.containerPort}
        </button>
      ))}
    </div>
  );
}

function Networks({ details }: { details: DockerContainerDetails }) {
  if (!details.networks.length) return <p className="inspector-empty">No network attachments</p>;
  return (
    <div className="inspector-record-list">
      {details.networks.map((network) => (
        <div className="inspector-record inspector-record-stacked" key={network.name}>
          <strong>{network.name}</strong>
          <span>
            IPv4 {network.ipv4Address ?? "not assigned"}
            {network.ipv4Gateway ? ` · gateway ${network.ipv4Gateway}` : ""}
          </span>
          {(network.ipv6Address || network.ipv6Gateway) && (
            <span>
              IPv6 {network.ipv6Address ?? "not assigned"}
              {network.ipv6Gateway ? ` · gateway ${network.ipv6Gateway}` : ""}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function Mounts({ details }: { details: DockerContainerDetails }) {
  if (!details.mounts.length) return <p className="inspector-empty">No mounts</p>;
  return (
    <div className="inspector-record-list">
      {details.mounts.map((mount) => (
        <div
          className="inspector-record inspector-record-stacked"
          key={`${mount.mountType}:${mount.destination}`}
        >
          <strong>{mount.destination}</strong>
          <span>
            {mount.mountType}
            {mount.name ? ` · ${mount.name}` : ""} · {mount.writable ? "read/write" : "read-only"}
          </span>
          {mount.propagation && <span>Propagation {mount.propagation}</span>}
        </div>
      ))}
    </div>
  );
}

function Metadata({ details }: { details: DockerContainerDetails }) {
  return (
    <>
      {details.composeProject && details.composeService ? (
        <dl className="detail-list container-detail-list">
          <div>
            <dt>Compose project</dt>
            <dd>{details.composeProject}</dd>
          </div>
          <div>
            <dt>Compose service</dt>
            <dd>{details.composeService}</dd>
          </div>
          <div>
            <dt>Compose instance</dt>
            <dd>
              {details.composeContainerNumber
                ? `Replica ${details.composeContainerNumber}`
                : "Unnumbered"}
              {details.composeOneoff ? " · one-off" : ""}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="inspector-empty">No validated Compose identity</p>
      )}
      <p className="sensitive-data-note">
        Environment values, command arguments, arbitrary labels, health logs, and host mount sources
        are not collected.
      </p>
    </>
  );
}

export function DockerContainerInspector({
  summary,
  cache,
  onRefresh,
  onRetryWithSudo,
  onViewLogs,
  windowsHost = false,
  onOpenPort,
}: {
  onOpenPort?: (port: PublishedPortSelection) => void;
  summary: DockerContainer;
  cache?: CachedValue<DockerContainerDetails>;
  onRefresh: () => void;
  onRetryWithSudo: () => void;
  onViewLogs: () => void;
  windowsHost?: boolean;
}) {
  const permissionError = !windowsHost && cache?.error?.toLowerCase().includes("permission denied");
  const collectedAt = cache?.fetchedAt
    ? new Date(cache.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  const details = cache?.value;

  return (
    <>
      <header className="container-inspector-heading">
        <div>
          <h2>{details?.name || summary.name}</h2>
          <p>
            {details?.state ?? summary.state}
            {details?.healthStatus ? ` · ${details.healthStatus}` : ""}
            {collectedAt ? ` · inspected at ${collectedAt}` : ""}
          </p>
        </div>
      </header>
      <div
        className="port-inspector-body"
        tabIndex={0}
        role="region"
        aria-label="Container information"
      >
        {cache?.error && !details ? (
          <ErrorState
            message={cache.error}
            action={
              <button onClick={permissionError ? onRetryWithSudo : onRefresh}>
                {permissionError ? "Retry with sudo" : "Retry"}
              </button>
            }
          />
        ) : !details ? (
          <LoadingState label="Inspecting container…" />
        ) : (
          <>
            {cache?.error && (
              <p className="inline-warning">Showing saved details. Refresh failed: {cache.error}</p>
            )}
            <Overview details={details} />
            <details className="port-disclosure">
              <summary>Published ports</summary>
              <Ports details={details} onOpenPort={onOpenPort} />
            </details>
            <details className="port-disclosure">
              <summary>Networks</summary>
              <Networks details={details} />
            </details>
            <details className="port-disclosure">
              <summary>Mounts</summary>
              <Mounts details={details} />
            </details>
            <details className="port-disclosure">
              <summary>Container &amp; Compose</summary>
              <Metadata details={details} />
            </details>
          </>
        )}
      </div>
      <div className="detail-actions">
        <button className="secondary-button" type="button" onClick={onViewLogs}>
          <FileClock size={15} /> View logs
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={onRefresh}
          aria-label="Refresh container details"
          title="Refresh container details"
          disabled={cache?.loading}
        >
          <RefreshCw size={16} className={cache?.loading ? "spinning" : ""} />
        </button>
      </div>
    </>
  );
}
