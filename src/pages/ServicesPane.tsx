import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, X } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import { SystemdUnitInspector } from "../components/SystemdUnitInspector";
import { SystemdInventory } from "../components/SystemdInventory";
import { SystemdGraph } from "../components/SystemdGraph";
import { SystemdPresence } from "../components/SystemdPresence";
import { SystemdToolbar } from "../components/SystemdToolbar";
import { api, errorMessage } from "../lib/api";
import { connectionTargetKey } from "../lib/connection-validation";
import {
  countSystemdUnits,
  filterSystemdUnits,
  isSystemdUnitName,
  SYSTEMD_RELATIONSHIP_GROUPS,
  SYSTEMD_INITIAL_VISIBLE,
  SYSTEMD_MAX_VISIBLE,
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
  relationshipGroup: "dependencies",
  visibleLimit: SYSTEMD_INITIAL_VISIBLE,
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
  const [state, setState] = useState<SystemdExplorerState>(() => ({ ...DEFAULT, ...initialState }));
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const inspectorRef = useRef<HTMLElement>(null);
  const inventoryRef = useRef<HTMLDivElement>(null);
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
        [
          inspectorOpen ? selectedId : null,
          ...(state.mode === "graph" ? [rootId, ...state.expanded] : []),
        ].filter((id): id is string => !!id && isSystemdUnitName(id)),
      ),
    ],
    [selectedId, inspectorOpen, rootId, state.mode, state.expanded],
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
        ? systemdNeighborhood(
            rootId,
            state.expanded,
            edges,
            [...SYSTEMD_RELATIONSHIP_GROUPS[state.relationshipGroup]],
            graphSearch,
            state.visibleLimit ?? SYSTEMD_INITIAL_VISIBLE,
          )
        : null,
    [rootId, state.expanded, edges, state.relationshipGroup, state.visibleLimit, graphSearch],
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
  const failedGraphRead = readIds.find(
    (id) => (!inspectorOpen || id !== selectedId) && details[id]?.error,
  );
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
    if (next.relationshipGroup || (state.mode === "graph" && next.dependencySearch !== undefined))
      setInspectorOpen(false);
    setState((current) => ({ ...current, ...next }));
  }
  function clearFilters() {
    patch({ search: "", state: "all", unitType: "all" });
  }
  function selectInventoryUnit(id: string) {
    setInspectorOpen(id !== selectedId || !inspectorOpen);
    setSelectedId(id);
    if (id !== selectedId)
      patch({
        rootId: id,
        expanded: [],
        dependencySearch: "",
        visibleLimit: SYSTEMD_INITIAL_VISIBLE,
      });
  }
  function refreshDetails() {
    invalidateSystemdReads(connection.id);
    setRevision((n) => n + 1);
  }
  function refocus(id: string) {
    setSelectedId(id);
    setInspectorOpen(false);
    setGraphSearch("");
    patch({ mode: "graph", rootId: id, expanded: [], visibleLimit: SYSTEMD_INITIAL_VISIBLE });
  }

  const visibleInspector =
    inspectorOpen && !!selectedId && (state.mode === "graph" || !selected || selectedVisible);
  useEffect(() => {
    if (visibleInspector && state.mode === "inventory")
      inspectorRef.current?.focus({ preventScroll: true });
  }, [selectedId, visibleInspector, state.mode]);

  function closeInventoryInspector() {
    setInspectorOpen(false);
    const row = [
      ...(inventoryRef.current?.querySelectorAll<HTMLButtonElement>(".dense-row") ?? []),
    ].find((element) => element.getAttribute("aria-pressed") === "true");
    requestAnimationFrame(() =>
      (row ?? inventoryRef.current?.querySelector<HTMLElement>(".dense-list"))?.focus({
        preventScroll: true,
      }),
    );
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

  const snapshot = [
    cache.items.length + " units",
    counts.active + " active",
    counts.failed + " failed",
    counts.inactive + " inactive",
    "Current system scope only, not a complete host health check",
    cache.fetchedAt ? "Collected " + new Date(cache.fetchedAt).toLocaleTimeString() : "",
  ].join(" · ");
  return (
    <section className="feature-page systemd-page">
      <SystemdToolbar
        state={state}
        total={cache.items.length}
        failed={counts.failed}
        snapshot={snapshot}
        loading={cache.loading}
        canGraph={!!rootId}
        types={types}
        states={states}
        onChange={patch}
        onMode={(mode) => {
          setInspectorOpen(false);
          patch({ mode, rootId });
        }}
        onRefresh={() => {
          refreshDetails();
          void load(true);
        }}
      />
      {cache.error && (
        <p className="inline-warning" role="status">
          Showing saved results. Refresh failed: {cache.error}
        </p>
      )}
      {state.mode === "inventory" ? (
        <div
          className={"systemd-explorer-stage" + (visibleInspector ? " inspecting" : "")}
          ref={inventoryRef}
        >
          <div className="systemd-inventory services-page">
            {filtersActive && (
              <div className="systemd-filter-result">
                <span>{filtered.length} matching units</span>
                <button type="button" className="link-button" onClick={clearFilters}>
                  Clear filters
                </button>
              </div>
            )}
            {selectedId && selected && !selectedVisible && (
              <div className="systemd-filter-result" role="status">
                Selected unit is outside this filter{" "}
                <button type="button" className="link-button" onClick={clearFilters}>
                  Show selected unit
                </button>
              </div>
            )}
            <SystemdInventory
              units={filtered}
              selectedId={selectedId}
              onSelect={selectInventoryUnit}
              onExplore={refocus}
              emptyTitle={cache.items.length ? "No matching units" : "No units found"}
            />
          </div>
          <SystemdPresence open={visibleInspector}>
            <aside
              ref={inspectorRef}
              className="detail-panel arch-detail systemd-inspector"
              aria-label="Unit details"
              tabIndex={-1}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  closeInventoryInspector();
                }
              }}
            >
              <button
                type="button"
                className="icon-button inspector-close"
                aria-label="Close details"
                onClick={closeInventoryInspector}
              >
                <X size={16} />
              </button>
              {inspector}
            </aside>
          </SystemdPresence>
        </div>
      ) : (
        <div className="systemd-graph-stage">
          <div className="systemd-graph-context">
            <button
              type="button"
              className="systemd-root-label"
              title="Refocus on current unit"
              onClick={() => rootId && refocus(rootId)}
            >
              <GitBranch size={14} />
              {rootId}
            </button>
            {!!neighborhood?.hidden && (
              <button
                className="systemd-more"
                type="button"
                disabled={(state.visibleLimit ?? SYSTEMD_INITIAL_VISIBLE) >= SYSTEMD_MAX_VISIBLE}
                title={
                  (state.visibleLimit ?? SYSTEMD_INITIAL_VISIBLE) >= SYSTEMD_MAX_VISIBLE
                    ? "Search or refocus to explore other units"
                    : "Reveal more related units"
                }
                onClick={() =>
                  patch({
                    visibleLimit: Math.min(
                      SYSTEMD_MAX_VISIBLE,
                      (state.visibleLimit ?? SYSTEMD_INITIAL_VISIBLE) + 6,
                    ),
                  })
                }
              >
                Show more · {neighborhood.hidden}
              </button>
            )}
          </div>
          {rootId && neighborhood ? (
            <SystemdGraph
              ids={neighborhood.ids}
              edges={neighborhood.edges}
              units={graphUnits}
              rootId={rootId}
              selectedId={visibleInspector ? selectedId : null}
              expanded={state.expanded}
              frameKey={state.relationshipGroup + ":" + graphSearch}
              onSelect={(id) => {
                if (id) setSelectedId(id);
                setInspectorOpen(!!id);
              }}
              onRefocus={refocus}
              onExpand={(id) =>
                patch({
                  expanded: state.expanded.includes(id)
                    ? state.expanded.filter((unit) => unit !== id)
                    : [...state.expanded, id].slice(0, 24),
                  visibleLimit: Math.min(
                    SYSTEMD_MAX_VISIBLE,
                    (state.visibleLimit ?? SYSTEMD_INITIAL_VISIBLE) + 3,
                  ),
                })
              }
              inspector={inspector}
            />
          ) : (
            <EmptyState title="Select a unit to explore" />
          )}
          {failedGraphRead ? (
            <div className="systemd-graph-notice" role="status">
              {details[failedGraphRead]?.value
                ? "Saved dependency evidence. "
                : "Dependencies unavailable. "}
              {failedGraphRead}: {details[failedGraphRead]?.error}{" "}
              <button className="link-button" type="button" onClick={refreshDetails}>
                Retry
              </button>
            </div>
          ) : readIds.some((id) => details[id]?.loading) ? (
            <span className="systemd-graph-status" role="status">
              Reading dependencies…
            </span>
          ) : (
            rootId &&
            details[rootId]?.value &&
            neighborhood?.ids.length === 1 && (
              <span className="systemd-graph-status" role="status">
                {graphSearch
                  ? "No matching relationships"
                  : "No reported relationships in this category"}
              </span>
            )
          )}
        </div>
      )}
    </section>
  );
}
