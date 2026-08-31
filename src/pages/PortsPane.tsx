import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Search, ShieldAlert } from "lucide-react";
import { CredentialDialog } from "../components/CredentialDialog";
import { ErrorState, LoadingState } from "../components/PanelState";
import { PortsConnections } from "../components/ports/PortsConnections";
import { PortsDocker } from "../components/ports/PortsDocker";
import { PortsOverview } from "../components/ports/PortsOverview";
import { PortsTable } from "../components/ports/PortsTable";
import { api, errorMessage } from "../lib/api";
import { filterAndSortSockets, type Exposure } from "../lib/port-inspector";
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

type PortsTab = "overview" | "connections" | "docker" | "table";

const TABS: { id: PortsTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "connections", label: "Connections" },
  { id: "docker", label: "Docker" },
  { id: "table", label: "Table" },
];

export function PortsPane({
  connection,
  capabilities,
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
  cache: CachedList<ListeningSocket>;
  containersCache: CachedList<DockerContainer>;
  onCacheChange: (cache: CachedList<ListeningSocket>) => void;
  onContainersCacheChange: (cache: CachedList<DockerContainer>) => void;
  onOpenSystemd: (unitId: string) => void;
  onOpenContainer: (containerId: string) => void;
  onViewLogs: (source: LogSourceSelection) => void;
}) {
  const [tab, setTab] = useState<PortsTab>("overview");
  const [search, setSearch] = useState("");
  const [protocol, setProtocol] = useState("all");
  const [exposure, setExposure] = useState<Exposure | "all">("all");
  const [portsSudo, setPortsSudo] = useState(false);

  // Firewall and established connections are host-live data: kept in component
  // state only and never persisted to the Workspace.
  const [firewall, setFirewall] = useState<FirewallStatus | null>(null);
  const [firewallError, setFirewallError] = useState<string | null>(null);
  const [firewallSudo, setFirewallSudo] = useState(false);
  const [connections, setConnections] = useState<EstablishedConnections | null>(null);
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);

  const cacheRef = useRef(cache);
  const containersRef = useRef(containersCache);
  const requestRef = useRef(0);
  const ownerRequestRef = useRef(0);
  const firewallRef = useRef(0);
  const connectionsRef = useRef(0);
  cacheRef.current = cache;
  containersRef.current = containersCache;

  async function loadContainers(force = false) {
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
    if (!force && isCacheFresh(current)) {
      void loadContainers();
      return;
    }
    const request = ++requestRef.current;
    onCacheChange({ ...current, loading: true, error: null });
    try {
      const items = await api.listPorts(connection.id, sudoPassword);
      if (request !== requestRef.current) return;
      onCacheChange({ items, fetchedAt: Date.now(), loading: false, error: null });
      void loadContainers();
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
    void loadFirewall();
    return () => {
      requestRef.current += 1;
      ownerRequestRef.current += 1;
      firewallRef.current += 1;
      connectionsRef.current += 1;
    };
  }, [connection.id]);

  useEffect(() => {
    if (tab === "connections") void loadConnections();
  }, [tab]);

  function refresh() {
    void loadPorts(true);
    void loadContainers(true);
    void loadFirewall();
    if (tab === "connections") void loadConnections(true);
  }

  const filteredSockets = useMemo(
    () =>
      filterAndSortSockets(
        cache.items,
        containersCache.items,
        search,
        protocol,
        "port-asc",
        exposure,
      ),
    [cache.items, containersCache.items, search, protocol, exposure],
  );

  const collectedAt = cache.fetchedAt
    ? new Date(cache.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  const hostLabel = capabilities?.hostname || connection.displayName;

  if (cache.loading && !cache.items.length)
    return <LoadingState label="Reading listening ports…" />;
  if (cache.error && !cache.items.length) {
    return (
      <ErrorState
        message={cache.error}
        action={<button onClick={() => loadPorts(true)}>Retry</button>}
      />
    );
  }

  const showProtocol = tab !== "connections";
  const showExposure = tab === "overview" || tab === "table";
  const unresolvedOwners = cache.items.some((socket) => socket.ownership !== "known");

  return (
    <section className="feature-page ports-page">
      <header className="page-heading compact-heading">
        <div>
          <h2>Ports</h2>
          <p>
            {cache.items.length} listening socket{cache.items.length === 1 ? "" : "s"}
            {collectedAt ? ` · collected at ${collectedAt}` : ""}
          </p>
          <small className="unit-scope-note">
            Manual snapshot of the current host, not a network scan
          </small>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={refresh}
          aria-label="Refresh ports"
          disabled={cache.loading}
        >
          <RefreshCw size={16} className={cache.loading ? "spinning" : ""} />
        </button>
      </header>

      <nav className="ports-tabs" role="tablist" aria-label="Ports views">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={tab === entry.id ? "ports-tab active" : "ports-tab"}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {cache.error && (
        <p className="inline-warning">Showing saved results. Refresh failed: {cache.error}</p>
      )}
      {firewallError && (tab === "overview" || tab === "table") && (
        <p className="inline-warning firewall-warning">
          <ShieldAlert size={14} /> Firewall status unavailable: {firewallError}
          {firewallError.toLowerCase().includes("permission denied") && (
            <button type="button" className="link-button" onClick={() => setFirewallSudo(true)}>
              Retry with sudo
            </button>
          )}
        </p>
      )}
      {unresolvedOwners && (tab === "overview" || tab === "table") && (
        <p className="inline-warning firewall-warning">
          <ShieldAlert size={14} /> Some listeners could not be attributed to a process without
          elevation.
          <button type="button" className="link-button" onClick={() => setPortsSudo(true)}>
            Resolve owners with sudo
          </button>
        </p>
      )}

      <div className="port-list-controls">
        <label className="search-field">
          <Search size={15} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search ports, services, processes, or containers"
          />
        </label>
        {showProtocol && (
          <select
            aria-label="Protocol filter"
            value={protocol}
            onChange={(event) => setProtocol(event.target.value)}
          >
            <option value="all">TCP + UDP</option>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
          </select>
        )}
        {showExposure && (
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
        )}
      </div>

      <div className="ports-tab-body">
        {tab === "overview" && (
          <PortsOverview
            sockets={filteredSockets}
            containers={containersCache.items}
            firewall={firewall}
            capabilities={capabilities}
            hostLabel={hostLabel}
            onOpenSystemd={onOpenSystemd}
            onOpenContainer={onOpenContainer}
            onViewLogs={onViewLogs}
          />
        )}
        {tab === "connections" && (
          <PortsConnections
            connections={connections}
            loading={connectionsLoading}
            error={connectionsError}
            search={search}
            onRetry={() => loadConnections(true)}
            onOpenSystemd={onOpenSystemd}
            onViewLogs={onViewLogs}
          />
        )}
        {tab === "docker" && (
          <PortsDocker
            containersCache={containersCache}
            search={search}
            protocol={protocol}
            onRetry={() => loadContainers(true)}
            onOpenContainer={onOpenContainer}
            onViewLogs={onViewLogs}
          />
        )}
        {tab === "table" && (
          <PortsTable
            sockets={cache.items}
            containers={containersCache.items}
            firewall={firewall}
            search={search}
            protocol={protocol}
            exposure={exposure}
            onOpenSystemd={onOpenSystemd}
            onOpenContainer={onOpenContainer}
            onViewLogs={onViewLogs}
          />
        )}
      </div>

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
