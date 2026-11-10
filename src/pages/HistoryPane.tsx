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
import { notifyHistoryChanged, onHistoryChanged } from "../lib/history-events";
import type { HistoryEntry, HistoryIntegrationStatus, SavedConnection } from "../types";

type CaptureState =
  | "recording"
  | "paused"
  | "connection-disabled"
  | "global-disabled"
  | "not-installed"
  | "update-available"
  | "unknown";

const CAPTURE_LABELS: Record<CaptureState, string> = {
  recording: "Recording",
  paused: "Paused in this workspace",
  "connection-disabled": "Disabled for this connection",
  "global-disabled": "Disabled globally",
  "not-installed": "Integration not installed",
  "update-available": "Integration update available",
  unknown: "Status unavailable",
};

const MORE_MENU_WIDTH = 240;
const MORE_MENU_HEIGHT = 132;
const COPY_FEEDBACK_MS = 1500;
const HISTORY_REFRESH_MS = 75;
// Matches --motion-med.
const REMOVE_COLLAPSE_MS = 160;

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
        role="img"
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
        role="img"
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
      role="img"
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
        <code className="history-command" tabIndex={0}>
          <CommandText command={entry.command} search={search} />
        </code>
        <small className="history-cwd" title={entry.cwd ?? undefined}>
          {entry.cwd ?? "Directory unavailable"}
        </small>
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
  macosHost = false,
  connection,
  paused,
  globalEnabled,
  onPausedChange,
  onConnectionChanged,
  onPaste,
  canPaste,
}: {
  macosHost?: boolean;
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
  const [integration, setIntegration] = useState<HistoryIntegrationStatus | null>(null);
  const [integrationError, setIntegrationError] = useState<string | null>(null);
  const [integrationLoading, setIntegrationLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [working, setWorking] = useState(false);
  const [actionError, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const error = actionError ?? readError;
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
  const historyReadPendingRef = useRef(false);
  const integrationRequestRef = useRef(0);
  const copyTimerRef = useRef<number | null>(null);
  const copyRequestRef = useRef(0);
  const moreMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const removalTimersRef = useRef(new Map<string, number>());

  const mutationGeneration = useRef(0);
  useEffect(() => {
    setEntries([]);
    setRemovingIds(new Set());
    setWorking(false);
    setLoading(true);
    setHasLoaded(false);
    setError(null);
    setReadError(null);
    setConfirmState(null);
    setCopiedId(null);
    setMenuOpen(false);
    setMenuPosition(null);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    return () => {
      mutationGeneration.current += 1;
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      for (const timer of removalTimersRef.current.values()) window.clearTimeout(timer);
      removalTimersRef.current.clear();
    };
  }, [connection.id]);

  async function loadIntegration() {
    const request = ++integrationRequestRef.current;
    setIntegrationLoading(true);
    setIntegrationError(null);
    try {
      const status = await api.historyIntegrationStatus(connection.id);
      if (request === integrationRequestRef.current) setIntegration(status);
    } catch (caught) {
      if (request === integrationRequestRef.current) setIntegrationError(errorMessage(caught));
    } finally {
      if (request === integrationRequestRef.current) setIntegrationLoading(false);
    }
  }

  async function loadHistory(background = false) {
    const request = ++loadRequestRef.current;
    historyReadPendingRef.current = true;
    if (!background) {
      setLoading(true);
      setError(null);
      setReadError(null);
    }
    try {
      const history = await api.history(connection.id, search);
      if (request === loadRequestRef.current) {
        setEntries(history);
        setHasLoaded(true);
        setReadError(null);
      }
    } catch (caught) {
      if (request === loadRequestRef.current) setReadError(errorMessage(caught));
    } finally {
      if (request === loadRequestRef.current) {
        historyReadPendingRef.current = false;
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    const searchTimer = window.setTimeout(() => void loadHistory(), search ? 180 : 0);
    let refreshTimer: number | undefined;
    const refreshSaved = () => {
      refreshTimer = undefined;
      // Let a confirmed deletion finish collapsing before replacing the list.
      if (removalTimersRef.current.size > 0) {
        refreshTimer = window.setTimeout(refreshSaved, REMOVE_COLLAPSE_MS);
      } else {
        void loadHistory(true);
      }
    };
    const unsubscribe = onHistoryChanged(connection.id, () => {
      refreshTimer ??= window.setTimeout(refreshSaved, HISTORY_REFRESH_MS);
    });
    return () => {
      window.clearTimeout(searchTimer);
      window.clearTimeout(refreshTimer);
      unsubscribe();
      loadRequestRef.current += 1;
      historyReadPendingRef.current = false;
    };
  }, [connection.id, search]);

  useEffect(() => {
    setIntegration(null);
    void loadIntegration();
    return () => {
      integrationRequestRef.current += 1;
    };
  }, [connection.id]);

  useEffect(() => {
    if (!menuOpen) return;
    moreMenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    function dismissMenu(event: PointerEvent) {
      if (event.target instanceof Element && event.target.closest("[data-history-menu]")) {
        return;
      }
      setMenuOpen(false);
    }
    function dismissMenuWithKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        moreMenuTriggerRef.current?.focus();
      }
    }
    function dismissOnViewportChange() {
      setMenuOpen(false);
    }
    document.addEventListener("pointerdown", dismissMenu);
    document.addEventListener("keydown", dismissMenuWithKeyboard);
    window.addEventListener("resize", dismissOnViewportChange);
    document.addEventListener("scroll", dismissOnViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", dismissMenu);
      document.removeEventListener("keydown", dismissMenuWithKeyboard);
      window.removeEventListener("resize", dismissOnViewportChange);
      document.removeEventListener("scroll", dismissOnViewportChange, true);
    };
  }, [menuOpen]);

  const capture = useMemo<CaptureState | null>(() => {
    if (!globalEnabled) return "global-disabled";
    if (integrationError) return "unknown";
    if (integration !== "installed") return integration;
    if (!connection.historyEnabled) return "connection-disabled";
    if (paused) return "paused";
    return "recording";
  }, [globalEnabled, integration, integrationError, connection.historyEnabled, paused]);
  const integrationInstalled = integration === "installed" || integration === "update-available";

  const grouped = useMemo(() => {
    const groups = new Map<string, HistoryEntry[]>();
    for (const entry of entries) {
      const label = new Date(entry.startedAt).toLocaleDateString(undefined, {
        dateStyle: "medium",
      });
      const group = groups.get(label);
      if (group) group.push(entry);
      else groups.set(label, [entry]);
    }
    return [...groups.entries()];
  }, [entries]);

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
      const updated = await api.installHistoryIntegration(
        connection.id,
        integration !== "update-available",
      );
      if (generation !== mutationGeneration.current) return;
      integrationRequestRef.current += 1;
      setIntegrationLoading(false);
      setIntegrationError(null);
      setIntegration("installed");
      onConnectionChanged(updated);
    } catch (caught) {
      if (generation === mutationGeneration.current) setError(errorMessage(caught));
    } finally {
      if (generation === mutationGeneration.current) setWorking(false);
    }
  }

  function removeIntegration() {
    setMenuOpen(false);
    moreMenuTriggerRef.current?.focus();
    setConfirmState({
      title: "Remove integration",
      message: `Remove the Control Room ${macosHost ? "Bash and zsh" : "Bash"} integration from this remote account? Other Saved Connections using the same remote account will stop capturing commands.`,
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
      integrationRequestRef.current += 1;
      setIntegrationLoading(false);
      setIntegrationError(null);
      setIntegration("not-installed");
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
    const generation = mutationGeneration.current;
    const request = ++copyRequestRef.current;
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    setCopiedId(null);
    navigator.clipboard
      .writeText(entry.command)
      .then(() => {
        if (generation !== mutationGeneration.current || request !== copyRequestRef.current) return;
        setCopiedId(entry.id);
        if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = window.setTimeout(() => setCopiedId(null), COPY_FEEDBACK_MS);
      })
      .catch((caught) => {
        if (generation === mutationGeneration.current && request === copyRequestRef.current)
          setError(`Copy failed: ${errorMessage(caught)}`);
      });
  }

  function invalidateHistoryRead() {
    if (!historyReadPendingRef.current) return false;
    loadRequestRef.current += 1;
    historyReadPendingRef.current = false;
    setLoading(false);
    return true;
  }

  function remove(entry: HistoryEntry) {
    const generation = mutationGeneration.current;
    setError(null);
    void (async () => {
      try {
        await api.deleteHistory(entry.id);
        if (generation !== mutationGeneration.current) return;
        if (invalidateHistoryRead()) notifyHistoryChanged(connection.id);
        setRemovingIds((current) => new Set(current).add(entry.id));
        const timer = window.setTimeout(() => {
          removalTimersRef.current.delete(entry.id);
          if (generation !== mutationGeneration.current) return;
          setEntries((current) => current.filter((item) => item.id !== entry.id));
          setRemovingIds((current) => {
            const next = new Set(current);
            next.delete(entry.id);
            return next;
          });
        }, REMOVE_COLLAPSE_MS);
        const previousTimer = removalTimersRef.current.get(entry.id);
        if (previousTimer !== undefined) window.clearTimeout(previousTimer);
        removalTimersRef.current.set(entry.id, timer);
      } catch (caught) {
        if (generation === mutationGeneration.current) setError(errorMessage(caught));
      }
    })();
  }

  function clear() {
    setMenuOpen(false);
    moreMenuTriggerRef.current?.focus();
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
      if (generation === mutationGeneration.current) {
        invalidateHistoryRead();
        setEntries([]);
        notifyHistoryChanged(connection.id);
      }
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
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            className="toolbar-button"
            type="button"
            onClick={refresh}
            disabled={loading || integrationLoading}
          >
            <RefreshCw
              size={14}
              className={loading || integrationLoading ? "spinning" : undefined}
            />{" "}
            Refresh
          </button>
          <div className="history-more" data-history-menu="">
            <button
              ref={moreMenuTriggerRef}
              className="icon-button"
              type="button"
              onClick={toggleMoreMenu}
              aria-label="More actions"
              title="More actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <MoreHorizontal size={16} />
            </button>
            {menuOpen && (
              <div
                ref={moreMenuRef}
                className="history-menu"
                role="menu"
                aria-label="History actions"
                onKeyDown={(event) => {
                  if (event.key === "Tab") {
                    event.preventDefault();
                    setMenuOpen(false);
                    if (event.shiftKey) moreMenuTriggerRef.current?.focus();
                    else searchInputRef.current?.focus();
                    return;
                  }
                  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const buttons = [
                    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      "button:not(:disabled)",
                    ),
                  ];
                  if (!buttons.length) return;
                  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? buttons.length - 1
                        : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                          buttons.length;
                  buttons[next]?.focus();
                }}
                style={menuPosition ?? undefined}
                data-app-popover=""
              >
                {integrationInstalled && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      moreMenuTriggerRef.current?.focus();
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
                {integrationInstalled && (
                  <button
                    type="button"
                    role="menuitem"
                    className="danger-text"
                    onClick={removeIntegration}
                    disabled={working}
                  >
                    <Trash2 size={14} /> Remove from remote {macosHost ? "shells" : "Bash"}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </header>
      {integrationError && (
        <p className="inline-warning">
          Saved history is stored locally, but Control Room could not check the remote shell
          integration: {integrationError}
        </p>
      )}
      {integration === "update-available" && !integrationError && (
        <section className="history-opt-in">
          <p>Reconnect after updating to load the new integration.</p>
          <button
            className="primary-button"
            type="button"
            onClick={installIntegration}
            disabled={working}
          >
            {working ? "Updating…" : `Update ${macosHost ? "shell" : "Bash"} integration`}
          </button>
        </section>
      )}
      {integration === "not-installed" && !integrationError && (
        <section className="history-opt-in">
          <h3>Enable exact {macosHost ? "Bash and zsh" : "Bash"} command history</h3>
          <p>
            Control Room will install {macosHost ? "scripts" : "one script"} under{" "}
            <code>~/.local/share/control-room/</code> and marked source blocks in{" "}
            <code>~/.bashrc</code>
            {macosHost ? (
              <>
                {" "}
                and <code>~/.zshrc</code>
              </>
            ) : null}
            . It records commands, directories, times, and exit codes from integrated Control Room
            sessions. Command lines may contain secrets.
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
            ref={searchInputRef}
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
      {error && (
        <div role="alert">
          <ErrorState message={error} />
        </div>
      )}
      <div className="history-list" data-loading={loading ? "" : undefined}>
        {search && hasLoaded && !loading && !error && !grouped.length && (
          <EmptyState title="No matching commands">
            <p>
              No saved command on {connection.displayName} matches “{search}”.
            </p>
          </EmptyState>
        )}
        {!search && integrationError && !error && hasLoaded && !grouped.length && (
          <EmptyState title="No saved commands">
            No commands are saved locally for {connection.displayName}.
          </EmptyState>
        )}
        {!search &&
          integration === "installed" &&
          !integrationError &&
          !error &&
          hasLoaded &&
          !grouped.length && (
            <EmptyState title="No commands recorded yet">
              {!globalEnabled
                ? "Enable Enhanced History globally in Settings to record new commands."
                : !connection.historyEnabled
                  ? "Enable on this connection from More actions to record new commands."
                  : paused
                    ? "Resume recording in this workspace to record new commands."
                    : "Reconnect this connection or open a new terminal, then run a command. Sessions opened before you enabled capture are not integrated."}
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
