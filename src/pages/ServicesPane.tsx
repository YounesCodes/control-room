import { Search } from "../components/MagnifierIcon";
import { ResizableSplit } from "../components/ResizablePanels";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, List, RefreshCw, RotateCcw, X } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import { SystemdUnitInspector } from "../components/SystemdUnitInspector";
import { SystemdInventory } from "../components/SystemdInventory";
import { SystemdGraph } from "../components/SystemdGraph";
import { api, errorMessage } from "../lib/api";
import { connectionTargetKey } from "../lib/connection-validation";
import {
  countSystemdUnits,
  filterSystemdUnits,
  isSystemdUnitName,
  SYSTEMD_RELATIONSHIPS,
  systemdEdges,
  systemdNeighborhood,
} from "../lib/systemd-units";
import { invalidateSystemdReads, useSystemdReads } from "../lib/systemd-inspection";
import { isCacheFresh, reconcileSelection } from "../lib/workspace-cache";
import type {
  CachedList,
  LogSourceSelection,
  SavedConnection,
  SystemdExplorerState,
  SystemdUnit,
} from "../types";

const DEFAULT: SystemdExplorerState = {
  mode: "inventory",
  rootId: null,
  expanded: [],
  search: "",
  state: "all",
  unitType: "all",
  sort: "priority",
  relationships: [...SYSTEMD_RELATIONSHIPS],
};

