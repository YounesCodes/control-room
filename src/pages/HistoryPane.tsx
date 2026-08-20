import { useEffect, useMemo, useState } from "react";
import {
  Clipboard,
  Eraser,
  Pause,
  Play,
  RefreshCw,
  Search,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import type { HistoryEntry, SavedConnection } from "../types";

export function HistoryPane({
  connection,
  paused,
  onPausedChange,
  onConnectionChanged,
  onPaste,
}: {
  connection: SavedConnection;
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  onConnectionChanged: (connection: SavedConnection) => void;
  onPaste: (command: string) => void;
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [integrationInstalled, setIntegrationInstalled] = useState(false);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [history, installed] = await Promise.all([
        api.history(connection.id, search),
        api.historyIntegrationStatus(connection.id),
      ]);
      setEntries(history);
      setIntegrationInstalled(installed);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), search ? 180 : 0);
    return () => window.clearTimeout(timer);
  }, [connection.id, search]);

  async function toggleIntegration() {
    setWorking(true);
    setError(null);
    try {
      if (integrationInstalled) await api.uninstallHistoryIntegration(connection.id);
      else await api.installHistoryIntegration(connection.id);
      const updated = { ...connection, historyEnabled: !integrationInstalled };
      setIntegrationInstalled(!integrationInstalled);
      onConnectionChanged(updated);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setWorking(false);
    }
  }

  async function remove(entry: HistoryEntry) {
    await api.deleteHistory(entry.id);
    setEntries((current) => current.filter((item) => item.id !== entry.id));
  }

  async function clear() {
    if (!window.confirm(`Clear all Enhanced History for ${connection.displayName}?`)) return;
    await api.clearHistory(connection.id);
    setEntries([]);
  }

  const grouped = useMemo(() => {
    const groups = new Map<string, HistoryEntry[]>();
    for (const entry of entries) {
      const label = new Date(entry.startedAt).toLocaleDateString(undefined, {
        dateStyle: "medium",
      });
      groups.set(label, [...(groups.get(label) ?? []), entry]);
    }
    return [...groups.entries()];
  }, [entries]);

  if (loading && !entries.length && connection.historyEnabled)
    return <LoadingState label="Reading Enhanced History…" />;

  return (
    <section className="feature-page history-page">
      <header className="page-heading compact-heading">
        <div>
          <p className="eyebrow">Bash integration</p>
          <h2>Enhanced History</h2>
          <p>{connection.historyEnabled ? "Enabled for this Saved Connection" : "Disabled"}</p>
        </div>
        <div className="toolbar-actions">
          <button
            className="toolbar-button"
            type="button"
            onClick={() => onPausedChange(!paused)}
            disabled={!connection.historyEnabled}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
            {paused ? "Resume" : "Pause"}
          </button>
          <button className="toolbar-button" type="button" onClick={load}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button
            className="toolbar-button danger-text"
            type="button"
            onClick={clear}
            disabled={!entries.length}
          >
            <Eraser size={14} /> Clear
          </button>
        </div>
      </header>
      {!integrationInstalled && (
        <section className="history-opt-in">
          <h3>Enable exact Bash command history</h3>
          <p>
            Control Room will install one script under <code>~/.local/share/control-room/</code> and
            one marked source block in <code>~/.bashrc</code>. It records commands, directories,
            times, and exit codes from integrated Control Room sessions. Command lines may contain
            secrets.
          </p>
          <button
            className="primary-button"
            type="button"
            onClick={toggleIntegration}
            disabled={working}
          >
            {working ? "Installing…" : "Enable Enhanced History"}
          </button>
        </section>
      )}
      {integrationInstalled && (
        <div className="history-tools">
          <label className="search-field">
            <Search size={15} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search commands"
            />
          </label>
          <button
            className="secondary-button"
            type="button"
            onClick={toggleIntegration}
            disabled={working}
          >
            {working ? "Removing…" : "Disable integration"}
          </button>
        </div>
      )}
      {paused && (
        <p className="inline-warning">
          History is paused for this Workspace. Commands will not be saved.
        </p>
      )}
      {error && <ErrorState message={error} />}
      {integrationInstalled && !error && !grouped.length && (
        <EmptyState title="No commands recorded yet">
          Run a command in a new integrated terminal session.
        </EmptyState>
      )}
      {grouped.map(([date, items]) => (
        <section className="history-group" key={date}>
          <h3>{date}</h3>
          {items.map((entry) => (
            <article className="history-row" key={entry.id}>
              <time>
                {new Date(entry.startedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </time>
              <span className={entry.exitCode === 0 ? "exit-success" : "exit-failure"}>
                {entry.exitCode ?? "–"}
              </span>
              <div>
                <code>{entry.command}</code>
                <small>{entry.cwd ?? "Directory unavailable"}</small>
              </div>
              <div className="row-actions">
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => navigator.clipboard.writeText(entry.command)}
                  aria-label="Copy command"
                >
                  <Clipboard size={15} />
                </button>
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => onPaste(entry.command)}
                  aria-label="Paste into terminal"
                >
                  <TerminalSquare size={15} />
                </button>
                <button
                  className="icon-button danger-text"
                  type="button"
                  onClick={() => remove(entry)}
                  aria-label="Delete history entry"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </article>
          ))}
        </section>
      ))}
    </section>
  );
}
