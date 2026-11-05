import { Search } from "../components/MagnifierIcon";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Clipboard,
  Eraser,
  Info,
  MoreHorizontal,
  Pause,
  Play,
  Power,
  RefreshCw,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import type { HistoryEntry, SavedConnection } from "../types";

type CaptureState =
  "recording" | "paused" | "connection-disabled" | "global-disabled" | "not-installed" | "unknown";

const CAPTURE_LABELS: Record<CaptureState, string> = {
  recording: "Recording",
  paused: "Paused in this workspace",
  "connection-disabled": "Disabled for this connection",
  "global-disabled": "Disabled globally",
  "not-installed": "Integration not installed",
  unknown: "Status unavailable",
};

const MORE_MENU_WIDTH = 240;
const MORE_MENU_HEIGHT = 132;
const COPY_FEEDBACK_MS = 1500;
const REMOVE_COLLAPSE_MS = 150;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function CommandText({ command, search }: { command: string; search: string }) {
  if (!search.trim()) return <>{command}</>;
  const parts = command.split(new RegExp(`(${escapeRegExp(search)})`, "gi"));
  return (
    <>{parts.map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : part))}</>
  );
}

function ExitStatus({ exitCode }: { exitCode: number | null }) {
  if (exitCode === 0) {
    return (
      <span
        className="exit-status exit-success"
        title="Command succeeded (exit code 0)"
        aria-label="Command succeeded"
      >
        <Check size={13} strokeWidth={3} aria-hidden="true" />
      </span>
    );
  }
  if (exitCode == null) {
    return (
      <span
        className="exit-status exit-unknown"
        title="Exit code unknown"
        aria-label="Exit code unknown"
      >
        –
      </span>
    );
  }
  return (
    <span
      className="exit-status exit-failure"
      title={`Command failed (exit code ${exitCode})`}
      aria-label={`Command failed, exit code ${exitCode}`}
    >
      {exitCode}
    </span>
  );
}

