import { useEffect, useMemo, useRef, useState } from "react";
import { FileClock, Network, RefreshCw, Search } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import { SystemdRelationshipsPanel } from "../components/systemd/SystemdRelationshipsPanel";
import { api, errorMessage } from "../lib/api";
import { countSystemdUnits, filterSystemdUnits } from "../lib/systemd-units";
import type { SystemdStateFilter } from "../lib/systemd-units";
import { isCacheFresh, reconcileSelection } from "../lib/workspace-cache";
import type {
  CachedList,
  LogSourceSelection,
  SavedConnection,
  SystemdRelationships,
  SystemdUnit,
} from "../types";

export function ServicesPane({
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
  const [stateFilter, setStateFilter] = useState<SystemdStateFilter>("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [relationships, setRelationships] = useState<SystemdRelationships | null>(null);
  const [relationshipsLoading, setRelationshipsLoading] = useState(false);
  const [relationshipsError, setRelationshipsError] = useState<string | null>(null);
  const cacheRef = useRef(cache);
  const requestRef = useRef(0);
  const relationshipRequestRef = useRef(0);
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

  async function loadRelationships(unit: string) {
    const request = ++relationshipRequestRef.current;
    setRelationshipsLoading(true);
    setRelationshipsError(null);
    try {
      const result = await api.inspectSystemdRelationships(connection.id, unit);
      if (request !== relationshipRequestRef.current) return;
      setRelationships(result);
      if (result.root !== unit) setSelectedId(result.root);
    } catch (caught) {
      if (request !== relationshipRequestRef.current) return;
      setRelationshipsError(errorMessage(caught));
    } finally {
      if (request === relationshipRequestRef.current) setRelationshipsLoading(false);
    }
  }

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
      relationshipRequestRef.current += 1;
    };
  }, [connection.id]);

  useEffect(() => {
    if (!cache.items.length) return;
    setSelectedId((selected) => reconcileSelection(cache.items, selected));
  }, [cache.items]);

  useEffect(() => {
    if (focusId) setSelectedId(focusId);
  }, [focusId]);

  useEffect(() => {
    setRelationshipsError(null);
  }, [selectedId]);

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
  const selected = useMemo(() => {
    const listed = cache.items.find((unit) => unit.id === selectedId);
    if (listed) return listed;
    const related = relationships?.nodes.find((unit) => unit.id === selectedId);
    return related ? { ...related, unitFileState: null } : null;
  }, [cache.items, relationships, selectedId]);

  function inspectRelated(unit: string) {
    setSelectedId(unit);
    void loadRelationships(unit);
  }

  if (cache.loading && !cache.items.length) return <LoadingState label="Reading systemd units…" />;
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
            <h2>Systemd</h2>
            <p>
              {counts.active} active ·{" "}
              <span className={counts.failed ? "failed-count" : ""}>{counts.failed} failed</span>
            </p>
            <small className="unit-scope-note">
              Current system scope only, not a complete host health check
            </small>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={() => load(true)}
            aria-label="Refresh systemd units"
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
              placeholder="Search units"
            />
          </label>
          <select
            aria-label="Unit state"
            value={stateFilter}
            onChange={(event) => setStateFilter(event.target.value as SystemdStateFilter)}
          >
            <option value="all">All states</option>
            <option value="failed">Failed</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <select
            aria-label="Unit type"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
          >
            <option value="all">All types</option>
            <option value="service">Services</option>
            <option value="timer">Timers</option>
            <option value="mount">Mounts</option>
            <option value="socket">Sockets</option>
          </select>
        </div>
        <div className="dense-list">
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
            <EmptyState title={cache.items.length ? "No matching units" : "No units found"} />
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
                <dt>Unit type</dt>
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
              <div>
                <dt>Unit-file state</dt>
                <dd>{selected.unitFileState ?? "Unknown"}</dd>
              </div>
            </dl>
            <div className="detail-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => onViewLogs({ type: "systemd", id: selected.id })}
              >
                <FileClock size={15} /> View journal
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => loadRelationships(selected.id)}
                disabled={relationshipsLoading}
              >
                <Network size={15} />
                {relationshipsLoading && relationships?.root !== selected.id
                  ? "Reading relationships…"
                  : "Relationships"}
              </button>
            </div>
            {relationshipsError && (
              <div className="relationship-error" role="alert">
                <p>{relationshipsError}</p>
                <button type="button" onClick={() => loadRelationships(selected.id)}>
                  Retry
                </button>
              </div>
            )}
            {relationshipsLoading && relationships?.root !== selected.id && (
              <p className="relationship-loading">Reading a bounded relationship neighborhood…</p>
            )}
            {relationships?.root === selected.id && (
              <SystemdRelationshipsPanel result={relationships} onInspect={inspectRelated} />
            )}
          </>
        ) : (
          <EmptyState title="Select a unit" />
        )}
      </aside>
    </section>
  );
}
