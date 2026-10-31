import type { PublishedPortSelection } from "../lib/port-inspector";
import { Search } from "../components/MagnifierIcon";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { CredentialDialog } from "../components/CredentialDialog";
import { PortsGraph } from "../components/ports/PortsGraph";
import { api, errorMessage } from "../lib/api";
import {
  ownerGapNotice,
  type Exposure,
  type PortGraphKind,
  type PortSort,
} from "../lib/port-inspector";
import { elevationAllowed } from "../lib/sudo-elevation";
import { isCacheFresh } from "../lib/workspace-cache";
import type {
  CachedList,
  DockerContainer,
  EstablishedConnections,
  FirewallStatus,
  HostCapabilities,
  ListeningSocket,
  LogSourceSelection,
  SavedConnection,
} from "../types";

export function PortsPane({
  connection,
  capabilities,
  globalSudoEnabled,
  cache,
  containersCache,
  onCacheChange,
  onContainersCacheChange,
  onOpenSystemd,
  onOpenContainer,
  onViewLogs,
  focusEndpoint,
}: {
  focusEndpoint?: PublishedPortSelection;
  connection: SavedConnection;
  capabilities: HostCapabilities | null;
  globalSudoEnabled: boolean;
  cache: CachedList<ListeningSocket>;
  containersCache: CachedList<DockerContainer>;
  onCacheChange: (cache: CachedList<ListeningSocket>) => void;
  onContainersCacheChange: (cache: CachedList<DockerContainer>) => void;
  onOpenSystemd: (unitId: string) => void;
  onOpenContainer: (containerId: string) => void;
  onViewLogs: (source: LogSourceSelection) => void;
}) {
  const [kind, setKind] = useState<PortGraphKind>("overview");
  const [showConnections, setShowConnections] = useState(false);
  const [sort, setSort] = useState<PortSort>("port-asc");
  const [tools, setTools] = useState<"search" | "filters" | "info" | null>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const toolsButtonRef = useRef<HTMLButtonElement | null>(null);
  const [search, setSearch] = useState("");
  const [protocol, setProtocol] = useState("all");
  const [exposure, setExposure] = useState<Exposure | "all">("all");
  const filtersActive =
    kind !== "overview" || protocol !== "all" || exposure !== "all" || sort !== "port-asc";
  const connectionsVisible =
    kind === "all" || kind === "connections" || (kind === "overview" && showConnections);
  const [portsSudo, setPortsSudo] = useState(false);
  // Whether the read behind the current list actually ran as root. A permission
  // the account cannot use does not elevate anything, so this is not the same
  // as the setting being on.
  const [portsElevated, setPortsElevated] = useState(false);

  // Firewall and established connections are host-live data: kept in component
  // state only and never persisted to the Workspace.
  const [firewall, setFirewall] = useState<FirewallStatus | null>(null);
  const [firewallError, setFirewallError] = useState<string | null>(null);
  const [firewallSudo, setFirewallSudo] = useState(false);
  const [connections, setConnections] = useState<EstablishedConnections | null>(null);
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);

  // An allowance only elevates an account sudo does not question. Without the
  // capability the read runs unelevated no matter what the switches say.
  const elevationInEffect =
    elevationAllowed(globalSudoEnabled, connection.sudoEnabled) &&
    capabilities?.passwordlessSudo === true;

  const cacheRef = useRef(cache);
  const containersRef = useRef(containersCache);
  const requestRef = useRef(0);
  const ownerRequestRef = useRef(0);
  const firewallRef = useRef(0);
  const connectionsRef = useRef(0);
  cacheRef.current = cache;
  containersRef.current = containersCache;

  async function loadContainers(force = false) {
    if (capabilities?.osId === "windows" && !capabilities.dockerAvailable) {
      onContainersCacheChange({ items: [], fetchedAt: Date.now(), loading: false, error: null });
      return;
    }
    const current = containersRef.current;
    if (!force && isCacheFresh(current)) return;
    const request = ++ownerRequestRef.current;
    onContainersCacheChange({ ...current, loading: true, error: null });
    try {
      const items = await api.listContainers(connection.id);
      if (request !== ownerRequestRef.current) return;
      onContainersCacheChange({ items, fetchedAt: Date.now(), loading: false, error: null });
    } catch (caught) {
      if (request !== ownerRequestRef.current) return;
      onContainersCacheChange({
        ...containersRef.current,
        loading: false,
        error: errorMessage(caught),
      });
    }
  }

  async function loadPorts(force = false, sudoPassword: string | null = null) {
    const current = cacheRef.current;
    if (!force && isCacheFresh(current)) return;
    const request = ++requestRef.current;
    onCacheChange({ ...current, loading: true, error: null });
    try {
      const items = await api.listPorts(connection.id, sudoPassword);
      if (request !== requestRef.current) return;
      setPortsElevated(sudoPassword !== null || elevationInEffect);
      onCacheChange({ items, fetchedAt: Date.now(), loading: false, error: null });
    } catch (caught) {
      if (request !== requestRef.current) return;
      onCacheChange({ ...cacheRef.current, loading: false, error: errorMessage(caught) });
    }
  }

  async function loadFirewall(sudoPassword: string | null = null) {
    const request = ++firewallRef.current;
    setFirewallError(null);
    try {
      const status = await api.inspectFirewall(connection.id, sudoPassword);
      if (request !== firewallRef.current) return;
      setFirewall(status);
    } catch (caught) {
      if (request !== firewallRef.current) return;
      setFirewall(null);
      setFirewallError(errorMessage(caught));
    }
  }

  async function loadConnections(force = false) {
    if (!force && connections) return;
    const request = ++connectionsRef.current;
    setConnectionsLoading(true);
    setConnectionsError(null);
    try {
      const result = await api.inspectConnections(connection.id);
      if (request !== connectionsRef.current) return;
      setConnections(result);
    } catch (caught) {
      if (request !== connectionsRef.current) return;
      setConnectionsError(errorMessage(caught));
    } finally {
      if (request === connectionsRef.current) setConnectionsLoading(false);
    }
  }

  useEffect(() => {
    void loadPorts();
    void loadContainers();
    void loadFirewall();
    void loadConnections();
    return () => {
      requestRef.current += 1;
      ownerRequestRef.current += 1;
      firewallRef.current += 1;
      connectionsRef.current += 1;
    };
  }, [connection.id]);

  // Changing the elevation allowance changes what a read can see, so the cached
  // list from the other side of that change is stale by definition.
  const firstElevationRef = useRef(true);
  useEffect(() => {
    if (firstElevationRef.current) {
      firstElevationRef.current = false;
      return;
    }
    void loadPorts(true);
    void loadConnections(true);
  }, [elevationInEffect]);

  function refresh() {
    void loadPorts(true);
    void loadContainers(true);
    void loadFirewall();
    void loadConnections(true);
  }

  useEffect(() => {
    // The credential modal owns outside clicks and Escape until it closes.
    if (!tools || firewallSudo || portsSudo) return;
    const panel = toolsRef.current?.querySelector<HTMLElement>(".ports-tools-panel");
    (panel?.querySelector<HTMLElement>("input, select") ?? panel)?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !toolsRef.current?.contains(event.target)) setTools(null);
    };
    const escape = (event: KeyboardEvent) => {
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
  }, [tools, firewallSudo, portsSudo]);

  useEffect(() => {
    if (cache.error || firewallError || connectionsError || containersCache.error) setTools("info");
  }, [cache.error, firewallError, connectionsError, containersCache.error]);

  function toggleTools(next: "search" | "filters" | "info", button: HTMLButtonElement) {
    toolsButtonRef.current = button;
    setTools((current) => (current === next ? null : next));
  }

  const collectedAt = cache.fetchedAt
    ? new Date(cache.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  const hostLabel = capabilities?.hostname || connection.displayName;

  const ownerGap =
    capabilities?.osId === "windows"
      ? cache.items.some((socket) => socket.ownership === "unavailable")
        ? {
            message: "Some owning processes could not be read by this Windows SSH account.",
            offerSudo: false,
          }
        : null
      : ownerGapNotice(cache.items, portsElevated);

  const hasWarnings = !!(
    cache.error ||
    firewallError ||
    connectionsError ||
    containersCache.error ||
    ownerGap
  );
  const snapshotDescription = [
    collectedAt ? "Last collected at " + collectedAt : null,
    cache.items.length + " listening port" + (cache.items.length === 1 ? "" : "s"),
    connections
      ? connections.totalEstablished +
        " active connection" +
        (connections.totalEstablished === 1 ? "" : "s")
      : null,
    connections?.truncated ? "Connection list limited to 4,000 rows" : null,
    cache.loading ? "Reading listening ports…" : null,
    connectionsLoading ? "Reading established connections…" : null,
    containersCache.loading ? "Reading Docker containers…" : null,
  ]
    .filter(Boolean)
    .join("\n");

  useEffect(() => {
    if (!hasWarnings && tools === "info") setTools(null);
  }, [hasWarnings, tools]);

  return (
    <section className="feature-page ports-page">
      <PortsGraph
        focusEndpoint={focusEndpoint}
        loading={cache.loading || containersCache.loading || containersCache.fetchedAt === null}
        sockets={cache.items}
        containers={containersCache.items}
        firewall={firewall}
        capabilities={capabilities}
        hostLabel={hostLabel}
        connections={connections}
        search={search}
        protocol={protocol}
        exposure={exposure}
        kind={kind}
        sort={sort}
        showConnections={showConnections}
        emptyMessage={
          kind === "connections" && connectionsLoading
            ? "Reading established connections…"
            : kind === "connections" && connectionsError
              ? "Connections unavailable"
              : cache.loading
                ? "Reading listening ports…"
                : kind === "listeners" && cache.error
                  ? "Listening ports unavailable"
                  : kind === "connections" && !connections?.groups.length
                    ? "No established connections"
                    : "No ports match the current filters"
        }
        onOpenSystemd={onOpenSystemd}
        onOpenContainer={onOpenContainer}
        onViewLogs={onViewLogs}
        toolbar={
          <div className="ports-controls" ref={toolsRef}>
            <header className="ports-heading" data-tooltip-boundary>
              <h2
                tabIndex={0}
                title={snapshotDescription}
                data-tooltip-align="start"
                aria-describedby="ports-snapshot-description"
              >
                Ports
              </h2>
              <span id="ports-snapshot-description" className="sr-only">
                {snapshotDescription}
              </span>
              {hasWarnings && (
                <button
                  type="button"
                  className="icon-button"
                  title="Ports reading warnings"
                  aria-label="Ports reading warnings"
                  aria-expanded={tools === "info"}
                  aria-controls="ports-tools"
                  onClick={(event) => toggleTools("info", event.currentTarget)}
                >
                  <ShieldAlert size={14} />
                </button>
              )}
              <button
                type="button"
                className="icon-button"
                aria-label="Find ports"
                title="Find ports"
                aria-expanded={tools === "search"}
                aria-pressed={!!search}
                aria-controls="ports-tools"
                onClick={(event) => toggleTools("search", event.currentTarget)}
              >
                <Search size={16} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Filter ports"
                title="Filter ports"
                aria-expanded={tools === "filters"}
                aria-pressed={filtersActive}
                aria-controls="ports-tools"
                onClick={(event) => toggleTools("filters", event.currentTarget)}
              >
                <SlidersHorizontal size={16} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Show established connections"
                title="Show established and outbound connections"
                aria-pressed={connectionsVisible}
                onClick={() => {
                  setShowConnections(!connectionsVisible);
                  setKind("overview");
                }}
              >
                <ArrowLeftRight size={16} />
              </button>
              <button
                className="icon-button"
                type="button"
                onClick={refresh}
                aria-label="Refresh ports"
                disabled={cache.loading || connectionsLoading}
              >
                <RefreshCw
                  size={16}
                  className={cache.loading || connectionsLoading ? "spinning" : ""}
                />
              </button>
            </header>
            {tools && (
              <div
                id="ports-tools"
                className="ports-tools-panel"
                role="region"
                tabIndex={-1}
                aria-label={
                  tools === "search"
                    ? "Find ports"
                    : tools === "filters"
                      ? "Port filters"
                      : "Ports reading warnings"
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
                          setKind("overview");
                          setProtocol("all");
                          setExposure("all");
                          setSort("port-asc");
                        }}
                      >
                        <RotateCcw size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Close port tools"
                      onClick={() => {
                        setTools(null);
                        toolsButtonRef.current?.focus();
                      }}
                    >
                      <X size={14} />
                    </button>
                  </header>
                )}
                {tools === "info" && (
                  <>
                    <div className="ports-reading-body">
                      {cache.error && (
                        <p className="inline-warning">
                          {cache.items.length
                            ? "Showing saved results. Refresh failed: "
                            : "Listening ports unavailable: "}
                          {cache.error}
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => loadPorts(true)}
                          >
                            Retry ports
                          </button>
                        </p>
                      )}
                      {connectionsError && (
                        <p className="inline-warning">
                          {connections
                            ? "Showing saved connections. Refresh failed: "
                            : "Connections unavailable: "}
                          {connectionsError}
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => loadConnections(true)}
                          >
                            Retry connections
                          </button>
                        </p>
                      )}
                      {containersCache.error && (
                        <p className="inline-warning">
                          {containersCache.items.length
                            ? "Showing saved Docker mappings. Refresh failed: "
                            : "Docker mappings unavailable: "}
                          {containersCache.error}
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => loadContainers(true)}
                          >
                            Retry Docker
                          </button>
                        </p>
                      )}
                      {firewallError && (
                        <p className="inline-warning">
                          Firewall status unavailable: {firewallError}
                          {capabilities?.osId !== "windows" &&
                            firewallError.toLowerCase().includes("permission denied") && (
                              <button
                                type="button"
                                className="link-button"
                                onClick={() => setFirewallSudo(true)}
                              >
                                Retry with sudo
                              </button>
                            )}
                        </p>
                      )}
                      {ownerGap && (
                        <p className="inline-warning">
                          {ownerGap.message}
                          {ownerGap.offerSudo && (
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => setPortsSudo(true)}
                            >
                              Resolve owners with sudo
                            </button>
                          )}
                        </p>
                      )}
                    </div>
                  </>
                )}
                {tools === "search" && (
                  <div className="search-field ports-search-field">
                    <Search size={15} />
                    <input
                      aria-label="Search ports"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search ports or owners"
                    />
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Clear search"
                      title="Clear search"
                      disabled={!search}
                      onClick={() => {
                        setSearch("");
                        toolsRef.current?.querySelector("input")?.focus();
                      }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
                {tools === "filters" && (
                  <>
                    <div className="port-list-controls">
                      <label>
                        <span>Contents</span>
                        <select
                          aria-label="Graph contents"
                          value={kind}
                          onChange={(event) => setKind(event.target.value as PortGraphKind)}
                        >
                          <option value="overview">Listening + published</option>
                          <option value="all">All socket types</option>
                          <option value="listeners">Listeners</option>
                          <option value="connections">Established / outbound</option>
                        </select>
                      </label>
                      <label>
                        <span>Protocol</span>
                        <select
                          aria-label="Protocol filter"
                          value={protocol}
                          onChange={(event) => setProtocol(event.target.value)}
                        >
                          <option value="all">TCP + UDP</option>
                          <option value="tcp">TCP</option>
                          <option value="udp">UDP</option>
                        </select>
                      </label>
                      <label>
                        <span>Binding scope</span>
                        <select
                          aria-label="Binding scope"
                          value={exposure}
                          onChange={(event) => setExposure(event.target.value as Exposure | "all")}
                        >
                          <option value="all">Any binding scope</option>
                          <option value="all-interfaces">All interfaces</option>
                          <option value="local-only">Loopback only</option>
                          <option value="non-loopback">Non-loopback</option>
                          <option value="specific">Specific address</option>
                        </select>
                      </label>
                      <label>
                        <span>Sort</span>
                        <select
                          aria-label="Sort ports"
                          value={sort}
                          onChange={(event) => setSort(event.target.value as PortSort)}
                        >
                          <option value="port-asc">Port ↑</option>
                          <option value="port-desc">Port ↓</option>
                          <option value="protocol">Protocol</option>
                          <option value="address">Address</option>
                          <option value="process">Process</option>
                        </select>
                      </label>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        }
      />

      {firewallSudo && (
        <CredentialDialog
          connectionLabel={connection.displayName}
          onClose={() => setFirewallSudo(false)}
          onSubmit={async (password) => {
            setFirewallSudo(false);
            await loadFirewall(password);
          }}
        />
      )}
      {portsSudo && (
        <CredentialDialog
          connectionLabel={connection.displayName}
          onClose={() => setPortsSudo(false)}
          onSubmit={async (password) => {
            setPortsSudo(false);
            await loadPorts(true, password);
          }}
        />
      )}
    </section>
  );
}
