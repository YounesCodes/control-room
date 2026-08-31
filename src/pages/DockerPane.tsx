import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { FileClock, RefreshCw, Search } from "lucide-react";
import { CredentialDialog } from "../components/CredentialDialog";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import {
  composeContainerLabel,
  filterDockerContainers,
  groupDockerContainers,
} from "../lib/docker-compose-grouping";
import { isCacheFresh, reconcileSelection } from "../lib/workspace-cache";
import type { CachedList, DockerContainer, LogSourceSelection, SavedConnection } from "../types";

export function DockerPane({
  connection,
  cache,
  onCacheChange,
  onViewLogs,
  focusId = null,
}: {
  connection: SavedConnection;
  cache: CachedList<DockerContainer>;
  onCacheChange: (cache: CachedList<DockerContainer>) => void;
  onViewLogs: (source: LogSourceSelection) => void;
  focusId?: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    () => focusId ?? reconcileSelection(cache.items, null),
  );
  const [search, setSearch] = useState("");
  const [grouped, setGrouped] = useState(true);
  const [requestSudo, setRequestSudo] = useState(false);
  const cacheRef = useRef(cache);
  const requestRef = useRef(0);
  cacheRef.current = cache;

  async function load(password: string | null = null, force = false) {
    const current = cacheRef.current;
    if (!force && !password && isCacheFresh(current)) return;
    const request = ++requestRef.current;
    onCacheChange({ ...current, loading: true, error: null });
    try {
      const items = await api.listContainers(connection.id, password);
      if (request !== requestRef.current) return;
      onCacheChange({ items, fetchedAt: Date.now(), loading: false, error: null });
      setSelectedId((selected) => reconcileSelection(items, selected));
      setRequestSudo(false);
    } catch (caught) {
      if (request !== requestRef.current) return;
      onCacheChange({
        ...cacheRef.current,
        loading: false,
        error: errorMessage(caught),
      });
    }
  }

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [connection.id]);

  useEffect(() => {
    if (!cache.items.length) return;
    setSelectedId((selected) => reconcileSelection(cache.items, selected));
  }, [cache.items]);

  useEffect(() => {
    if (focusId) setSelectedId(focusId);
  }, [focusId]);

  const filtered = useMemo(
    () => filterDockerContainers(cache.items, search),
    [cache.items, search],
  );
  const groups = useMemo(() => groupDockerContainers(cache.items, search), [cache.items, search]);
  const visibleCount = grouped
    ? groups.reduce((total, group) => total + group.containers.length, 0)
    : filtered.length;
  const selected = cache.items.find((container) => container.id === selectedId) ?? null;
  const permissionError = cache.error?.toLowerCase().includes("permission denied");

  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-container-id]"),
    );
    if (!rows.length) return;
    const current = rows.indexOf(event.target as HTMLButtonElement);
    let next = current;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = rows.length - 1;
    if (event.key === "ArrowDown") next = Math.min(current + 1, rows.length - 1);
    if (event.key === "ArrowUp") next = Math.max(current - 1, 0);
    if (next < 0) next = 0;
    event.preventDefault();
    rows[next].focus();
  }

  function renderContainer(container: DockerContainer, showComposeIdentity: boolean) {
    return (
      <button
        className={container.id === selectedId ? "dense-row selected-row" : "dense-row"}
        type="button"
        key={container.id}
        data-container-id={container.id}
        onClick={() => setSelectedId(container.id)}
      >
        <span className={`service-indicator service-${container.state}`} />
        <span className="row-main">
          <strong>{showComposeIdentity ? composeContainerLabel(container) : container.name}</strong>
          <small>
            {showComposeIdentity
              ? `${container.name} · ${container.id.slice(0, 12)}`
              : container.image}
          </small>
        </span>
        <span className="row-state">{container.state}</span>
      </button>
    );
  }

  if (cache.loading && !cache.items.length)
    return <LoadingState label="Reading Docker containers…" />;
  if (cache.error && !cache.items.length) {
    return (
      <>
        <ErrorState
          message={cache.error}
          action={
            permissionError ? (
              <button onClick={() => setRequestSudo(true)}>Retry with sudo</button>
            ) : (
              <button onClick={() => load(null, true)}>Retry</button>
            )
          }
        />
        {requestSudo && (
          <CredentialDialog
            connectionLabel={connection.displayName}
            onClose={() => setRequestSudo(false)}
            onSubmit={(password) => load(password, true)}
          />
        )}
      </>
    );
  }

  return (
    <section className="feature-page split-page">
      <div className="list-panel">
        <header className="page-heading compact-heading">
          <div>
            <h2>Containers</h2>
            <p>
              {cache.items.filter((container) => container.state === "running").length} running ·{" "}
              {cache.items.length} total
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={() => load(null, true)}
            aria-label="Refresh containers"
            disabled={cache.loading}
          >
            <RefreshCw size={16} className={cache.loading ? "spinning" : ""} />
          </button>
        </header>
        {cache.error && (
          <p className="inline-warning">Showing saved results. Refresh failed: {cache.error}</p>
        )}
        <div className="docker-list-controls">
          <label className="search-field">
            <Search size={15} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search projects, services, or containers"
            />
          </label>
          <div className="view-toggle" aria-label="Container list layout">
            <button type="button" aria-pressed={grouped} onClick={() => setGrouped(true)}>
              Grouped
            </button>
            <button type="button" aria-pressed={!grouped} onClick={() => setGrouped(false)}>
              Flat
            </button>
          </div>
        </div>
        <div className="dense-list" onKeyDown={handleListKeyDown}>
          {grouped
            ? groups.map((group) => (
                <section className="container-group" key={group.id}>
                  <header className="container-group-heading">
                    <h3>{group.label}</h3>
                    <span>{group.containers.length}</span>
                  </header>
                  {group.containers.map((container) => renderContainer(container, true))}
                </section>
              ))
            : filtered.map((container) => renderContainer(container, false))}
          {!visibleCount && (
            <EmptyState
              title={cache.items.length ? "No matching containers" : "No containers found"}
            >
              {cache.items.length
                ? "No project, service, or container matches this search."
                : "Docker returned an empty container list."}
            </EmptyState>
          )}
        </div>
      </div>
      <aside className="detail-panel">
        {selected ? (
          <>
            <header>
              <h2>{selected.name}</h2>
              <p>{selected.image}</p>
            </header>
            <dl className="detail-list">
              <div>
                <dt>Container ID</dt>
                <dd className="technical">{selected.id.slice(0, 16)}</dd>
              </div>
              <div>
                <dt>State</dt>
                <dd>{selected.state}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{selected.status}</dd>
              </div>
              <div>
                <dt>Ports</dt>
                <dd className="technical">{selected.ports || "None published"}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{selected.createdAt}</dd>
              </div>
              {selected.composeProject && selected.composeService && (
                <>
                  <div>
                    <dt>Compose project</dt>
                    <dd>{selected.composeProject}</dd>
                  </div>
                  <div>
                    <dt>Compose service</dt>
                    <dd>{selected.composeService}</dd>
                  </div>
                  <div>
                    <dt>Compose instance</dt>
                    <dd>
                      {selected.composeContainerNumber
                        ? `Replica ${selected.composeContainerNumber}`
                        : "Unnumbered"}
                      {selected.composeOneoff ? " · one-off" : ""}
                    </dd>
                  </div>
                </>
              )}
            </dl>
            <button
              className="secondary-button"
              type="button"
              onClick={() => onViewLogs({ type: "docker", id: selected.id })}
            >
              <FileClock size={15} /> View logs
            </button>
          </>
        ) : (
          <EmptyState title="Select a container" />
        )}
      </aside>
      {requestSudo && (
        <CredentialDialog
          connectionLabel={connection.displayName}
          onClose={() => setRequestSudo(false)}
          onSubmit={(password) => load(password, true)}
        />
      )}
    </section>
  );
}
