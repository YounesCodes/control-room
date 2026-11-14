import { ResizableSplit } from "../components/ResizablePanels";
import { useEffect, useMemo, useRef, useState } from "react";
import { FileClock, RefreshCw, Search } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import { countSystemdUnits, filterSystemdUnits } from "../lib/systemd-units";
import { isCacheFresh, reconcileSelection } from "../lib/workspace-cache";
import type { CachedList, LogSourceSelection, SavedConnection, SystemdUnit } from "../types";

/// Mac hosts list launchd jobs. launchd reports no dependency graph, so the
/// Linux systemd explorer does not apply; this is a flat list with details.
export function LaunchdServicesPane({
  connection,
  cache,
  onCacheChange,
  onViewLogs,
  focusId = null,
}: {
  connection: SavedConnection;
  cache: CachedList<SystemdUnit>;
  onCacheChange: (cache: CachedList<SystemdUnit>) => void;
  onViewLogs: (source: LogSourceSelection) => void;
  focusId?: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    () => focusId ?? reconcileSelection(cache.items, null),
  );
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
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
    if (!cache.items.length) return;
    setSelectedId((selected) => reconcileSelection(cache.items, selected));
  }, [cache.items]);

  useEffect(() => {
    if (focusId) setSelectedId(focusId);
  }, [focusId]);

  const counts = useMemo(() => countSystemdUnits(cache.items), [cache.items]);
  const filtered = useMemo(
    () =>
      filterSystemdUnits(cache.items, {
        search,
        state: stateFilter,
        unitType: typeFilter,
      }),
    [cache.items, search, stateFilter, typeFilter],
  );
  const selected = cache.items.find((unit) => unit.id === selectedId) ?? null;
  const selectedVisible = filtered.some((unit) => unit.id === selectedId);
  const filtersActive = search.length > 0 || stateFilter !== "all" || typeFilter !== "all";

  function clearFilters() {
    setSearch("");
    setStateFilter("all");
    setTypeFilter("all");
  }

  if (cache.loading && !cache.items.length)
    return <LoadingState label="Reading launchd services…" />;
  if (cache.error && !cache.items.length) {
    return (
      <ErrorState
        message={cache.error}
        action={<button onClick={() => load(true)}>Retry</button>}
      />
    );
  }

  return (
    <ResizableSplit name="Services" className="feature-page split-page services-page">
      <div className="list-panel">
        <header className="page-heading compact-heading">
          <div>
            <h2>Services</h2>
            <p>
              {counts.active} active ·{" "}
              <span className={counts.failed ? "failed-count" : ""}>{counts.failed} failed</span>
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={() => load(true)}
            aria-label="Refresh launchd services"
            disabled={cache.loading}
          >
            <RefreshCw size={16} className={cache.loading ? "spinning" : ""} />
          </button>
        </header>
        {cache.error && (
          <p className="inline-warning">Showing saved results. Refresh failed: {cache.error}</p>
        )}
        <div className="systemd-list-controls">
          <label className="search-field">
            <Search size={15} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search services"
            />
          </label>
          <select
            aria-label="Service state"
            value={stateFilter}
            onChange={(event) => setStateFilter(event.target.value)}
          >
            <option value="all">All states</option>
            <option value="failed">Failed</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <select
            aria-label="Service type"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
          >
            <option value="all">All types</option>
            <option value="daemon">Daemons</option>
            <option value="agent">Agents</option>
          </select>
        </div>
        <div className="dense-list" role="region" aria-label="Launchd services" tabIndex={0}>
          {filtered.map((unit) => (
            <button
              className={unit.id === selectedId ? "dense-row selected-row" : "dense-row"}
              type="button"
              key={unit.id}
              onClick={() => setSelectedId(unit.id)}
            >
              <span className={`service-indicator service-${unit.activeState}`} />
              <span className="row-main">
                <strong>{unit.id}</strong>
                <small>{unit.description || "No description"}</small>
              </span>
              <span className="row-state unit-row-state">
                <span className="unit-type-label">{unit.unitType}</span>
                <span>{unit.subState}</span>
              </span>
            </button>
          ))}
          {!filtered.length && (
            <EmptyState title={cache.items.length ? "No matching services" : "No services found"} />
          )}
        </div>
      </div>
      <aside className="detail-panel">
        {!cache.items.length ? (
          <EmptyState title="No services found" />
        ) : !filtered.length ? (
          <EmptyState title="No matching services">
            <button className="secondary-button" type="button" onClick={clearFilters}>
              Clear filters
            </button>
          </EmptyState>
        ) : selected && !selectedVisible ? (
          <EmptyState title="Selected service is outside this filter">
            <button className="secondary-button" type="button" onClick={clearFilters}>
              Show selected service
            </button>
          </EmptyState>
        ) : selected ? (
          <>
            <header>
              <h2>{selected.id}</h2>
              <p>{selected.description || "No description"}</p>
            </header>
            <dl className="detail-list">
              <div>
                <dt>Service type</dt>
                <dd>{selected.unitType}</dd>
              </div>
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
            </dl>
            <button
              className="secondary-button"
              type="button"
              onClick={() => onViewLogs({ type: "systemd", id: selected.id })}
            >
              <FileClock size={15} /> View logs
            </button>
          </>
        ) : filtersActive ? (
          <EmptyState title="Select a matching service" />
        ) : (
          <EmptyState title="Select a service" />
        )}
      </aside>
    </ResizableSplit>
  );
}
