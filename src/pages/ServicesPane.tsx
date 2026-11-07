import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, X } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import {
  SystemdUnitInspector,
  type SystemdInspectorViewState,
} from "../components/SystemdUnitInspector";
import { SystemdInventory } from "../components/SystemdInventory";
import { SystemdGraph } from "../components/SystemdGraph";
import { SystemdPresence } from "../components/SystemdPresence";
import { SystemdToolbar } from "../components/SystemdToolbar";
import { api, errorMessage } from "../lib/api";
import { connectionTargetKey } from "../lib/connection-validation";
import { hasUnitBootEvidence, isCurrentBootSnapshotFresh } from "../lib/boot-diagnostics";
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
import { isCacheFresh } from "../lib/workspace-cache";
import type {
  CachedList,
  BootDiagnostics,
  LogSourceSelection,
  ListeningSocket,
  SavedConnection,
  SystemdExplorerState,
  SystemdUnit,
} from "../types";
import { WarningSign } from "../components/WarningSign";

const DEFAULT: SystemdExplorerState = {
  mode: "inventory",
  rootId: null,
  expanded: [],
  search: "",
  state: "all",
  unitType: "all",
  sort: "priority",
  scope: "focused",
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
  portsCache,
  onPortsCacheChange,
  onOpenBoot,
  bootSnapshot,
  onBootSnapshotChange,
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
  portsCache?: CachedList<ListeningSocket>;
  onPortsCacheChange?: (cache: CachedList<ListeningSocket>) => void;
  onOpenBoot?: () => void;
  bootSnapshot?: BootDiagnostics | null;
  onBootSnapshotChange?: (snapshot: BootDiagnostics) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    focusId && isSystemdUnitName(focusId) ? focusId : null,
  );
  const [state, setState] = useState<SystemdExplorerState>(() => {
    const restored = { ...DEFAULT, ...initialState };
    if (
      selectedId &&
      !filterSystemdUnits(cache.items, restored).some((unit) => unit.id === selectedId)
    )
      return { ...restored, search: "", state: "all", unitType: "all", scope: "all" };
    return restored;
  });
  const [inspectors, setInspectors] = useState({
    inventory: !!selectedId && state.mode === "inventory",
    graph: !!selectedId && state.mode === "graph",
  });
  const inspectorViews = useRef(new Map<string, SystemdInspectorViewState>());
  const inspectorOpen = inspectors[state.mode];
  function setInspectorOpen(open: boolean) {
    setInspectors((current) => ({ ...current, [state.mode]: open }));
  }
  const inspectorRef = useRef<HTMLElement>(null);
  const inventoryRef = useRef<HTMLDivElement>(null);
  const selectionFocus = useRef<"inventory" | "inspector">("inspector");
  const graphContextRef = useRef<HTMLDivElement>(null);
  const graphSearch = state.dependencySearch ?? "";
  function setGraphSearch(dependencySearch: string) {
    setState((current) => ({ ...current, dependencySearch }));
  }
  const deferredSearch = useDeferredValue(state.search);
  const [revision, setRevision] = useState(0);
  const cacheRef = useRef(cache);
  const requestRef = useRef(0);
  const portsRequestRef = useRef(0);
  const portsLoadingRef = useRef(false);
  const portsCacheRef = useRef(portsCache);
  const bootSnapshotRef = useRef(bootSnapshot);
  const bootRequestRef = useRef(0);
  const bootLoadingRef = useRef(false);
  const [bootRead, setBootRead] = useState({
    target: connectionTargetKey(connection),
    status: "idle" as "idle" | "loading" | "error",
  });
  const targetRef = useRef(connectionTargetKey(connection));
  portsCacheRef.current = portsCache;
  bootSnapshotRef.current = bootSnapshot;
  if (targetRef.current !== connectionTargetKey(connection)) {
    portsRequestRef.current += 1;
    portsLoadingRef.current = false;
    bootRequestRef.current += 1;
    bootLoadingRef.current = false;
    targetRef.current = connectionTargetKey(connection);
  }
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
    } catch (caught) {
      if (request !== requestRef.current) return;
      onCacheChange({ ...cacheRef.current, loading: false, error: errorMessage(caught) });
    }
  }

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
      portsRequestRef.current += 1;
      bootRequestRef.current += 1;
    };
  }, [connection.id]);
  useEffect(() => {
    if (focusId && isSystemdUnitName(focusId) && focusId !== selectedId) {
      setSelectedId(focusId);
      setInspectorOpen(true);
      if (!filterSystemdUnits(cache.items, state).some((unit) => unit.id === focusId))
        setState((current) => ({
          ...current,
          search: "",
          state: "all",
          unitType: "all",
          scope: "all",
        }));
    }
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
  const filtered = useMemo(
    () => filterSystemdUnits(cache.items, { ...state, search: deferredSearch }),
    [cache.items, state, deferredSearch],
  );
  const selectedVisible = filtered.some((unit) => unit.id === selectedId);
  const selected = cache.items.find((unit) => unit.id === selectedId) ?? null;
  const visibleInspector =
    inspectorOpen && !!selectedId && (state.mode === "graph" || !selected || selectedVisible);
  const details = useSystemdReads(
    connection.id,
    readIds,
    revision,
    "properties",
    cacheScope,
    visibleInspector && selectedId?.endsWith(".service") ? selectedId : null,
  );
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
    setState((current) => ({
      ...current,
      ...next,
    }));
  }
  function changeExpansion(expanded: string[], visibleLimit: number) {
    setState((current) => ({
      ...current,
      expanded,
      visibleLimit,
    }));
  }
  function toggleExpansion(id: string) {
    const collapsing = state.expanded.includes(id);
    let expanded = collapsing
      ? state.expanded.filter((unit) => unit !== id)
      : [...state.expanded, id].slice(0, 24);
    if (collapsing && rootId) {
      const reachable = new Set(
        systemdNeighborhood(
          rootId,
          expanded,
          edges,
          [...SYSTEMD_RELATIONSHIP_GROUPS[state.relationshipGroup]],
          "",
          Infinity,
        ).ids,
      );
      expanded = expanded.filter((unit) => reachable.has(unit));
    }
    changeExpansion(
      expanded,
      collapsing
        ? (state.visibleLimit ?? SYSTEMD_INITIAL_VISIBLE)
        : Math.min(SYSTEMD_MAX_VISIBLE, (state.visibleLimit ?? SYSTEMD_INITIAL_VISIBLE) + 3),
    );
  }
  function keepExpansionFocus(control: HTMLButtonElement) {
    const keyboardFocus = control.matches(":focus-visible");
    requestAnimationFrame(() => {
      if (keyboardFocus && !control.isConnected)
        (
          graphContextRef.current?.querySelector<HTMLButtonElement>(
            ".systemd-expansion-actions button:not(:disabled)",
          ) ?? graphContextRef.current?.querySelector<HTMLButtonElement>(".systemd-root-label")
        )?.focus({ preventScroll: true });
    });
  }
  function clearFilters() {
    patch({ search: "", state: "all", unitType: "all" });
  }
  function revealSelection() {
    patch({ search: "", state: "all", unitType: "all", scope: "all" });
  }
  function selectInventoryUnit(id: string, navigate = false) {
    if (!navigate && id === selectedId && inspectorOpen) {
      closeInventoryInspector();
      return;
    }
    setInspectorOpen(true);
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
    const portsSnapshot = portsCacheRef.current;
    if (portsSnapshot && portsSnapshot.fetchedAt !== null) void loadUnitPorts(true);
    if (
      bootSnapshotRef.current ||
      (bootRead.target === targetRef.current && bootRead.status !== "idle")
    )
      void loadUnitBoot(true);
  }
  async function loadUnitPorts(force = false) {
    const current = portsCacheRef.current;
    const target = connectionTargetKey(connection);
    if (
      target !== targetRef.current ||
      !selectedId ||
      !/\.(service|socket)$/.test(selectedId) ||
      !current ||
      !onPortsCacheChange ||
      portsLoadingRef.current ||
      (!force && !current.loading && isCacheFresh(current) && !current.error)
    )
      return;
    const request = ++portsRequestRef.current;
    portsLoadingRef.current = true;
    const loading = { ...current, loading: true, error: null };
    portsCacheRef.current = loading;
    onPortsCacheChange(loading);
    try {
      const items = await api.listPorts(connection.id);
      if (request !== portsRequestRef.current || target !== targetRef.current) return;
      const next = { items, fetchedAt: Date.now(), loading: false, error: null };
      portsCacheRef.current = next;
      onPortsCacheChange(next);
    } catch (caught) {
      if (request !== portsRequestRef.current || target !== targetRef.current) return;
      const next = { ...current, loading: false, error: errorMessage(caught) };
      portsCacheRef.current = next;
      onPortsCacheChange(next);
    } finally {
      if (request === portsRequestRef.current) portsLoadingRef.current = false;
    }
  }
  async function loadUnitBoot(force = false) {
    const target = connectionTargetKey(connection);
    if (
      target !== targetRef.current ||
      !selectedId ||
      !onBootSnapshotChange ||
      bootLoadingRef.current ||
      (!force &&
        isCurrentBootSnapshotFresh(bootSnapshotRef.current) &&
        (bootRead.target !== target || bootRead.status === "idle"))
    )
      return;
    const request = ++bootRequestRef.current;
    bootLoadingRef.current = true;
    setBootRead({ target, status: "loading" });
    try {
      const next = await api.collectBootDiagnostics(connection.id, null, null);
      if (request !== bootRequestRef.current || target !== targetRef.current) return;
      bootSnapshotRef.current = next;
      onBootSnapshotChange(next);
      setBootRead({ target, status: "idle" });
    } catch {
      if (request !== bootRequestRef.current || target !== targetRef.current) return;
      setBootRead({ target, status: "error" });
    } finally {
      if (request === bootRequestRef.current) bootLoadingRef.current = false;
    }
  }
  function refocus(id: string) {
    setSelectedId(id);
    setInspectors((current) => ({ ...current, graph: false }));
    setGraphSearch("");
    patch({
      mode: "graph",
      rootId: id,
      expanded: [],
      visibleLimit: SYSTEMD_INITIAL_VISIBLE,
    });
  }

  useEffect(() => {
    if (
      state.mode === "graph" &&
      inspectorOpen &&
      selectedId &&
      neighborhood &&
      !neighborhood.ids.includes(selectedId)
    )
      setInspectorOpen(false);
  }, [state.mode, inspectorOpen, selectedId, neighborhood]);
  useEffect(() => {
    const list = inventoryRef.current?.querySelector(".dense-list");
    if (
      visibleInspector &&
      state.mode === "inventory" &&
      (selectionFocus.current === "inspector" ||
        !list ||
        getComputedStyle(list).visibility === "hidden")
    )
      inspectorRef.current?.focus({ preventScroll: true });
  }, [selectedId, visibleInspector, state.mode]);

  function closeInventoryInspector() {
    setInspectors({ inventory: false, graph: false });
    setSelectedId(null);
    const row = [
      ...(inventoryRef.current?.querySelectorAll<HTMLButtonElement>(".dense-row") ?? []),
    ].find((element) => element.getAttribute("aria-pressed") === "true");
    requestAnimationFrame(() =>
      (row ?? inventoryRef.current?.querySelector<HTMLElement>(".dense-list"))?.focus({
        preventScroll: true,
      }),
    );
  }
  const inspectorViewKey = JSON.stringify([cacheScope, state.mode, selectedId]);
  const inspector = selectedId && (
    <SystemdUnitInspector
      key={inspectorViewKey}
      initialViewState={inspectorViews.current.get(inspectorViewKey)}
      onViewStateChange={(view) => {
        inspectorViews.current.delete(inspectorViewKey);
        inspectorViews.current.set(inspectorViewKey, view);
        while (inspectorViews.current.size > 64)
          inspectorViews.current.delete(inspectorViews.current.keys().next().value!);
      }}
      connectionId={connection.id}
      cacheScope={cacheScope}
      unitId={selectedId}
      summary={selected}
      result={details[selectedId]}
      revision={revision}
      onRefresh={refreshDetails}
      onViewLogs={onViewLogs}
      onRequestPorts={onOpenPorts ? () => void loadUnitPorts() : undefined}
      onOpenPorts={
        portsCache &&
        !portsCache.loading &&
        !portsCache.error &&
        isCacheFresh(portsCache) &&
        /\.(service|socket)$/.test(selectedId) &&
        portsCache.items.some(
          (socket) => socket.ownership === "known" && socket.systemdUnit === selectedId,
        )
          ? onOpenPorts
          : undefined
      }
      onRequestBoot={onOpenBoot ? () => void loadUnitBoot() : undefined}
      onOpenBoot={
        (bootRead.target !== cacheScope || bootRead.status === "idle") &&
        hasUnitBootEvidence(bootSnapshot, selectedId)
          ? onOpenBoot
          : undefined
      }
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
        visible={filtered.length}
        failed={counts.failed}
        snapshot={snapshot}
        loading={cache.loading}
        canGraph={!!selectedId || (state.mode === "graph" && !!rootId)}
        selectedUnit={selectedId ?? (state.mode === "graph" ? rootId : null)}
        types={types}
        states={states}
        onChange={patch}
        onMode={(mode) => {
          if (mode === "graph" && selectedId && selectedId !== rootId) refocus(selectedId);
          else patch({ mode, rootId });
        }}
        onRefresh={() => {
          refreshDetails();
          void load(true);
        }}
      />
      {cache.error && (
        <p className="inline-warning" role="status">
          <WarningSign />
          Showing saved results. Refresh failed: {cache.error}
        </p>
      )}
      {state.mode === "inventory" ? (
        <div
          className={"systemd-explorer-stage" + (visibleInspector ? " inspecting" : "")}
          ref={inventoryRef}
          onKeyDown={(event) => {
            if (event.key === "Escape" && visibleInspector) {
              event.stopPropagation();
              closeInventoryInspector();
            }
            if (
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey ||
              event.target !== inspectorRef.current ||
              !["ArrowUp", "ArrowDown"].includes(event.key) ||
              !filtered.length
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            const current = filtered.findIndex((unit) => unit.id === selectedId);
            const next = Math.max(
              0,
              Math.min(filtered.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)),
            );
            selectionFocus.current = "inspector";
            selectInventoryUnit(filtered[next].id, true);
          }}
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
                <button type="button" className="link-button" onClick={revealSelection}>
                  Show selected unit
                </button>
              </div>
            )}
            <SystemdInventory
              units={filtered}
              scope={state.scope}
              selectedId={selectedId}
              onSelect={(id) => {
                selectionFocus.current = "inspector";
                selectInventoryUnit(id);
              }}
              onNavigate={(id) => {
                selectionFocus.current = "inventory";
                selectInventoryUnit(id, true);
              }}
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
          <div className="systemd-graph-context" ref={graphContextRef}>
            <button
              type="button"
              className="systemd-root-label"
              title="Refocus on current unit"
              onClick={() => rootId && refocus(rootId)}
            >
              <GitBranch size={14} />
              {rootId}
            </button>
            <div className="systemd-expansion-actions" role="group" aria-label="Graph expansion">
              {(neighborhood?.ids.length ?? 0) > SYSTEMD_INITIAL_VISIBLE && (
                <button
                  type="button"
                  className="systemd-more"
                  onClick={(event) => {
                    changeExpansion(
                      state.expanded,
                      Math.max(
                        SYSTEMD_INITIAL_VISIBLE,
                        Math.min(
                          state.visibleLimit ?? SYSTEMD_INITIAL_VISIBLE,
                          neighborhood?.ids.length ?? SYSTEMD_INITIAL_VISIBLE,
                        ) - 6,
                      ),
                    );
                    keepExpansionFocus(event.currentTarget);
                  }}
                >
                  Show less
                </button>
              )}
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
                  onClick={(event) => {
                    changeExpansion(
                      state.expanded,
                      Math.min(
                        SYSTEMD_MAX_VISIBLE,
                        (state.visibleLimit ?? SYSTEMD_INITIAL_VISIBLE) + 6,
                      ),
                    );
                    keepExpansionFocus(event.currentTarget);
                  }}
                >
                  Show more · {neighborhood.hidden}
                </button>
              )}
            </div>
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
              expansionKey={JSON.stringify([
                state.expanded,
                state.visibleLimit ?? SYSTEMD_INITIAL_VISIBLE,
              ])}
              onSelect={(id) => {
                setSelectedId(id);
                if (id) setInspectorOpen(true);
                else setInspectors({ inventory: false, graph: false });
              }}
              onRefocus={refocus}
              onExpand={toggleExpansion}
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
