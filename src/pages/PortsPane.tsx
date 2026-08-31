import { useEffect, useMemo, useRef, useState } from "react";
import { Boxes, FileClock, RefreshCw, Search, Server } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import {
  filterAndSortSockets,
  resolveSocketContainer,
  socketScope,
  type PortSort,
} from "../lib/port-inspector";
import { isCacheFresh, reconcileSelection } from "../lib/workspace-cache";
import type {
  CachedList,
  DockerContainer,
  ListeningSocket,
  LogSourceSelection,
  SavedConnection,
} from "../types";

export function PortsPane({
  connection,
  cache,
  containersCache,
  onCacheChange,
  onContainersCacheChange,
  onOpenSystemd,
  onOpenContainer,
  onViewLogs,
}: {
  connection: SavedConnection;
  cache: CachedList<ListeningSocket>;
  containersCache: CachedList<DockerContainer>;
  onCacheChange: (cache: CachedList<ListeningSocket>) => void;
  onContainersCacheChange: (cache: CachedList<DockerContainer>) => void;
  onOpenSystemd: (unitId: string) => void;
  onOpenContainer: (containerId: string) => void;
  onViewLogs: (source: LogSourceSelection) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    reconcileSelection(cache.items, null),
  );
  const [search, setSearch] = useState("");
  const [protocol, setProtocol] = useState("all");
  const [sort, setSort] = useState<PortSort>("port-asc");
  const cacheRef = useRef(cache);
  const containersRef = useRef(containersCache);
  const requestRef = useRef(0);
  const ownerRequestRef = useRef(0);
  cacheRef.current = cache;
  containersRef.current = containersCache;

  async function loadContainerOwners() {
    const current = containersRef.current;
    if (isCacheFresh(current)) return;
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

  async function load(force = false) {
    const current = cacheRef.current;
    if (!force && isCacheFresh(current)) {
      void loadContainerOwners();
      return;
    }
    const request = ++requestRef.current;
    onCacheChange({ ...current, loading: true, error: null });
    try {
      const items = await api.listPorts(connection.id);
      if (request !== requestRef.current) return;
      onCacheChange({ items, fetchedAt: Date.now(), loading: false, error: null });
      setSelectedId((selected) => reconcileSelection(items, selected));
      void loadContainerOwners();
    } catch (caught) {
      if (request !== requestRef.current) return;
      onCacheChange({ ...cacheRef.current, loading: false, error: errorMessage(caught) });
    }
  }

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
      ownerRequestRef.current += 1;
    };
  }, [connection.id]);

  useEffect(() => {
    setSelectedId((selected) => reconcileSelection(cache.items, selected));
  }, [cache.items]);

  const filtered = useMemo(
    () => filterAndSortSockets(cache.items, containersCache.items, search, protocol, sort),
    [cache.items, containersCache.items, protocol, search, sort],
  );
  const selected = cache.items.find((socket) => socket.id === selectedId) ?? null;
  const containerOwner = selected ? resolveSocketContainer(selected, containersCache.items) : null;
  const collectedAt = cache.fetchedAt
    ? new Date(cache.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  if (cache.loading && !cache.items.length)
    return <LoadingState label="Reading listening ports…" />;
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
            onClick={() => load(true)}
            aria-label="Refresh listening ports"
            disabled={cache.loading}
          >
            <RefreshCw size={16} className={cache.loading ? "spinning" : ""} />
          </button>
        </header>
        {cache.error && (
          <p className="inline-warning">Showing saved results. Refresh failed: {cache.error}</p>
        )}
        <div className="port-list-controls">
          <label className="search-field">
            <Search size={15} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search ports, owners, services, or containers"
            />
          </label>
          <select
            aria-label="Port protocol"
            value={protocol}
            onChange={(event) => setProtocol(event.target.value)}
          >
            <option value="all">TCP + UDP</option>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
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
        <div className="dense-list">
          {filtered.map((socket) => {
            const container = resolveSocketContainer(socket, containersCache.items);
            const owner = container?.container.name ?? socket.systemdUnit ?? socket.processName;
            return (
              <button
                className={socket.id === selectedId ? "dense-row selected-row" : "dense-row"}
                type="button"
                key={socket.id}
                onClick={() => setSelectedId(socket.id)}
              >
                <span className={`protocol-mark protocol-${socket.protocol}`}>
                  {socket.protocol.toUpperCase()}
                </span>
                <span className="row-main">
                  <strong>{socket.port}</strong>
                  <small>
                    {socket.localAddress} · {socketScope(socket)}
                  </small>
                </span>
                <span className="row-state port-owner-label">
                  {owner ??
                    (socket.ownership === "ambiguous" ? "Ambiguous owner" : "Owner unavailable")}
                </span>
              </button>
            );
          })}
          {!filtered.length && (
            <EmptyState
              title={cache.items.length ? "No matching listeners" : "No listening ports found"}
            />
          )}
        </div>
      </div>
      <aside className="detail-panel">
        {selected ? (
          <>
            <header>
              <h2>
                {selected.port} / {selected.protocol.toUpperCase()}
              </h2>
              <p>{selected.localAddress}</p>
            </header>
            <h3 className="detail-section-heading">Socket facts</h3>
            <dl className="detail-list">
              <div>
                <dt>Protocol</dt>
                <dd>{selected.protocol.toUpperCase()}</dd>
              </div>
              <div>
                <dt>Address family</dt>
                <dd>{selected.addressFamily.toUpperCase()}</dd>
              </div>
              <div>
                <dt>Bind address</dt>
                <dd className="technical">{selected.localAddress}</dd>
              </div>
              <div>
                <dt>Scope</dt>
                <dd>{socketScope(selected)}</dd>
              </div>
            </dl>
            <h3 className="detail-section-heading">Ownership evidence</h3>
            <dl className="detail-list">
              <div>
                <dt>Process</dt>
                <dd>
                  {selected.processName ??
                    (selected.ownership === "ambiguous" ? "Ambiguous" : "Unavailable")}
                </dd>
              </div>
              <div>
                <dt>PID</dt>
                <dd>{selected.processId ?? "Unavailable"}</dd>
              </div>
              <div>
                <dt>Systemd unit</dt>
                <dd>{selected.systemdUnit ?? "Not established"}</dd>
              </div>
              <div>
                <dt>Container</dt>
                <dd>{containerOwner?.container.name ?? "Not established"}</dd>
              </div>
              {containerOwner?.composeProject && (
                <div>
                  <dt>Compose project</dt>
                  <dd>{containerOwner.composeProject}</dd>
                </div>
              )}
            </dl>
            <div className="detail-actions">
              {selected.systemdUnit && (
                <>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => onOpenSystemd(selected.systemdUnit!)}
                  >
                    <Server size={15} /> Open unit
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => onViewLogs({ type: "systemd", id: selected.systemdUnit! })}
                  >
                    <FileClock size={15} /> View journal
                  </button>
                </>
              )}
              {containerOwner && (
                <>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => onOpenContainer(containerOwner.container.id)}
                  >
                    <Boxes size={15} /> Open container
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => onViewLogs({ type: "docker", id: containerOwner.container.id })}
                  >
                    <FileClock size={15} /> View logs
                  </button>
                </>
              )}
            </div>
          </>
        ) : (
          <EmptyState title="Select a listening port" />
        )}
      </aside>
    </section>
  );
}
