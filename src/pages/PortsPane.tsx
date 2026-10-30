import { useEffect, useRef, useState } from "react";
import { RefreshCw, Search, ShieldAlert } from "lucide-react";
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
}: {
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
  const [kind, setKind] = useState<PortGraphKind>("all");
  const [sort, setSort] = useState<PortSort>("port-asc");
  const [search, setSearch] = useState("");
  const [protocol, setProtocol] = useState("all");
  const [exposure, setExposure] = useState<Exposure | "all">("all");
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

  return (
    <section className="feature-page ports-page">
      <PortsGraph
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
        emptyMessage={
          kind === "connections" && connectionsLoading
            ? "Reading established connections…"
            : kind === "connections" && connectionsError
              ? "Connections unavailable"
              : kind === "docker" && containersCache.loading
                ? "Reading Docker containers…"
                : kind === "docker" && containersCache.error
                  ? "Docker mappings unavailable"
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
          <div className="ports-controls">
            <header className="ports-heading">
              <h2>Ports</h2>
              <span
                title={cache.fetchedAt ? new Date(cache.fetchedAt).toLocaleString() : undefined}
              >
                {cache.items.length} listener{cache.items.length === 1 ? "" : "s"}
                {collectedAt ? ` · ${collectedAt}` : ""}
              </span>
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
            <div className="port-list-controls">
              <label className="search-field">
                <Search size={15} />
                <input
                  aria-label="Search ports"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search ports, owners, or endpoints"
                />
              </label>
              <select
                aria-label="Graph contents"
                value={kind}
                onChange={(event) => setKind(event.target.value as PortGraphKind)}
              >
                <option value="all">All ports</option>
                <option value="listeners">Listeners</option>
                <option value="connections">Connections</option>
                <option value="docker">Docker</option>
              </select>
              <select
                aria-label="Protocol filter"
                value={protocol}
                onChange={(event) => setProtocol(event.target.value)}
              >
                <option value="all">TCP + UDP</option>
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
              </select>
              <select
                aria-label="Exposure filter"
                value={exposure}
                onChange={(event) => setExposure(event.target.value as Exposure | "all")}
              >
                <option value="all">Any exposure</option>
                <option value="all-interfaces">All interfaces</option>
                <option value="local-only">Local only</option>
                <option value="specific">Specific address</option>
              </select>
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
            </div>
          </div>
        }
        status={
          <details
            className="ports-reading-status"
            open={
              cache.error || firewallError || connectionsError || containersCache.error
                ? true
                : undefined
            }
          >
            <summary>
              <ShieldAlert size={14} />{" "}
              {cache.error || firewallError || connectionsError || containersCache.error || ownerGap
                ? "Snapshot warnings"
                : "Snapshot details"}
            </summary>
            <div className="ports-reading-body">
              <p>
                Manual snapshot · {cache.items.length} listening sockets
                {collectedAt ? ` · collected at ${collectedAt}` : ""}
              </p>
              {cache.loading && <p role="status">Reading listening ports…</p>}
              {connections && (
                <p>
                  {connections.totalEstablished} established connections
                  {connections.truncated ? " · list truncated at 4000 rows" : ""}
                </p>
              )}
              {connectionsLoading && <p role="status">Reading established connections…</p>}
              {containersCache.loading && <p role="status">Reading Docker containers…</p>}
              {cache.error && (
                <p className="inline-warning">
                  {cache.items.length
                    ? "Showing saved results. Refresh failed: "
                    : "Listening ports unavailable: "}
                  {cache.error}
                  <button type="button" className="link-button" onClick={() => loadPorts(true)}>
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
          </details>
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