function HistoryEntryRow({
  entry,
  search,
  copied,
  removing,
  canPaste,
  onCopy,
  onPaste,
  onDelete,
}: {
  entry: HistoryEntry;
  search: string;
  copied: boolean;
  removing: boolean;
  canPaste: boolean;
  onCopy: (entry: HistoryEntry) => void;
  onPaste: (command: string) => void;
  onDelete: (entry: HistoryEntry) => void;
}) {
  const startedAt = new Date(entry.startedAt);
  return (
    <article className="history-row" data-removing={removing ? "" : undefined}>
      <div className="history-row-inner">
        <time title={startedAt.toLocaleString()}>
          {startedAt.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </time>
        <ExitStatus exitCode={entry.exitCode} />
        <div className="history-entry-main">
          <code className="history-command">
            <CommandText command={entry.command} search={search} />
          </code>
          <small className="history-cwd" title={entry.cwd ?? undefined}>
            {entry.cwd ?? "Directory unavailable"}
          </small>
        </div>
        <div className="row-actions">
          <button
            className={copied ? "icon-button copied" : "icon-button"}
            type="button"
            onClick={() => onCopy(entry)}
            aria-label={copied ? "Copied" : "Copy command"}
            title={copied ? "Copied" : "Copy command"}
          >
            {copied ? (
              <Check size={15} aria-hidden="true" />
            ) : (
              <Clipboard size={15} aria-hidden="true" />
            )}
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => onPaste(entry.command)}
            aria-label="Paste into terminal"
            title={canPaste ? "Paste into terminal" : "Reconnect the terminal before pasting"}
            disabled={!canPaste}
          >
            <TerminalSquare size={15} aria-hidden="true" />
          </button>
          <button
            className="icon-button danger-text"
            type="button"
            onClick={() => onDelete(entry)}
            aria-label="Delete history entry"
            title="Delete history entry"
          >
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
    </article>
  );
}

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
  const [removingIds, setRemovingIds] = useState<ReadonlySet<string>>(new Set());
  const [integrationInstalled, setIntegrationInstalled] = useState<boolean | null>(null);
  const [integrationError, setIntegrationError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [resultsEpoch, setResultsEpoch] = useState(0);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);
  const loadRequestRef = useRef(0);
  const integrationRequestRef = useRef(0);
  const copyTimerRef = useRef<number | null>(null);
  const moreMenuTriggerRef = useRef<HTMLButtonElement>(null);

  const mutationGeneration = useRef(0);
  useEffect(() => {
    setEntries([]);
    setRemovingIds(new Set());
    setWorking(false);
    setLoading(true);
    setHasLoaded(false);
    setError(null);
    setConfirmState(null);
    setCopiedId(null);
    setMenuOpen(false);
    setMenuPosition(null);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    return () => {
      mutationGeneration.current += 1;
    };
  }, [connection.id]);

  async function loadIntegration() {
    const request = ++integrationRequestRef.current;
    setIntegrationError(null);
    try {
      const installed = await api.historyIntegrationStatus(connection.id);
      if (request === integrationRequestRef.current) setIntegrationInstalled(installed);
    } catch (caught) {
      if (request === integrationRequestRef.current) setIntegrationError(errorMessage(caught));
    }
  }

  async function loadHistory() {
    const request = ++loadRequestRef.current;
    setLoading(true);
    setError(null);
    try {
      const history = await api.history(connection.id, search);
      if (request === loadRequestRef.current) {
        setEntries(history);
        setHasLoaded(true);
        setResultsEpoch((epoch) => epoch + 1);
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
    setIntegrationInstalled(null);
    void loadIntegration();
    return () => {
      integrationRequestRef.current += 1;
    };
  }, [connection.id]);

  useEffect(() => {
    if (!menuOpen) return;
    function dismissMenu(event: PointerEvent) {
      if (event.target instanceof Element && event.target.closest("[data-history-menu]")) {
        return;
      }
      setMenuOpen(false);
    }
    function dismissMenuWithKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("pointerdown", dismissMenu);
    document.addEventListener("keydown", dismissMenuWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismissMenu);
      document.removeEventListener("keydown", dismissMenuWithKeyboard);
    };
  }, [menuOpen]);

  const capture = useMemo<CaptureState | null>(() => {
    if (!globalEnabled) return "global-disabled";
    if (integrationInstalled === false) return "not-installed";
    if (integrationError) return "unknown";
    if (integrationInstalled === null) return null;
    if (!connection.historyEnabled) return "connection-disabled";
    if (paused) return "paused";
    return "recording";
  }, [globalEnabled, integrationInstalled, integrationError, connection.historyEnabled, paused]);

  const visibleEntries = useMemo(
    () => entries.filter((entry) => !removingIds.has(entry.id)),
    [entries, removingIds],
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, HistoryEntry[]>();
    for (const entry of visibleEntries) {
      const label = new Date(entry.startedAt).toLocaleDateString(undefined, {
        dateStyle: "medium",
      });
      groups.set(label, [...(groups.get(label) ?? []), entry]);
    }
    return [...groups.entries()];
  }, [visibleEntries]);

  function refresh() {
    void loadHistory();
    void loadIntegration();
  }

  function toggleMoreMenu() {
    if (menuOpen) {
      setMenuOpen(false);
      setMenuPosition(null);
      return;
    }
    const trigger = moreMenuTriggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setMenuPosition({
      top:
        rect.bottom + MORE_MENU_HEIGHT + 8 > window.innerHeight
          ? rect.top - MORE_MENU_HEIGHT - 4
          : rect.bottom + 4,
      left: Math.max(
        8,
        Math.min(rect.right - MORE_MENU_WIDTH, window.innerWidth - MORE_MENU_WIDTH - 8),
      ),
    });
    setMenuOpen(true);
  }

  async function installIntegration() {
    const generation = mutationGeneration.current;
    setWorking(true);
    setError(null);
    try {
      const updated = await api.installHistoryIntegration(connection.id);
      if (generation !== mutationGeneration.current) return;
      setIntegrationInstalled(true);
      onConnectionChanged(updated);
    } catch (caught) {
      if (generation === mutationGeneration.current) setError(errorMessage(caught));
    } finally {
      if (generation === mutationGeneration.current) setWorking(false);
    }
  }

  function removeIntegration() {
    setMenuOpen(false);
    setConfirmState({
      title: "Remove integration",
      message:
        "Remove the Control Room Bash integration from this remote account? Other Saved Connections using the same remote account will stop capturing commands.",
      confirmLabel: "Remove integration",
      onConfirm: () => void performRemoveIntegration(),
    });
  }

  async function performRemoveIntegration() {
    const generation = mutationGeneration.current;
    setWorking(true);
    setError(null);
    try {
      const updated = await api.uninstallHistoryIntegration(connection.id);
      if (generation !== mutationGeneration.current) return;
      setIntegrationInstalled(false);
      onConnectionChanged(updated);
    } catch (caught) {
      if (generation === mutationGeneration.current) setError(errorMessage(caught));
    } finally {
      if (generation === mutationGeneration.current) setWorking(false);
    }
  }

  async function toggleCapture() {
    const generation = mutationGeneration.current;
    setWorking(true);
    setError(null);
    try {
      const updated = await api.setConnectionHistoryEnabled(
        connection.id,
        !connection.historyEnabled,
      );
      if (generation !== mutationGeneration.current) return;
      onConnectionChanged(updated);
    } catch (caught) {
      if (generation === mutationGeneration.current) setError(errorMessage(caught));
    } finally {
      if (generation === mutationGeneration.current) setWorking(false);
    }
  }

  function copyEntry(entry: HistoryEntry) {
    navigator.clipboard
      .writeText(entry.command)
      .then(() => {
        setCopiedId(entry.id);
        if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = window.setTimeout(() => setCopiedId(null), COPY_FEEDBACK_MS);
      })
      .catch((caught) => setError(`Copy failed: ${errorMessage(caught)}`));
  }

  function remove(entry: HistoryEntry) {
    const generation = mutationGeneration.current;
    setError(null);
    void (async () => {
      try {
        await api.deleteHistory(entry.id);
        if (generation !== mutationGeneration.current) return;
        setRemovingIds((current) => new Set(current).add(entry.id));
        window.setTimeout(() => {
          if (generation !== mutationGeneration.current) return;
          setEntries((current) => current.filter((item) => item.id !== entry.id));
          setRemovingIds((current) => {
            const next = new Set(current);
            next.delete(entry.id);
            return next;
          });
        }, REMOVE_COLLAPSE_MS);
      } catch (caught) {
        if (generation === mutationGeneration.current) setError(errorMessage(caught));
      }
    })();
  }

  function clear() {
    setMenuOpen(false);
    setConfirmState({
      title: "Clear history",
      message: `Clear all Enhanced History for ${connection.displayName}? This cannot be undone.`,
      confirmLabel: "Clear history",
      onConfirm: () => void performClear(),
    });
  }

  async function performClear() {
    const generation = mutationGeneration.current;
    setError(null);
    try {
      await api.clearHistory(connection.id);
      if (generation === mutationGeneration.current) setEntries([]);
    } catch (caught) {
      if (generation === mutationGeneration.current) setError(errorMessage(caught));
    }
  }

  if (loading && !hasLoaded) return <LoadingState label="Reading Command History…" />;

  return (
    <section className="feature-page history-page">
      <header className="page-heading compact-heading">
        <div className="history-heading-copy">
          <h2>Command History</h2>
          {capture && (
            <p className="history-capture" data-state={capture} aria-live="polite">
              <span className="history-capture-dot" aria-hidden="true" />
              {CAPTURE_LABELS[capture]}
            </p>
          )}
        </div>
        <div className="toolbar-actions">
          <button
            className="toolbar-button"
            type="button"
            onClick={() => onPausedChange(!paused)}
            disabled={!globalEnabled || !connection.historyEnabled}
            title="Pause recording for this Workspace"
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
            {paused ? "Resume" : "Pause"}
          </button>
          <button className="toolbar-button" type="button" onClick={refresh} disabled={loading}>
            <RefreshCw size={14} className={loading ? "spinning" : undefined} /> Refresh
          </button>
          <div className="history-more" data-history-menu="">
            <button
              ref={moreMenuTriggerRef}
              className="icon-button"
              type="button"
              onClick={toggleMoreMenu}
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <MoreHorizontal size={16} />
            </button>
            {menuOpen && (
              <div
                className="history-menu"
                role="menu"
                style={menuPosition ?? undefined}
                data-app-popover=""
              >
                {integrationInstalled === true && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      void toggleCapture();
                    }}
                    disabled={working}
                  >
                    <Power size={14} />
                    {connection.historyEnabled
                      ? "Disable on this connection"
                      : "Enable on this connection"}
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="danger-text"
                  onClick={clear}
                  disabled={!entries.length}
                >
                  <Eraser size={14} /> Clear saved history
                </button>
                {integrationInstalled === true && (
                  <button
                    type="button"
                    role="menuitem"
                    className="danger-text"
                    onClick={removeIntegration}
                    disabled={working}
                  >
                    <Trash2 size={14} /> Remove from remote Bash
                  </button>
                )}
              </div>
            )}
          </div>
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
      <div className="history-search-row">
        <label className="search-field">
          <Search size={15} />
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search commands"
            aria-label="Search commands"
          />
          {search && (
            <button
              className="icon-button search-clear"
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              title="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </label>
      </div>
      {error && <ErrorState message={error} />}
      <div className="history-list" key={`${connection.id}-${resultsEpoch}`}>
        {search && hasLoaded && !loading && !error && !grouped.length && (
          <EmptyState title="No matching commands">
            <p>
              No saved command on {connection.displayName} matches “{search}”.
            </p>
          </EmptyState>
        )}
        {!search && integrationInstalled === true && !error && hasLoaded && !grouped.length && (
          <EmptyState title="No commands recorded yet">
            Reconnect this connection or open a new terminal, then run a command. Sessions opened
            before you enabled capture are not integrated.
          </EmptyState>
        )}
        {grouped.map(([date, items]) => (
          <section className="history-group" key={date}>
            <h3>{date}</h3>
            {items.map((entry) => (
              <HistoryEntryRow
                key={entry.id}
                entry={entry}
                search={search}
                copied={copiedId === entry.id}
                removing={removingIds.has(entry.id)}
                canPaste={canPaste}
                onCopy={copyEntry}
                onPaste={onPaste}
                onDelete={remove}
              />
            ))}
          </section>
        ))}
      </div>
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
