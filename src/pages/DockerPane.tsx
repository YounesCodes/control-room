import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { RefreshCw, Search } from "lucide-react";
import { CredentialDialog } from "../components/CredentialDialog";
import { DockerContainerInspector } from "../components/DockerContainerInspector";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import {
  composeContainerLabel,
  filterDockerContainers,
  groupDockerContainers,
} from "../lib/docker-compose-grouping";
import { isCacheFresh, reconcileSelection } from "../lib/workspace-cache";
import type {
  CachedList,
  CachedValue,
  DockerContainer,
  DockerContainerDetails,
  LogSourceSelection,
  SavedConnection,
} from "../types";

export function DockerPane({
  connection,
  cache,
  detailsCache,
  onCacheChange,
  onDetailsCacheChange,
  onViewLogs,
  focusId = null,
}: {
  connection: SavedConnection;
  cache: CachedList<DockerContainer>;
  detailsCache: Record<string, CachedValue<DockerContainerDetails>>;
  onCacheChange: (cache: CachedList<DockerContainer>) => void;
  onDetailsCacheChange: (containerId: string, cache: CachedValue<DockerContainerDetails>) => void;
  onViewLogs: (source: LogSourceSelection) => void;
  focusId?: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    () => focusId ?? reconcileSelection(cache.items, null),
  );
  const [search, setSearch] = useState("");
  const [grouped, setGrouped] = useState(true);
  const [sudoPurpose, setSudoPurpose] = useState<"list" | "details" | null>(null);
  const cacheRef = useRef(cache);
  const detailsCacheRef = useRef(detailsCache);
  const requestRef = useRef(0);
  const detailsRequestRef = useRef(0);
  cacheRef.current = cache;
  detailsCacheRef.current = detailsCache;

  async function load(password: string | null = null, force = false) {
    const current = cacheRef.current;
    if (!force && !password && isCacheFresh(current)) return;
    const request = ++requestRef.current;
    onCacheChange({ ...current, loading: true, error: null });
    try {
      const items = await api.listContainers(connection.id, password);
      if (request !== requestRef.current) return;
      onCacheChange({ items, fetchedAt: Date.now(), loading: false, error: null });
      setSelectedId((selected) =>
        selected && selected === focusId && !items.some((container) => container.id === selected)
          ? selected
          : reconcileSelection(items, selected),
      );
      setSudoPurpose(null);
    } catch (caught) {
      if (request !== requestRef.current) return;
      onCacheChange({
        ...cacheRef.current,
        loading: false,
        error: errorMessage(caught),
      });
    }
  }

  async function loadDetails(containerId: string, password: string | null = null, force = false) {
    const current = detailsCacheRef.current[containerId] ?? {
      value: null,
      fetchedAt: null,
      loading: false,
      error: null,
    };
    if (!force && !password && isCacheFresh(current)) return;
    const request = ++detailsRequestRef.current;
    onDetailsCacheChange(containerId, { ...current, loading: true, error: null });
    try {
      const value = await api.inspectContainer(connection.id, containerId, password);
      if (request !== detailsRequestRef.current) return;
      onDetailsCacheChange(containerId, {
        value,
        fetchedAt: Date.now(),
        loading: false,
        error: null,
      });
      setSudoPurpose(null);
    } catch (caught) {
      if (request !== detailsRequestRef.current) return;
      const error = errorMessage(caught);
      onDetailsCacheChange(containerId, {
        ...current,
        value: error.includes("no longer exists") ? null : current.value,
        loading: false,
        error,
      });
    }
  }

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
      detailsRequestRef.current += 1;
    };
  }, [connection.id]);

  useEffect(() => {
    if (!cache.items.length) return;
    setSelectedId((selected) =>
      selected &&
      selected === focusId &&
      !cache.items.some((container) => container.id === selected)
        ? selected
        : reconcileSelection(cache.items, selected),
    );
  }, [cache.items]);

  useEffect(() => {
    if (focusId) setSelectedId(focusId);
  }, [focusId]);

  useEffect(() => {
    if (selectedId) void loadDetails(selectedId);
  }, [selectedId]);

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
              <button onClick={() => setSudoPurpose("list")}>Retry with sudo</button>
            ) : (
              <button onClick={() => load(null, true)}>Retry</button>
            )
          }
        />
        {sudoPurpose === "list" && (
          <CredentialDialog
            connectionLabel={connection.displayName}
            onClose={() => setSudoPurpose(null)}
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
      <aside className="detail-panel container-inspector-panel">
        {selected ? (
          <DockerContainerInspector
            key={selected.id}
            summary={selected}
            cache={detailsCache[selected.id]}
            onRefresh={() => loadDetails(selected.id, null, true)}
            onRetryWithSudo={() => setSudoPurpose("details")}
            onViewLogs={() => onViewLogs({ type: "docker", id: selected.id })}
          />
        ) : selectedId && cache.fetchedAt ? (
          <EmptyState title={`${selectedId} was not found`}>
            The exact container saved in this Workspace Preset is not present on this host. Other
            preset views remain available.
          </EmptyState>
        ) : (
          <EmptyState title="Select a container" />
        )}
      </aside>
      {sudoPurpose && (
        <CredentialDialog
          connectionLabel={connection.displayName}
          onClose={() => setSudoPurpose(null)}
          onSubmit={(password) =>
            sudoPurpose === "list" || !selected
              ? load(password, true)
              : loadDetails(selected.id, password, true)
          }
        />
      )}
    </section>
  );
}
