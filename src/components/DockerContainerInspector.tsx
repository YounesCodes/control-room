import { useState } from "react";
import { FileClock, RefreshCw } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "./PanelState";
import type { CachedValue, DockerContainer, DockerContainerDetails } from "../types";

type InspectorTab = "overview" | "ports" | "networks" | "mounts" | "metadata";

const tabs: { id: InspectorTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "ports", label: "Ports" },
  { id: "networks", label: "Networks" },
  { id: "mounts", label: "Mounts" },
  { id: "metadata", label: "Metadata" },
];

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
        <dt>Finished</dt>
        <dd>{displayTime(details.finishedAt)}</dd>
      </div>
      <div>
        <dt>Restart policy</dt>
        <dd>
          {details.restartPolicy || "None"}
          {details.restartMaximumRetryCount ? ` · ${details.restartMaximumRetryCount} retries` : ""}
        </dd>
      </div>
    </dl>
  );
}

function Ports({ details }: { details: DockerContainerDetails }) {
  if (!details.publishedPorts.length) return <EmptyState title="No published ports" />;
  return (
    <div className="inspector-record-list">
      {details.publishedPorts.map((port) => (
        <div
          className="inspector-record"
          key={`${port.hostAddress}:${port.hostPort}:${port.containerPort}`}
        >
          <strong>
            {port.hostAddress}:{port.hostPort}
          </strong>
          <span>to {port.containerPort}</span>
        </div>
      ))}
    </div>
  );
}

function Networks({ details }: { details: DockerContainerDetails }) {
  if (!details.networks.length) return <EmptyState title="No network attachments" />;
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
  if (!details.mounts.length) return <EmptyState title="No mounts" />;
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
        <EmptyState title="No validated Compose identity" />
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
}: {
  summary: DockerContainer;
  cache?: CachedValue<DockerContainerDetails>;
  onRefresh: () => void;
  onRetryWithSudo: () => void;
  onViewLogs: () => void;
}) {
  const [activeTab, setActiveTab] = useState<InspectorTab>("overview");
  const permissionError = cache?.error?.toLowerCase().includes("permission denied");
  const collectedAt = cache?.fetchedAt
    ? new Date(cache.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  if (cache?.loading && !cache.value) return <LoadingState label="Inspecting container…" />;
  if (cache?.error && !cache.value) {
    return (
      <ErrorState
        message={cache.error}
        action={
          <button onClick={permissionError ? onRetryWithSudo : onRefresh}>
            {permissionError ? "Retry with sudo" : "Retry"}
          </button>
        }
      />
    );
  }
  const details = cache?.value;
  if (!details) return <LoadingState label="Inspecting container…" />;

  return (
    <>
      <header className="container-inspector-heading">
        <div>
          <h2>{details.name || summary.name}</h2>
          <p>
            {details.state}
            {details.healthStatus ? ` · ${details.healthStatus}` : ""}
            {collectedAt ? ` · inspected at ${collectedAt}` : ""}
          </p>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={onRefresh}
          aria-label="Refresh container details"
          disabled={cache?.loading}
        >
          <RefreshCw size={16} className={cache?.loading ? "spinning" : ""} />
        </button>
      </header>
      {cache?.error && (
        <p className="inline-warning">Showing saved details. Refresh failed: {cache.error}</p>
      )}
      <div className="inspector-tabs" role="tablist" aria-label="Container detail sections">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="inspector-tab-panel" role="tabpanel">
        {activeTab === "overview" && <Overview details={details} />}
        {activeTab === "ports" && <Ports details={details} />}
        {activeTab === "networks" && <Networks details={details} />}
        {activeTab === "mounts" && <Mounts details={details} />}
        {activeTab === "metadata" && <Metadata details={details} />}
      </div>
      <button className="secondary-button container-log-action" type="button" onClick={onViewLogs}>
        <FileClock size={15} /> View logs
      </button>
    </>
  );
}
