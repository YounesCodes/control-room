import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import { ResizableSplit } from "../components/ResizablePanels";
import type { SavedConnection, WindowsService } from "../types";

export function WindowsServicesPane({ connection }: { connection: SavedConnection }) {
  const [services, setServices] = useState<WindowsService[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [state, setState] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    void api
      .listWindowsServices(connection.id)
      .then((result) => {
        if (!current) return;
        setServices(result);
        setSelectedId((id) =>
          result.some((service) => service.id === id) ? id : (result[0]?.id ?? null),
        );
        setLoading(false);
      })
      .catch((caught) => {
        if (current) {
          setError(errorMessage(caught));
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [connection.id, attempt]);
  const filtered = useMemo(
    () =>
      services.filter(
        (service) =>
          (state === "all" || service.state === state) &&
          `${service.id} ${service.displayName} ${service.description ?? ""}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [services, search, state],
  );
  const selected = services.find((service) => service.id === selectedId);
  const clearFilters = () => {
    setSearch("");
    setState("all");
  };
  if (loading && !services.length) return <LoadingState label="Reading Windows services..." />;
  if (error && !services.length)
    return (
      <ErrorState
        message={error}
        action={<button onClick={() => setAttempt((value) => value + 1)}>Retry</button>}
      />
    );
  return (
    <ResizableSplit name="Services" className="feature-page split-page windows-services-page">
      <div className="list-panel">
        <header className="page-heading">
          <div>
            <h2>Services</h2>
            <p>
              {services.filter((service) => service.state === "running").length} running /{" "}
              {services.length} total
            </p>
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={loading}
            onClick={() => setAttempt((value) => value + 1)}
          >
            <RefreshCw size={15} className={loading ? "spinning" : ""} /> Refresh
          </button>
        </header>
        {error && (
          <p className="inline-warning">Showing previous services. Refresh failed: {error}</p>
        )}
        <div className="systemd-list-controls windows-service-list-controls">
          <label className="search-field">
            <Search size={15} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search Windows services"
              aria-label="Search Windows services"
            />
          </label>
          <select
            aria-label="Filter service state"
            value={state}
            onChange={(event) => setState(event.target.value)}
          >
            <option value="all">All states</option>
            <option value="running">Running</option>
            <option value="stopped">Stopped</option>
            <option value="paused">Paused</option>
          </select>
        </div>
        <div className="dense-list">
          {filtered.map((service) => (
            <button
              type="button"
              key={service.id}
              className={`dense-row${selectedId === service.id ? " selected-row" : ""}`}
              onClick={() => setSelectedId(service.id)}
            >
              <span
                className={`service-indicator service-${service.state === "running" ? "active" : "inactive"}`}
                aria-hidden="true"
              />
              <span className="row-main">
                <strong>{service.displayName}</strong>
                <small>{service.id}</small>
              </span>
              <span className="row-state">{service.state}</span>
            </button>
          ))}
          {!filtered.length && (
            <EmptyState title={services.length ? "No matching services" : "No services found"} />
          )}
        </div>
      </div>
      <aside className="detail-panel" tabIndex={0} aria-label="Windows service details">
        {selected && filtered.some((service) => service.id === selected.id) ? (
          <>
            <header>
              <h2>{selected.displayName}</h2>
              <p>{selected.description || selected.id}</p>
            </header>
            <dl className="detail-list">
              <div>
                <dt>Service name</dt>
                <dd>{selected.id}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{selected.state}</dd>
              </div>
              <div>
                <dt>Startup</dt>
                <dd>{selected.startMode}</dd>
              </div>
              <div>
                <dt>Process ID</dt>
                <dd>{selected.processId ?? "Not running"}</dd>
              </div>
            </dl>
            <p className="unit-scope-note">Read-only Windows service inventory.</p>
          </>
        ) : (
          <EmptyState
            title={selected ? "Selected service is outside this filter" : "Select a service"}
          >
            <button className="secondary-button" type="button" onClick={clearFilters}>
              Clear filters
            </button>
          </EmptyState>
        )}
      </aside>
    </ResizableSplit>
  );
}
