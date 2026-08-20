import { useEffect, useMemo, useState } from "react";
import { FileClock, RefreshCw, Search } from "lucide-react";
import { ErrorState, EmptyState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import type { SavedConnection, SystemdService } from "../types";

export function ServicesPane({
  connection,
  onViewLogs,
}: {
  connection: SavedConnection;
  onViewLogs: () => void;
}) {
  const [services, setServices] = useState<SystemdService[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listServices(connection.id);
      setServices(result);
      setSelectedId((current) => current ?? result[0]?.id ?? null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [connection.id]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return services;
    return services.filter(
      (service) =>
        service.id.toLowerCase().includes(query) ||
        service.description.toLowerCase().includes(query),
    );
  }, [search, services]);
  const selected = services.find((service) => service.id === selectedId) ?? null;

  if (loading && !services.length) return <LoadingState label="Reading systemd services…" />;
  if (error && !services.length) {
    return <ErrorState message={error} action={<button onClick={load}>Retry</button>} />;
  }

  return (
    <section className="feature-page split-page">
      <div className="list-panel">
        <header className="page-heading compact-heading">
          <div>
            <p className="eyebrow">systemd</p>
            <h2>Services</h2>
            <p>{services.length} units</p>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={load}
            aria-label="Refresh services"
          >
            <RefreshCw size={16} />
          </button>
        </header>
        <label className="search-field">
          <Search size={15} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search services"
          />
        </label>
        <div className="dense-list">
          {filtered.map((service) => (
            <button
              className={service.id === selectedId ? "dense-row selected-row" : "dense-row"}
              type="button"
              key={service.id}
              onClick={() => setSelectedId(service.id)}
            >
              <span className={`service-indicator service-${service.activeState}`} />
              <span className="row-main">
                <strong>{service.id}</strong>
                <small>{service.description || "No description"}</small>
              </span>
              <span className="row-state">{service.subState}</span>
            </button>
          ))}
          {!filtered.length && <EmptyState title="No matching services" />}
        </div>
      </div>
      <aside className="detail-panel">
        {selected ? (
          <>
            <header>
              <p className="eyebrow">Service detail</p>
              <h2>{selected.id}</h2>
              <p>{selected.description || "No description"}</p>
            </header>
            <dl className="detail-list">
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
            <button className="secondary-button" type="button" onClick={onViewLogs}>
              <FileClock size={15} /> View logs
            </button>
            <p className="read-only-note">Control Room inspects services but never changes them.</p>
          </>
        ) : (
          <EmptyState title="Select a service" />
        )}
      </aside>
    </section>
  );
}
