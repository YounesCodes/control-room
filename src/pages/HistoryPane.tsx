import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Clipboard,
  Eraser,
  Info,
  Pause,
  Play,
  RefreshCw,
  Search,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import type { HistoryEntry, SavedConnection } from "../types";

export function HistoryPane({
  connection,
  paused,
  globalEnabled,
  onPausedChange,
  onConnectionChanged,
  onPaste,
  canPaste,
}: {
  connection: SavedConnection;
  paused: boolean;
  globalEnabled: boolean;
  onPausedChange: (paused: boolean) => void;
  onConnectionChanged: (connection: SavedConnection) => void;
  onPaste: (command: string) => void;
  canPaste: boolean;
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [integrationInstalled, setIntegrationInstalled] = useState<boolean | null>(null);
  const [integrationError, setIntegrationError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);
  const loadRequestRef = useRef(0);

  async function loadHistory() {
    const request = ++loadRequestRef.current;
    setLoading(true);
    setError(null);
    try {
      const history = await api.history(connection.id, search);
      if (request === loadRequestRef.current) {
        setEntries(history);
      }
    } catch (caught) {
      if (request === loadRequestRef.current) setError(errorMessage(caught));
    } finally {
      if (request === loadRequestRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void loadHistory(), search ? 180 : 0);
    return () => {
      window.clearTimeout(timer);
      loadRequestRef.current += 1;
    };
  }, [connection.id, search]);

  useEffect(() => {
    let current = true;
    setIntegrationInstalled(null);
    setIntegrationError(null);
    void api
      .historyIntegrationStatus(connection.id)
      .then((installed) => {
        if (current) setIntegrationInstalled(installed);
      })
      .catch((caught) => {
        if (current) setIntegrationError(errorMessage(caught));
      });
    return () => {
      current = false;
    };
  }, [connection.id]);

  function refresh() {
    void loadHistory();
    setIntegrationError(null);
    void api
      .historyIntegrationStatus(connection.id)
      .then(setIntegrationInstalled)
      .catch((caught) => setIntegrationError(errorMessage(caught)));
  }

  async function installIntegration() {
    setWorking(true);
    setError(null);
    try {
      const updated = await api.installHistoryIntegration(connection.id);
      setIntegrationInstalled(true);
      onConnectionChanged(updated);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setWorking(false);
    }
  }

  function removeIntegration() {
    setConfirmState({
      title: "Remove integration",
      message:
        "Remove the Control Room Bash integration from this remote account? Other Saved Connections using the same remote account will stop capturing commands.",
      confirmLabel: "Remove integration",
      onConfirm: () => void performRemoveIntegration(),
    });
  }

  async function performRemoveIntegration() {
    setWorking(true);
    setError(null);
    try {
      const updated = await api.uninstallHistoryIntegration(connection.id);
      setIntegrationInstalled(false);
      onConnectionChanged(updated);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setWorking(false);
    }
  }

  async function toggleCapture() {
    setWorking(true);
    setError(null);
    try {
      const updated = await api.setConnectionHistoryEnabled(
        connection.id,
        !connection.historyEnabled,
      );
      onConnectionChanged(updated);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setWorking(false);
    }
  }

  async function remove(entry: HistoryEntry) {
    setError(null);
    try {
      await api.deleteHistory(entry.id);
      setEntries((current) => current.filter((item) => item.id !== entry.id));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  function clear() {
    setConfirmState({
      title: "Clear history",
      message: `Clear all Enhanced History for ${connection.displayName}? This cannot be undone.`,
      confirmLabel: "Clear history",
      onConfirm: () => void performClear(),
    });
  }

  async function performClear() {
    setError(null);
    try {
      await api.clearHistory(connection.id);
      setEntries([]);
    } catch (caught) {
      setError(errorMessage(caught));
    }
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

  if (loading && !entries.length) return <LoadingState label="Reading Enhanced History…" />;

  return (
    <section className="feature-page history-page">
      <header className="page-heading compact-heading">
        <div>
          <h2>Enhanced History</h2>
          <p>{connection.historyEnabled ? "Enabled for this Saved Connection" : "Disabled"}</p>
        </div>
        <div className="toolbar-actions">
          <button
            className="toolbar-button"
            type="button"
            onClick={() => onPausedChange(!paused)}
            disabled={!globalEnabled || !connection.historyEnabled}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
            {paused ? "Resume" : "Pause"}
          </button>
          <button className="toolbar-button" type="button" onClick={refresh} disabled={loading}>
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
      {integrationError && (
        <p className="inline-warning">
          Saved commands are available, but Control Room could not check the remote Bash
          integration: {integrationError}
        </p>
      )}
      {integrationInstalled === false && (
        <section className="history-opt-in">
          <h3>Enable exact Bash command history</h3>
          <p>
            Control Room will install one script under <code>~/.local/share/control-room/</code> and
            one marked source block in <code>~/.bashrc</code>. It records commands, directories,
            times, and exit codes from integrated Control Room sessions. Command lines may contain
            secrets.
          </p>
          <p className="history-opt-in-note">
            <Info size={15} aria-hidden="true" />
            <span>
              Capture starts in terminal sessions opened <strong>after</strong> you enable it.
              Reconnect this connection or open a new terminal — commands in an already-open session
              are not recorded.
            </span>
          </p>
          <button
            className="primary-button"
            type="button"
            onClick={installIntegration}
            disabled={working}
          >
            {working ? "Installing…" : "Enable Enhanced History"}
          </button>
        </section>
      )}
      <div className="history-tools">
        <label className="search-field">
          <Search size={15} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search commands"
          />
        </label>
        {integrationInstalled === true && (
          <div className="history-tools-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={toggleCapture}
              disabled={working}
            >
              {working
                ? "Saving…"
                : connection.historyEnabled
                  ? "Disable capture"
                  : "Enable capture"}
            </button>
            <button
              className="danger-button"
              type="button"
              onClick={removeIntegration}
              disabled={working}
            >
              Remove integration
            </button>
          </div>
        )}
      </div>
      {!globalEnabled && (
        <p className="inline-warning">
          Enhanced History is disabled globally. Existing entries remain available.
        </p>
      )}
      {integrationInstalled === true && !connection.historyEnabled && (
        <p className="inline-warning">
          Capture is disabled for this Saved Connection. Existing entries remain available.
        </p>
      )}
      {paused && globalEnabled && connection.historyEnabled && (
        <p className="inline-warning">
          History is paused for this Workspace. Commands will not be saved.
        </p>
      )}
      {error && <ErrorState message={error} />}
      {integrationInstalled === true && !error && !grouped.length && (
        <EmptyState title="No commands recorded yet">
          Reconnect this connection or open a new terminal, then run a command. Sessions opened
          before you enabled capture are not integrated.
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
              {entry.exitCode === 0 ? (
                <span
                  className="exit-code exit-success"
                  title="Command succeeded (exit code 0)"
                  aria-label="Command succeeded"
                >
                  <Check size={13} strokeWidth={3} aria-hidden="true" />
                </span>
              ) : entry.exitCode == null ? (
                <span
                  className="exit-code"
                  title="Exit code unknown"
                  aria-label="Exit code unknown"
                >
                  –
                </span>
              ) : (
                <span
                  className="exit-code exit-failure"
                  title={`Command failed (exit code ${entry.exitCode})`}
                  aria-label={`Command failed, exit code ${entry.exitCode}`}
                >
                  {entry.exitCode}
                </span>
              )}
              <div>
                <code>{entry.command}</code>
                <small>{entry.cwd ?? "Directory unavailable"}</small>
              </div>
              <div className="row-actions">
                <button
                  className="icon-button"
                  type="button"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(entry.command)
                      .catch((caught) => setError(`Copy failed: ${errorMessage(caught)}`))
                  }
                  aria-label="Copy command"
                >
                  <Clipboard size={15} />
                </button>
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => onPaste(entry.command)}
                  aria-label="Paste into terminal"
                  title={canPaste ? "Paste into terminal" : "Reconnect the terminal before pasting"}
                  disabled={!canPaste}
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
      {confirmState && (
        <ConfirmDialog
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          danger
          onConfirm={() => {
            const run = confirmState.onConfirm;
            setConfirmState(null);
            run();
          }}
          onClose={() => setConfirmState(null)}
        />
      )}
    </section>
  );
}
