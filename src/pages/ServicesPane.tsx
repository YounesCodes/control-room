import { useEffect, useMemo, useRef, useState } from "react";
import { FileClock, RefreshCw, Search } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import { isCacheFresh, reconcileSelection } from "../lib/workspace-cache";
import type { CachedList, LogSourceSelection, SavedConnection, SystemdService } from "../types";

export function ServicesPane({
  connection,
  cache,
  onCacheChange,
  onViewLogs,
}: {
  connection: SavedConnection;
  cache: CachedList<SystemdService>;
  onCacheChange: (cache: CachedList<SystemdService>) => void;
  onViewLogs: (source: LogSourceSelection) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    reconcileSelection(cache.items, null),
  );
  const [search, setSearch] = useState("");
  const cacheRef = useRef(cache);
  const requestRef = useRef(0);
  cacheRef.current = cache;

  async function load(force = false) {
    const current = cacheRef.current;
    if (!force && isCacheFresh(current)) return;
    const request = ++requestRef.current;
    onCacheChange({ ...current, loading: true, error: null });
    try {
      const items = await api.listServices(connection.id);
      if (request !== requestRef.current) return;
      onCacheChange({ items, fetchedAt: Date.now(), loading: false, error: null });
      setSelectedId((selected) => reconcileSelection(items, selected));
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
      (service) =>
        service.id.toLowerCase().includes(query) ||
        service.description.toLowerCase().includes(query),
    );
  }, [search, cache.items]);
  const selected = cache.items.find((service) => service.id === selectedId) ?? null;

  if (cache.loading && !cache.items.length)
    return <LoadingState label="Reading systemd services…" />;
  if (cache.error && !cache.items.length) {
    return (
      <ErrorState
        message={cache.error}
        action={<button onClick={() => load(true)}>Retry</button>}
      />
    );
  }

  return (
    <section className="feature-page split-page">
      <div className="list-panel">
        <header className="page-heading compact-heading">
          <div>
            <h2>Services</h2>
            <p>{cache.items.length} units</p>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={() => load(true)}
            aria-label="Refresh services"
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
            placeholder="Search services"
          />
        </label>
        <div className="dense-list">
          {filtered.map((service) => (
            <button
              className={service.id === selectedId ? "dense-row selected-row" : "dense-row"}
              type="button"
              key={service.id}
              onClick={() => setSelectedId(service.id)}
            >
              <span className={`service-indicator service-${service.activeState}`} />
              <span className="row-main">
                <strong>{service.id}</strong>
                <small>{service.description || "No description"}</small>
              </span>
              <span className="row-state">{service.subState}</span>
            </button>
          ))}
          {!filtered.length && (
            <EmptyState title={cache.items.length ? "No matching services" : "No services found"} />
          )}
        </div>
      </div>
      <aside className="detail-panel">
        {selected ? (
          <>
            <header>
              <h2>{selected.id}</h2>
              <p>{selected.description || "No description"}</p>
            </header>
            <dl className="detail-list">
              <div>
                <dt>State</dt>
                <dd>
                  {selected.activeState} / {selected.subState}
                </dd>
              </div>
              <div>
                <dt>Load state</dt>
                <dd>{selected.loadState}</dd>
              </div>
              <div>
                <dt>Unit-file state</dt>
                <dd>{selected.unitFileState ?? "Unknown"}</dd>
              </div>
            </dl>
            <button
              className="secondary-button"
              type="button"
              onClick={() => onViewLogs({ type: "systemd", id: selected.id })}
            >
              <FileClock size={15} /> View logs
            </button>
          </>
        ) : (
          <EmptyState title="Select a service" />
        )}
      </aside>
    </section>
  );
}