export function ServicesPane({
  connection,
  cache,
  onCacheChange,
  onViewLogs,
  focusId = null,
  initialState,
  onStateChange,
  onSelectionChange,
  onOpenPorts,
  onOpenBoot,
}: {
  connection: SavedConnection;
  cache: CachedList<SystemdUnit>;
  onCacheChange: (cache: CachedList<SystemdUnit>) => void;
  onViewLogs: (source: LogSourceSelection) => void;
  focusId?: string | null;
  initialState?: SystemdExplorerState;
  onStateChange?: (state: SystemdExplorerState) => void;
  onSelectionChange?: (id: string | null) => void;
  onOpenPorts?: (unit: string) => void;
  onOpenBoot?: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    () =>
      focusId ??
      reconcileSelection(
        filterSystemdUnits(cache.items, { search: "", state: "all", unitType: "all" }),
        null,
      ),
  );
  const [state, setState] = useState<SystemdExplorerState>(initialState ?? DEFAULT);
  const graphSearch = state.dependencySearch ?? "";
  function setGraphSearch(dependencySearch: string) {
    setState((current) => ({ ...current, dependencySearch }));
  }
  const deferredSearch = useDeferredValue(state.search);
  const [revision, setRevision] = useState(0);
  const cacheRef = useRef(cache);
  const requestRef = useRef(0);
  const selectionCallback = useRef(onSelectionChange);
  const stateCallback = useRef(onStateChange);
  cacheRef.current = cache;
  selectionCallback.current = onSelectionChange;
  stateCallback.current = onStateChange;
  useEffect(() => {
    stateCallback.current?.(state);
  }, [state]);
  useEffect(() => {
    selectionCallback.current?.(selectedId);
  }, [selectedId]);

  async function load(force = false) {
    const current = cacheRef.current;
    if (!force && isCacheFresh(current)) return;
    const request = ++requestRef.current;
    onCacheChange({ ...current, loading: true, error: null });
    try {
      const items = await api.listServices(connection.id);
      if (request !== requestRef.current) return;
      onCacheChange({ items, fetchedAt: Date.now(), loading: false, error: null });
      // Dependencies outside the inventory and disappeared units retain their
      // identity. Their own detail reads report their current availability.
      setSelectedId((selected) => selected ?? reconcileSelection(items, null));
    } catch (caught) {
      if (request !== requestRef.current) return;
      onCacheChange({ ...cacheRef.current, loading: false, error: errorMessage(caught) });
    }
  }

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [connection.id]);
  useEffect(() => {
    if (focusId && isSystemdUnitName(focusId)) setSelectedId(focusId);
  }, [focusId]);

  const rootId = state.rootId ?? selectedId;
  const readIds = useMemo(
    () => [
      ...new Set(
        [selectedId, ...(state.mode === "graph" ? [rootId, ...state.expanded] : [])].filter(
          (id): id is string => !!id && isSystemdUnitName(id),
        ),
      ),
    ],
    [selectedId, rootId, state.mode, state.expanded],
  );
  const cacheScope = connectionTargetKey(connection);
  const details = useSystemdReads(connection.id, readIds, revision, "properties", cacheScope);
  const edges = useMemo(
    () =>
      systemdEdges(
        Object.values(details).flatMap((result) => (result.value ? [result.value] : [])),
      ),
    [details],
  );
  const neighborhood = useMemo(
    () =>
      rootId
        ? systemdNeighborhood(rootId, state.expanded, edges, state.relationships, graphSearch)
        : null,
    [rootId, state.expanded, edges, state.relationships, graphSearch],
  );
  const counts = useMemo(() => countSystemdUnits(cache.items), [cache.items]);
  const filtered = useMemo(
    () => filterSystemdUnits(cache.items, { ...state, search: deferredSearch }),
    [cache.items, state, deferredSearch],
  );
  const selected = cache.items.find((unit) => unit.id === selectedId) ?? null;
  const graphUnits = useMemo(() => {
    const units = new Map(cache.items.map((unit) => [unit.id, unit]));
    for (const result of Object.values(details)) {
      if (!result.value?.properties.ActiveState) continue;
      const { id, properties: p } = result.value;
      units.set(id, {
        id,
        unitType: id.split(".").at(-1) ?? "",
        description: p.Description ?? "",
        activeState: p.ActiveState,
        subState: p.SubState ?? "Unavailable",
        loadState: p.LoadState ?? "Unavailable",
        unitFileState: p.UnitFileState || null,
      });
    }
    return [...units.values()];
  }, [cache.items, details]);
  const selectedVisible = filtered.some((unit) => unit.id === selectedId);
  const failedGraphRead = readIds.find((id) => id !== selectedId && details[id]?.error);
  const filtersActive = !!state.search || state.state !== "all" || state.unitType !== "all";
  const types = [
    ...new Set([
      ...cache.items.map((unit) => unit.unitType),
      "service",
      "timer",
      "socket",
      "mount",
    ]),
  ].sort();
  const states = [
    ...new Set(["failed", "active", "inactive", ...cache.items.map((unit) => unit.activeState)]),
  ];

  function patch(next: Partial<SystemdExplorerState>) {
    setState((current) => ({ ...current, ...next }));
  }
  function clearFilters() {
    patch({ search: "", state: "all", unitType: "all" });
  }
  function selectInventoryUnit(id: string) {
    setSelectedId(id);
    if (id !== selectedId) patch({ rootId: id, expanded: [], dependencySearch: "" });
  }
  function refreshDetails() {
    invalidateSystemdReads(connection.id);
    setRevision((n) => n + 1);
  }
  function refocus(id: string) {
    setSelectedId(id);
    setGraphSearch("");
    patch({ mode: "graph", rootId: id, expanded: [] });
  }

  const inspector = selectedId && (
    <SystemdUnitInspector
      key={selectedId}
      connectionId={connection.id}
      cacheScope={cacheScope}
      unitId={selectedId}
      summary={selected}
      result={details[selectedId]}
      revision={revision}
      onRefresh={refreshDetails}
      onNavigate={refocus}
      onViewLogs={onViewLogs}
      onOpenPorts={onOpenPorts}
      onOpenBoot={onOpenBoot}
    />
  );

  if (cache.loading && !cache.items.length) return <LoadingState label="Reading systemd units…" />;
  if (cache.error && !cache.items.length)
    return (
      <ErrorState
        message={cache.error}
        action={<button onClick={() => load(true)}>Retry</button>}
      />
    );

  return (
    <section className="feature-page systemd-page">
      <header className="systemd-heading">
        <h2
          tabIndex={0}
          title={
            "Current system scope only, not a complete host health check" +
            (cache.fetchedAt ? "\nCollected " + new Date(cache.fetchedAt).toLocaleTimeString() : "")
          }
        >
          Systemd
        </h2>
        <div className="systemd-summary" role="group" aria-label="Unit summaries">
          {(["failed", "active", "inactive"] as const).map((status) => (
            <button
              type="button"
              key={status}
              className={status === "failed" && counts.failed ? "failed-count" : ""}
              aria-pressed={state.state === status}
              onClick={() =>
                patch({ mode: "inventory", state: state.state === status ? "all" : status })
              }
            >
              {counts[status]} {status}
            </button>
          ))}
          {!!counts.other && <span>{counts.other} transitioning / other</span>}
        </div>
        <div className="systemd-view-switch" role="group" aria-label="Systemd view">
          <button
            type="button"
            className="icon-button"
            aria-label="Unit inventory"
            title="Unit inventory"
            aria-pressed={state.mode === "inventory"}
            onClick={() => patch({ mode: "inventory" })}
          >
            <List size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Dependency graph"
            title="Dependency graph"
            aria-pressed={state.mode === "graph"}
            disabled={!rootId}
            onClick={() => patch({ mode: "graph", rootId })}
          >
            <GitBranch size={16} />
          </button>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={() => {
            refreshDetails();
            void load(true);
          }}
          aria-label="Refresh systemd units"
          disabled={cache.loading}
        >
          <RefreshCw size={16} className={cache.loading ? "spinning" : ""} />
        </button>
      </header>
      {cache.error && (
        <p className="inline-warning" role="status">
          Showing saved results. Refresh failed: {cache.error}
        </p>
      )}
      {state.mode === "inventory" ? (
        <ResizableSplit name="Services" className="split-page services-page systemd-inventory">
          <div className="list-panel">
            <div className="systemd-list-controls">
              <label className="search-field">
                <Search size={15} />
                <input
                  aria-label="Search units"
                  value={state.search}
                  onChange={(event) => patch({ search: event.target.value })}
                  placeholder="Search units"
                />
              </label>
              <select
                aria-label="Unit state"
                value={state.state}
                onChange={(event) => patch({ state: event.target.value })}
              >
                <option value="all">All states</option>
                {states.map((value) => (
                  <option key={value} value={value}>
                    {value[0].toUpperCase() + value.slice(1)}
                  </option>
                ))}
              </select>
              <select
                aria-label="Unit type"
                value={state.unitType}
                onChange={(event) => patch({ unitType: event.target.value })}
              >
                <option value="all">All types</option>
                {types.map((type) => (
                  <option key={type} value={type}>
                    {type[0].toUpperCase() + type.slice(1) + "s"}
                  </option>
                ))}
              </select>
            </div>
            <div className="systemd-inventory-toolbar">
              <span>
                {filtered.length} / {cache.items.length} units
              </span>
              <select
                aria-label="Sort units"
                value={state.sort}
                onChange={(event) =>
                  patch({ sort: event.target.value as SystemdExplorerState["sort"] })
                }
              >
                <option value="priority">Failed first</option>
                <option value="name">Name</option>
                <option value="state">State</option>
                <option value="type">Type</option>
              </select>
              {filtersActive && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Clear filters"
                  onClick={clearFilters}
                >
                  <RotateCcw size={14} />
                </button>
              )}
            </div>
            <SystemdInventory
              units={filtered}
              selectedId={selectedId}
              onSelect={selectInventoryUnit}
              onExplore={refocus}
              emptyTitle={cache.items.length ? "No matching units" : "No units found"}
            />
          </div>
          <aside className="detail-panel systemd-inventory-detail" aria-label="Unit details">
            {selectedId && selected && !selectedVisible ? (
              <EmptyState
                title={
                  filtered.length ? "Selected unit is outside this filter" : "No matching units"
                }
              >
                <button className="secondary-button" type="button" onClick={clearFilters}>
                  Show selected unit
                </button>
              </EmptyState>
            ) : selectedId ? (
              <>
                {inspector}
                <button
                  type="button"
                  className="icon-button systemd-focus-action"
                  aria-label="Explore dependencies"
                  title="Explore dependencies"
                  onClick={() => refocus(selectedId)}
                >
                  <GitBranch size={16} />
                </button>
              </>
            ) : (
              <EmptyState title={cache.items.length ? "Select a unit" : "No units found"} />
            )}
          </aside>
        </ResizableSplit>
      ) : (
        <>
          <div className="systemd-graph-tools">
            <button
              type="button"
              className="systemd-root-label"
              title="Refocus on current unit"
              onClick={() => rootId && refocus(rootId)}
            >
              <GitBranch size={14} />
              {rootId}
            </button>
            <label className="search-field">
              <Search size={14} />
              <input
                aria-label="Search dependencies"
                placeholder="Search dependencies"
                value={graphSearch}
                onChange={(event) => setGraphSearch(event.target.value)}
              />
            </label>
            {graphSearch && (
              <button
                className="icon-button"
                type="button"
                aria-label="Clear dependency search"
                onClick={() => setGraphSearch("")}
              >
                <X size={14} />
              </button>
            )}
            {selectedId && selectedId !== rootId && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => refocus(selectedId)}
              >
                Focus selected unit
              </button>
            )}
          </div>
          <div
            className="systemd-relationship-filters"
            role="group"
            aria-label="Relationship filters"
          >
            {SYSTEMD_RELATIONSHIPS.map((relationship) => (
              <button
                className={"systemd-relation relationship-" + relationship.toLowerCase()}
                key={relationship}
                type="button"
                aria-pressed={state.relationships.includes(relationship)}
                title={
                  relationship === "After" || relationship === "Before"
                    ? "Ordering constraint only"
                    : relationship === "Triggers"
                      ? "Activation evidence"
                      : "Requirement relationship, including reverse dependencies"
                }
                onClick={() =>
                  patch({
                    relationships: state.relationships.includes(relationship)
                      ? state.relationships.filter((value) => value !== relationship)
                      : [...state.relationships, relationship],
                  })
                }
              >
                {relationship}
              </button>
            ))}
            {!!neighborhood?.hidden && (
              <span role="status">{neighborhood.hidden} more. Narrow search or refocus.</span>
            )}
            {state.expanded.length >= 24 && (
              <span role="status">Expansion limit reached. Refocus to explore further.</span>
            )}
          </div>
          <div className="systemd-graph-stage">
            {failedGraphRead && (
              <div className="systemd-graph-notice" role="status">
                {details[failedGraphRead]?.value
                  ? "Saved dependency evidence. "
                  : "Dependencies unavailable. "}
                {failedGraphRead}: {details[failedGraphRead]?.error}{" "}
                <button className="link-button" type="button" onClick={refreshDetails}>
                  Retry
                </button>
              </div>
            )}
            {!failedGraphRead &&
              selectedId &&
              neighborhood &&
              !neighborhood.ids.includes(selectedId) && (
                <div className="systemd-graph-notice" role="status">
                  Selected unit is outside this graph filter.{" "}
                  <button className="link-button" type="button" onClick={() => refocus(selectedId)}>
                    Show selected unit
                  </button>
                </div>
              )}
            {!failedGraphRead &&
              (!selectedId || neighborhood?.ids.includes(selectedId)) &&
              graphSearch &&
              neighborhood?.ids.length === 1 &&
              !rootId?.toLowerCase().includes(graphSearch.toLowerCase()) && (
                <div className="systemd-graph-notice" role="status">
                  No matching dependencies
                </div>
              )}
            {rootId && neighborhood ? (
              <SystemdGraph
                ids={neighborhood.ids}
                edges={neighborhood.edges}
                units={graphUnits}
                rootId={rootId}
                selectedId={selectedId}
                expanded={state.expanded}
                onSelect={setSelectedId}
                onRefocus={refocus}
                onExpand={(id) =>
                  patch({
                    expanded: state.expanded.includes(id)
                      ? state.expanded.filter((value) => value !== id)
                      : [...state.expanded, id].slice(0, 24),
                  })
                }
                inspector={inspector}
              />
            ) : (
              <EmptyState title="Select a unit to explore" />
            )}
            {readIds.some((id) => details[id]?.loading) && (
              <span className="systemd-graph-status" role="status">
                Reading dependencies…
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
