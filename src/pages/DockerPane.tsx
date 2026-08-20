import { useEffect, useMemo, useState } from "react";
import { FileClock, RefreshCw, Search } from "lucide-react";
import { CredentialDialog } from "../components/CredentialDialog";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import type { DockerContainer, SavedConnection } from "../types";

export function DockerPane({
  connection,
  onViewLogs,
}: {
  connection: SavedConnection;
  onViewLogs: () => void;
}) {
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requestSudo, setRequestSudo] = useState(false);

  async function load(password: string | null = null) {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listContainers(connection.id, password);
      setContainers(result);
      setSelectedId((current) => current ?? result[0]?.id ?? null);
      setRequestSudo(false);
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
    if (!query) return containers;
    return containers.filter(
      (container) =>
        container.name.toLowerCase().includes(query) ||
        container.image.toLowerCase().includes(query),
    );
  }, [containers, search]);
  const selected = containers.find((container) => container.id === selectedId) ?? null;
  const permissionError = error?.toLowerCase().includes("permission denied");

  if (loading && !containers.length) return <LoadingState label="Reading Docker containers…" />;
  if (error && !containers.length) {
    return (
      <>
        <ErrorState
          message={error}
          action={
            permissionError ? (
              <button onClick={() => setRequestSudo(true)}>Retry with sudo</button>
            ) : (
              <button onClick={() => load()}>Retry</button>
            )
          }
        />
        {requestSudo && (
          <CredentialDialog
            connectionLabel={connection.displayName}
            onClose={() => setRequestSudo(false)}
            onSubmit={(password) => load(password)}
          />
        )}
      </>
    );
  }

  return (
    <section className="feature-page split-page">
      <div className="list-panel">
        <header className="page-heading compact-heading">
          <div>
            <p className="eyebrow">Docker</p>
            <h2>Containers</h2>
            <p>
              {containers.filter((container) => container.state === "running").length} running ·{" "}
              {containers.length} total
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={() => load()}
            aria-label="Refresh containers"
          >
            <RefreshCw size={16} />
          </button>
        </header>
        <label className="search-field">
          <Search size={15} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search containers"
          />
        </label>
        <div className="dense-list">
          {filtered.map((container) => (
            <button
              className={container.id === selectedId ? "dense-row selected-row" : "dense-row"}
              type="button"
              key={container.id}
              onClick={() => setSelectedId(container.id)}
            >
              <span className={`service-indicator service-${container.state}`} />
              <span className="row-main">
                <strong>{container.name}</strong>
                <small>{container.image}</small>
              </span>
              <span className="row-state">{container.state}</span>
            </button>
          ))}
          {!filtered.length && (
            <EmptyState title="No containers found">Docker is available.</EmptyState>
          )}
        </div>
      </div>
      <aside className="detail-panel">
        {selected ? (
          <>
            <header>
              <p className="eyebrow">Container detail</p>
              <h2>{selected.name}</h2>
              <p>{selected.image}</p>
            </header>
            <dl className="detail-list">
              <div>
                <dt>Container ID</dt>
                <dd className="technical">{selected.id.slice(0, 16)}</dd>
              </div>
              <div>
                <dt>State</dt>
                <dd>{selected.state}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{selected.status}</dd>
              </div>
              <div>
                <dt>Ports</dt>
                <dd className="technical">{selected.ports || "None published"}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{selected.createdAt}</dd>
              </div>
            </dl>
            <button className="secondary-button" type="button" onClick={onViewLogs}>
              <FileClock size={15} /> View logs
            </button>
            <p className="read-only-note">
              Control Room inspects containers but never changes them.
            </p>
          </>
        ) : (
          <EmptyState title="Select a container" />
        )}
      </aside>
    </section>
  );
}
