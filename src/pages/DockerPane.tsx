import type { PublishedPortSelection } from "../lib/port-inspector";
import { Search } from "../components/MagnifierIcon";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Container,
  Layers,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { CredentialDialog } from "../components/CredentialDialog";
import { DockerContainerInspector } from "../components/DockerContainerInspector";
import { ContainerImageIcon } from "../components/ContainerImageIcon";
import { InspectionGraph } from "../components/InspectionGraph";
import { api, errorMessage } from "../lib/api";
import {
  composeContainerLabel,
  filterDockerContainers,
  groupDockerContainers,
} from "../lib/docker-compose-grouping";
import { isCacheFresh } from "../lib/workspace-cache";
import type {
  CachedList,
  CachedValue,
  DockerContainer,
  DockerContainerDetails,
  LogSourceSelection,
  SavedConnection,
  HostCapabilities,
} from "../types";

export function DockerPane({
  connection,
  windowsHost = false,
  capabilities = null,
  cache,
  detailsCache,
  onCacheChange,
  onDetailsCacheChange,
  onViewLogs,
  focusId = null,
  onOpenPort,
}: {
  onOpenPort?: (port: PublishedPortSelection) => void;
  connection: SavedConnection;
  windowsHost?: boolean;
  capabilities?: HostCapabilities | null;
  cache: CachedList<DockerContainer>;
  detailsCache: Record<string, CachedValue<DockerContainerDetails>>;
  onCacheChange: (cache: CachedList<DockerContainer>) => void;
  onDetailsCacheChange: (containerId: string, cache: CachedValue<DockerContainerDetails>) => void;
  onViewLogs: (source: LogSourceSelection) => void;
  focusId?: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(focusId);
  const [search, setSearch] = useState("");
  const [grouped, setGrouped] = useState(true);
  const [state, setState] = useState("all");
  const [tools, setTools] = useState<"search" | "filters" | "info" | null>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const toolsButtonRef = useRef<HTMLButtonElement | null>(null);
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
    if (focusId) setSelectedId(focusId);
  }, [focusId]);

  useEffect(() => {
    if (selectedId) void loadDetails(selectedId);
  }, [selectedId]);

  const groups = useMemo(() => {
    const filtered = filterDockerContainers(cache.items, search).filter(
      (container) => state === "all" || container.state === state,
    );
    const branches = grouped
      ? groupDockerContainers(filtered).filter((group) => group.containers.length)
      : filtered.map((container) => ({
          id: container.id,
          label: container.name,
          project: null,
          containers: [container],
        }));
    return branches.map((group) => ({
      id: group.id,
      label: group.label,
      icon: group.project ? <Layers size={14} /> : <Container size={14} />,
      items: group.containers.map((container) => ({
        id: container.id,
        content: (
          <>
            <span className="arch-chip-title docker-chip-title">
              <ContainerImageIcon image={container.image} />
              <strong>{grouped ? composeContainerLabel(container) : container.name}</strong>
            </span>
            <span className="arch-chip-meta">
              {grouped && composeContainerLabel(container) !== container.name
                ? container.name
                : container.image}
            </span>
            <span className="arch-chip-kind docker-chip-state">
              <span className={`service-indicator service-${container.state}`} aria-hidden="true" />
              <span>{container.state}</span>
            </span>
          </>
        ),
      })),
    }));
  }, [cache.items, search, grouped, state]);
  const selected = cache.items.find((container) => container.id === selectedId) ?? null;
  const permissionError = !windowsHost && cache.error?.toLowerCase().includes("permission denied");
  const filtersActive = !grouped || state !== "all";
  const states = [
    ...new Set([
      ...cache.items.map((container) => container.state),
      ...(state === "all" ? [] : [state]),
    ]),
  ].sort();
  const snapshotDescription = [
    cache.fetchedAt
      ? "Last collected at " +
        new Date(cache.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : null,
    `${cache.items.filter((container) => container.state === "running").length} running · ${cache.items.length} total`,
    cache.loading ? "Reading Docker containers…" : null,
  ]
    .filter(Boolean)
    .join("\n");

  useEffect(() => {
    if (cache.error) setTools("info");
    else setTools((current) => (current === "info" ? null : current));
  }, [cache.error]);

  useEffect(() => {
    if (!tools || sudoPurpose) return;
    const panel = toolsRef.current?.querySelector<HTMLElement>(".ports-tools-panel");
    (panel?.querySelector<HTMLElement>("input, select") ?? panel)?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !toolsRef.current?.contains(event.target)) setTools(null);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setTools(null);
        toolsButtonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [tools, sudoPurpose]);

  function toggleTools(next: "search" | "filters" | "info", button: HTMLButtonElement) {
    toolsButtonRef.current = button;
    setTools((current) => (current === next ? null : next));
  }

  return (
    <section className="feature-page ports-page docker-page">
      <InspectionGraph
        groups={groups}
        hostLabel={capabilities?.hostname || connection.displayName}
        hostDescription={[capabilities?.osName, capabilities?.osVersion].filter(Boolean).join(" ")}
        graphLabel="Docker graph"
        loading={cache.loading || (cache.fetchedAt === null && !cache.error)}
        selectedId={selectedId}
        onSelectionChange={setSelectedId}
        inspectorId="container-inspector"
        inspectorLabel="Container details"
        emptyMessage={
          cache.loading
            ? "Reading Docker containers…"
            : cache.error && !cache.items.length
              ? "Docker unavailable"
              : cache.items.length
                ? "No matching containers"
                : "No containers found"
        }
        inspector={
          selected && (
            <DockerContainerInspector
              key={selected.id}
              onOpenPort={onOpenPort}
              summary={selected}
              windowsHost={windowsHost}
              cache={detailsCache[selected.id]}
              onRefresh={() => loadDetails(selected.id, null, true)}
              onRetryWithSudo={() => setSudoPurpose("details")}
              onViewLogs={() => onViewLogs({ type: "docker", id: selected.id })}
            />
          )
        }
        toolbar={
          <div className="ports-controls" ref={toolsRef}>
            <header className="ports-heading" data-tooltip-boundary>
              <h2
                tabIndex={0}
                title={snapshotDescription}
                data-tooltip-align="start"
                aria-describedby="docker-snapshot-description"
              >
                Containers
              </h2>
              <span id="docker-snapshot-description" className="sr-only">
                {snapshotDescription}
              </span>
              {cache.error && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Docker reading warnings"
                  title="Docker reading warnings"
                  aria-expanded={tools === "info"}
                  aria-controls="docker-tools"
                  onClick={(event) => toggleTools("info", event.currentTarget)}
                >
                  <ShieldAlert size={14} />
                </button>
              )}
              <button
                type="button"
                className="icon-button"
                aria-label="Find containers"
                title="Find containers"
                aria-expanded={tools === "search"}
                aria-pressed={!!search}
                aria-controls="docker-tools"
                onClick={(event) => toggleTools("search", event.currentTarget)}
              >
                <Search size={16} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Filter containers"
                title="Filter containers"
                aria-expanded={tools === "filters"}
                aria-pressed={filtersActive}
                aria-controls="docker-tools"
                onClick={(event) => toggleTools("filters", event.currentTarget)}
              >
                <SlidersHorizontal size={16} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Refresh containers"
                disabled={cache.loading}
                onClick={() => load(null, true)}
              >
                <RefreshCw size={16} className={cache.loading ? "spinning" : ""} />
              </button>
            </header>
            {tools && (
              <div
                id="docker-tools"
                className="ports-tools-panel"
                role="region"
                tabIndex={-1}
                aria-label={
                  tools === "search"
                    ? "Find containers"
                    : tools === "filters"
                      ? "Container filters"
                      : "Docker reading warnings"
                }
              >
                {tools !== "search" && (
                  <header className="ports-tools-heading">
                    <strong>{tools === "filters" ? "Filters" : "Reading warnings"}</strong>
                    {tools === "filters" && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Reset filters"
                        title="Reset filters"
                        disabled={!filtersActive}
                        onClick={() => {
                          setGrouped(true);
                          setState("all");
                        }}
                      >
                        <RotateCcw size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Close container tools"
                      onClick={() => {
                        setTools(null);
                        toolsButtonRef.current?.focus();
                      }}
                    >
                      <X size={14} />
                    </button>
                  </header>
                )}
                {tools === "search" && (
                  <label className="search-field ports-search-field">
                    <Search size={16} />
                    <input
                      aria-label="Search containers"
                      placeholder="Search projects, services, or containers"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Clear search"
                      disabled={!search}
                      onClick={() => setSearch("")}
                    >
                      <X size={14} />
                    </button>
                  </label>
                )}
                {tools === "filters" && (
                  <div className="port-list-controls">
                    <label>
                      <span>Container state</span>
                      <select value={state} onChange={(event) => setState(event.target.value)}>
                        <option value="all">All states</option>
                        {states.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Group by</span>
                      <select
                        value={grouped ? "project" : "none"}
                        onChange={(event) => setGrouped(event.target.value === "project")}
                      >
                        <option value="project">Compose project</option>
                        <option value="none">None</option>
                      </select>
                    </label>
                  </div>
                )}
                {tools === "info" && (
                  <div className="ports-reading-body">
                    <p className="inline-warning">
                      <span>
                        {cache.items.length ? "Showing saved results. Refresh failed: " : ""}
                        {cache.error}
                      </span>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() =>
                          permissionError ? setSudoPurpose("list") : load(null, true)
                        }
                      >
                        {permissionError ? "Retry with sudo" : "Retry"}
                      </button>
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        }
      />
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
