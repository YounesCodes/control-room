import { useEffect, useMemo, useRef, useState } from "react";
import { FileClock, RefreshCw, Search } from "lucide-react";
import { CredentialDialog } from "../components/CredentialDialog";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import { isCacheFresh, reconcileSelection } from "../lib/workspace-cache";
import type { CachedList, DockerContainer, LogSourceSelection, SavedConnection } from "../types";

export function DockerPane({
  connection,
  cache,
  onCacheChange,
  onViewLogs,
}: {
  connection: SavedConnection;
  cache: CachedList<DockerContainer>;
  onCacheChange: (cache: CachedList<DockerContainer>) => void;
  onViewLogs: (source: LogSourceSelection) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    reconcileSelection(cache.items, null),
  );
  const [search, setSearch] = useState("");
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
    setSelectedId((selected) => reconcileSelection(cache.items, selected));
  }, [cache.items]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return cache.items;
    return cache.items.filter(
      (container) =>
        container.name.toLowerCase().includes(query) ||
        container.image.toLowerCase().includes(query),
    );
  }, [cache.items, search]);
  const selected = cache.items.find((container) => container.id === selectedId) ?? null;
  const permissionError = cache.error?.toLowerCase().includes("permission denied");

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
        <label className="search-field">
          <Search size={15} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search containers"
          />
        </label>
        <div className="dense-list">
          {filtered.map((container) => (
            <button
              className={container.id === selectedId ? "dense-row selected-row" : "dense-row"}
              type="button"
              key={container.id}
              onClick={() => setSelectedId(container.id)}
            >
              <span className={`service-indicator service-${container.state}`} />
              <span className="row-main">
                <strong>{container.name}</strong>
                <small>{container.image}</small>
              </span>
              <span className="row-state">{container.state}</span>
            </button>
          ))}
          {!filtered.length && (
            <EmptyState
              title={cache.items.length ? "No matching containers" : "No containers found"}
            >
              Docker returned an empty container list.
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
