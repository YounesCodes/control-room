import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import {
  ChevronDown,
  ChevronUp,
  Clipboard,
  Copy,
  Eraser,
  Power,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { isControlRoomConnectedOsc, parseHistoryOsc } from "../lib/history-osc";
import {
  BoundedByteQueue,
  isControlRoomShortcut,
  terminalRightClickAction,
} from "../lib/terminal-flow";
import { buildTerminalTheme } from "../lib/terminal-theme";
import { isRemoteWorkspace, terminalStateLabel } from "../lib/workspace-target";
import type { AppSettings, ConnectionState, SessionStateEvent, Workspace } from "../types";
import { StatusDot } from "./StatusDot";

interface TerminalPaneProps {
  workspace: Workspace;
  settings: AppSettings;
  visible: boolean;
  active: boolean;
  onActivate: () => void;
  onSession: (sessionId: string | null) => void;
  onState: (state: ConnectionState, reason: string | null) => void;
  onReconnect: () => void;
  onDisconnect?: () => void;
  onActivity?: (kind: "output" | "bell") => void;
  findRequest?: number;
}

interface PendingHistory {
  command: string;
  cwd: string | null;
  startedAt: string;
}

const MAX_EARLY_SESSION_EVENTS = 16;

/// One xterm host and one session lifecycle for both kinds of Terminal Session.
/// A Workspace never changes kind, so the remote-only part (the shell
/// integration handler that feeds Enhanced History) is decided when the
/// terminal is built, and a local shell never reaches it.
export function TerminalPane({
  workspace,
  settings,
  visible,
  active,
  onActivate,
  onSession,
  onState,
  onReconnect,
  onDisconnect = () => undefined,
  onActivity = () => undefined,
  findRequest = 0,
}: TerminalPaneProps) {
  const remote = isRemoteWorkspace(workspace) ? workspace : null;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const terminalThemeRef = useRef<ReturnType<typeof buildTerminalTheme> | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  const sessionGenerationRef = useRef(0);
  const pendingInputRef = useRef(new BoundedByteQueue());
  const acceptingInputRef = useRef(false);
  const pendingHistoryRef = useRef<PendingHistory | null>(null);
  const earlySessionEventsRef = useRef(new Map<string, SessionStateEvent>());
  const historyPausedRef = useRef(remote?.historyPaused ?? false);
  const globalHistoryEnabledRef = useRef(settings.globalHistoryEnabled);
  const visibleRef = useRef(visible);
  const activeRef = useRef(active);
  const connectionIdRef = useRef(remote?.connectionId ?? null);
  const workspaceReasonRef = useRef(workspace.reason);
  const onSessionRef = useRef(onSession);
  const onStateRef = useRef(onState);
  const onActivityRef = useRef(onActivity);
  const handleSessionStateRef = useRef<(event: SessionStateEvent) => void>(() => undefined);
  const sendInputRef = useRef<(bytes: Uint8Array) => void>(() => undefined);
  const [localError, setLocalError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResult, setSearchResult] = useState({ index: -1, count: 0 });
  const [hasSelection, setHasSelection] = useState(false);

  historyPausedRef.current = remote?.historyPaused ?? false;
  globalHistoryEnabledRef.current = settings.globalHistoryEnabled;
  visibleRef.current = visible;
  activeRef.current = active;
  connectionIdRef.current = remote?.connectionId ?? null;
  workspaceReasonRef.current = workspace.reason;
  onSessionRef.current = onSession;
  onStateRef.current = onState;
  onActivityRef.current = onActivity;

  handleSessionStateRef.current = (event) => {
    onStateRef.current(event.state, event.reason);
    if (event.state !== "disconnected" && event.state !== "error") return;
    acceptingInputRef.current = false;
    pendingInputRef.current.clear();
    sessionIdRef.current = null;
    pendingHistoryRef.current = null;
    onSessionRef.current(null);
  };

  sendInputRef.current = (bytes) => {
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      void api.writeSession(sessionId, bytes).catch((error) => setLocalError(errorMessage(error)));
      return;
    }
    if (!acceptingInputRef.current) {
      if (workspace.kind === "local") {
        setLocalError("Restart the shell before sending terminal input.");
      } else if (!workspaceReasonRef.current) {
        setLocalError("Reconnect before sending terminal input.");
      }
      return;
    }
    if (!pendingInputRef.current.enqueue(bytes)) {
      setLocalError("Terminal input is paused while the session catches up.");
    }
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let resizeTimer: number | undefined;
    let bellTimer: number | undefined;
    const theme = buildTerminalTheme(settings);
    terminalThemeRef.current = theme;
    const terminal = new Terminal({
      // SearchAddon uses xterm's decoration API to highlight every match and
      // report the active result count. xterm guards that API behind this flag.
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      // Bold text (prompts, directory listings, error lines) is rendered with
      // weight, not a brighter hue, so a bold `01;34` directory shows the exact
      // "ANSI 4" color the user picked instead of a lightened
      // variant. This keeps the terminal matching the Settings color preview.
      drawBoldTextInBrightColors: false,
      fontFamily: settings.terminalFontFamily,
      fontSize: settings.terminalFontSize,
      // Search match markers render in this narrow rail, separate from the
      // terminal text so they never compete with ANSI colors.
      overviewRuler: { width: 8, showTopBorder: false, showBottomBorder: false },
      scrollback: settings.terminalScrollback,
      theme,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    terminal.open(container);
    fit.fit();
    terminalRef.current = terminal;
    fitRef.current = fit;
    searchRef.current = search;

    const selectionDisposable = terminal.onSelectionChange(() =>
      setHasSelection(terminal.hasSelection()),
    );
    const bellDisposable = terminal.onBell(() => {
      if (!activeRef.current) onActivityRef.current("bell");
      container.classList.add("visual-bell");
      window.clearTimeout(bellTimer);
      bellTimer = window.setTimeout(() => container.classList.remove("visual-bell"), 140);
    });
    const searchDisposable = search.onDidChangeResults(({ resultIndex, resultCount }) =>
      setSearchResult({ index: resultIndex, count: resultCount }),
    );

    const send = (bytes: Uint8Array) => sendInputRef.current(bytes);
    const pasteClipboard = () => {
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) terminal.paste(text);
        })
        .catch((error) => setLocalError(`Paste failed: ${errorMessage(error)}`));
    };
    const dataDisposable = terminal.onData((data) => send(new TextEncoder().encode(data)));
    const binaryDisposable = terminal.onBinary((data) =>
      send(Uint8Array.from(data, (character) => character.charCodeAt(0))),
    );
    terminal.attachCustomKeyEventHandler((event) => {
      if (isControlRoomShortcut(event)) return false;
      if (event.type !== "keydown" || !event.ctrlKey || !event.shiftKey) return true;
      if (event.key.toLowerCase() === "c" && terminal.hasSelection()) {
        void navigator.clipboard
          .writeText(terminal.getSelection())
          .catch((error) => setLocalError(`Copy failed: ${errorMessage(error)}`));
        return false;
      }
      // xterm owns keyboard paste through its textarea's native paste event.
      // Reading the clipboard here as well sends the same text twice: once
      // from this keydown handler and once when xterm emits the paste through
      // `onData`. Right-click paste still uses `pasteClipboard` below because
      // that pointer gesture never reaches xterm's textarea.
      return true;
    });

    /* A selection is copied rather than reported to the program running in the
       pty, so the click that copies it cannot also become a right click inside
       Vim or tmux. Stopping propagation in the capture phase is what keeps it
       from reaching xterm's own mousedown listener, which sits deeper in the
       tree. With no selection nothing is intercepted here, which is what leaves
       a mouse-reporting program its click. */
    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 2 || !terminal.hasSelection()) return;
      event.preventDefault();
      event.stopPropagation();
    };
    container.addEventListener("mousedown", handleMouseDown, { capture: true });

    /* Suppressing the webview menu is decided here, separately from who owns
       the clipboard. Every pointer right click inside the terminal prevents it,
       including the one handed to a mouse-reporting program: leaving the menu
       to appear whenever Control Room declined the gesture was the original
       bug. A context-menu key press arrives as the same event with no button
       behind it, reports "ignore", and is left alone so the keyboard route to
       the menu survives.

       By the time this fires, xterm has already seen the mousedown and sent any
       mouse report the program asked for. Preventing the default here removes
       the menu without taking the click away from the program. */
    const handleContextMenu = (event: MouseEvent) => {
      const action = terminalRightClickAction({
        button: event.button,
        hasSelection: terminal.hasSelection(),
        mouseTrackingMode: terminal.modes.mouseTrackingMode,
      });
      if (action === "ignore") return;

      event.preventDefault();
      if (action === "copy") {
        void navigator.clipboard
          .writeText(terminal.getSelection())
          .catch((error) => setLocalError(`Copy failed: ${errorMessage(error)}`));
        return;
      }
      if (action === "paste") pasteClipboard();
    };
    container.addEventListener("contextmenu", handleContextMenu);

    // Enhanced History is remote, Bash-only, and opt-in, so the shell
    // integration handler exists only for a Workspace with a Saved Connection
    // to record against. A local shell has no history capture at all.
    const oscDisposable = connectionIdRef.current
      ? terminal.parser.registerOscHandler(633, (data) => {
          if (!data.startsWith("ControlRoom;")) return false;
          if (isControlRoomConnectedOsc(data)) return true;
          try {
            const event = parseHistoryOsc(data);
            if (!event) {
              pendingHistoryRef.current = null;
              return true;
            }
            if (event.kind === "start") {
              pendingHistoryRef.current = {
                startedAt: event.startedAt,
                cwd: event.cwd,
                command: event.command,
              };
            } else {
              const pending = pendingHistoryRef.current;
              pendingHistoryRef.current = null;
              const sessionId = sessionIdRef.current;
              const connectionId = connectionIdRef.current;
              if (
                pending &&
                sessionId &&
                connectionId &&
                globalHistoryEnabledRef.current &&
                !historyPausedRef.current
              ) {
                void api
                  .addHistory({
                    connectionId,
                    sessionId,
                    command: pending.command,
                    cwd: event.cwd || pending.cwd,
                    startedAt: pending.startedAt,
                    finishedAt: event.finishedAt,
                    exitCode: event.exitCode,
                    shell: "bash",
                  })
                  .catch((error) =>
                    setLocalError(`History capture failed: ${errorMessage(error)}`),
                  );
              }
            }
          } catch (error) {
            pendingHistoryRef.current = null;
            setLocalError(`History capture failed: ${errorMessage(error)}`);
          }
          return true;
        })
      : null;

    let listenerDisposed = false;
    let unlisten: (() => void) | undefined;
    void listen<SessionStateEvent>("session-state-changed", ({ payload }) => {
      if (payload.sessionId === sessionIdRef.current) {
        handleSessionStateRef.current(payload);
        return;
      }
      if (!acceptingInputRef.current) return;
      const events = earlySessionEventsRef.current;
      events.set(payload.sessionId, payload);
      while (events.size > MAX_EARLY_SESSION_EVENTS) {
        const oldest = events.keys().next().value;
        if (oldest === undefined) break;
        events.delete(oldest);
      }
    })
      .then((dispose) => {
        if (listenerDisposed) dispose();
        else unlisten = dispose;
      })
      .catch((error) => {
        if (!listenerDisposed) {
          setLocalError(`Terminal event listener failed: ${errorMessage(error)}`);
        }
      });
    const observer = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (!visibleRef.current) return;
        fit.fit();
        const sessionId = sessionIdRef.current;
        if (sessionId) {
          void api
            .resizeSession(sessionId, terminal.cols, terminal.rows)
            .catch((error) => setLocalError(errorMessage(error)));
        }
      }, 60);
    });
    observer.observe(container);

    return () => {
      listenerDisposed = true;
      unlisten?.();
      observer.disconnect();
      container.removeEventListener("mousedown", handleMouseDown, { capture: true });
      container.removeEventListener("contextmenu", handleContextMenu);
      window.clearTimeout(resizeTimer);
      window.clearTimeout(bellTimer);
      dataDisposable.dispose();
      binaryDisposable.dispose();
      selectionDisposable.dispose();
      bellDisposable.dispose();
      searchDisposable.dispose();
      oscDisposable?.dispose();
      search.dispose();
      terminal.dispose();
      terminalRef.current = null;
      terminalThemeRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    const theme = terminalThemeRef.current;
    if (!terminal || !theme) return;

    // SearchAddon selects the active match internally. Make that selection
    // transparent while searching so it does not recolor ANSI output; the
    // match's outline and overview-ruler marker carry the search state instead.
    terminal.options.theme =
      searchOpen && searchTerm ? { ...theme, selectionBackground: "transparent" } : theme;
  }, [searchOpen, searchTerm]);

  // What this terminal is attached to: a Saved Connection or a local shell.
  const targetId = workspace.kind === "local" ? workspace.shell.id : workspace.connectionId;

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (!workspace.connectRequested) {
      acceptingInputRef.current = false;
      pendingInputRef.current.clear();
      sessionIdRef.current = null;
      onSessionRef.current(null);
      return;
    }
    const generation = ++sessionGenerationRef.current;
    let ownedSessionId: string | null = null;
    let acknowledgedBytes = 0;
    let acknowledgementTimer: number | undefined;
    let disposed = false;

    acceptingInputRef.current = true;
    pendingInputRef.current.clear();
    pendingHistoryRef.current = null;
    earlySessionEventsRef.current.clear();
    sessionIdRef.current = null;
    onSessionRef.current(null);
    onStateRef.current("connecting", null);
    setLocalError(null);
    terminal.reset();

    const flushAcknowledgements = () => {
      window.clearTimeout(acknowledgementTimer);
      acknowledgementTimer = undefined;
      if (!ownedSessionId || acknowledgedBytes === 0) return;
      const bytes = acknowledgedBytes;
      acknowledgedBytes = 0;
      void api.acknowledgeSessionOutput(ownedSessionId, bytes).catch((error) => {
        if (!disposed && generation === sessionGenerationRef.current) {
          setLocalError(`Terminal output acknowledgement failed: ${errorMessage(error)}`);
        }
      });
    };
    const acknowledge = (bytes: number) => {
      acknowledgedBytes += bytes;
      if (ownedSessionId && acknowledgementTimer === undefined) {
        acknowledgementTimer = window.setTimeout(flushAcknowledgements, 16);
      }
    };

    const output = new Channel<ArrayBuffer>();
    output.onmessage = (message) => {
      if (disposed || generation !== sessionGenerationRef.current) return;
      const bytes = new Uint8Array(message);
      if (!activeRef.current) onActivityRef.current("output");
      terminal.write(bytes, () => acknowledge(bytes.byteLength));
    };

    // A local session names a validated shell profile; a remote one names a
    // Saved Connection. Everything after the start call is the same.
    const started =
      workspace.kind === "local"
        ? api.startLocalSession(workspace.shell.id, terminal.cols, terminal.rows, output)
        : api.startSession(workspace.connectionId, terminal.cols, terminal.rows, output);

    void started
      .then(async ({ sessionId }) => {
        if (disposed || generation !== sessionGenerationRef.current) {
          await api.closeSession(sessionId).catch(() => undefined);
          return;
        }
        ownedSessionId = sessionId;
        sessionIdRef.current = sessionId;
        acceptingInputRef.current = false;
        onSessionRef.current(sessionId);
        if (acknowledgedBytes > 0) flushAcknowledgements();
        // A local shell is running the moment its process exists. An SSH
        // session waits for the connected marker instead, because a spawned
        // ssh has not authenticated yet.
        if (workspace.kind === "local") onStateRef.current("connected", null);

        const earlyEvent = earlySessionEventsRef.current.get(sessionId);
        earlySessionEventsRef.current.delete(sessionId);
        if (earlyEvent) {
          handleSessionStateRef.current(earlyEvent);
          if (earlyEvent.state === "disconnected" || earlyEvent.state === "error") return;
        }

        // Queued input goes out through the path a live keystroke takes, so
        // both are issued in the order they were typed. Awaiting each write
        // here left the queue draining across await points while the session
        // id was already published, so a keystroke landing mid-drain took the
        // direct path and was issued between two queued bytes. In a terminal
        // that is not a delay, it is different input.
        for (const bytes of pendingInputRef.current.drain()) {
          if (disposed || generation !== sessionGenerationRef.current) break;
          sendInputRef.current(bytes);
        }
      })
      .catch((error) => {
        if (disposed || generation !== sessionGenerationRef.current) return;
        acceptingInputRef.current = false;
        pendingInputRef.current.clear();
        const message = errorMessage(error);
        setLocalError(message);
        onStateRef.current("error", message);
      });

    return () => {
      disposed = true;
      sessionGenerationRef.current += 1;
      acceptingInputRef.current = false;
      pendingInputRef.current.clear();
      pendingHistoryRef.current = null;
      window.clearTimeout(acknowledgementTimer);
      if (sessionIdRef.current === ownedSessionId) {
        sessionIdRef.current = null;
        onSessionRef.current(null);
      }
      if (ownedSessionId) void api.closeSession(ownedSessionId).catch(() => undefined);
    };
  }, [targetId, workspace.connectRequested, workspace.reconnectToken]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontFamily = settings.terminalFontFamily;
    terminal.options.fontSize = settings.terminalFontSize;
    terminal.options.scrollback = settings.terminalScrollback;
    terminal.options.theme = buildTerminalTheme(settings);
    if (visible) fitRef.current?.fit();
    if (active) terminal.focus();
  }, [settings, visible, active]);

  useEffect(() => {
    if (findRequest <= 0) return;
    setSearchOpen(true);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }, [findRequest]);

  useEffect(() => {
    if (!searchOpen) return;
    const search = searchRef.current;
    if (!searchTerm) {
      search?.clearDecorations();
      setSearchResult({ index: -1, count: 0 });
      return;
    }
    find(true, true);
  }, [searchOpen, searchTerm]);

  function find(next: boolean, incremental = false) {
    const search = searchRef.current;
    if (!search || !searchTerm) {
      search?.clearDecorations();
      setSearchResult({ index: -1, count: 0 });
      return;
    }
    const options = {
      incremental,
      decorations: {
        // Keep the terminal's foreground and background colors untouched.
        // The subtle frame marks every result; the brighter frame marks the
        // active result, and both also appear in the overview ruler.
        matchBorder: "#92928e",
        matchOverviewRuler: "#92928e",
        activeMatchBorder: "#f2f2ee",
        activeMatchColorOverviewRuler: "#f2f2ee",
      },
    };
    if (next) search.findNext(searchTerm, options);
    else search.findPrevious(searchTerm, options);
  }

  function closeSearch() {
    searchRef.current?.clearDecorations();
    setSearchOpen(false);
    setSearchResult({ index: -1, count: 0 });
    terminalRef.current?.focus();
  }

  function copySelection() {
    const terminal = terminalRef.current;
    if (!terminal?.hasSelection()) return;
    void navigator.clipboard
      .writeText(terminal.getSelection())
      .catch((error) => setLocalError(`Copy failed: ${errorMessage(error)}`));
  }

  function pasteClipboard() {
    const terminal = terminalRef.current;
    if (!terminal) return;
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (text) terminal.paste(text);
      })
      .catch((error) => setLocalError(`Paste failed: ${errorMessage(error)}`));
  }

  // A local shell is started and stopped; a remote one is connected and
  // disconnected. Same lifecycle, different words for what it means.
  const local = workspace.kind === "local";
  const ended = workspace.state === "disconnected" || workspace.state === "error";

  return (
    <section
      className={`terminal-pane ${visible ? "terminal-visible" : "terminal-hidden"}`}
      onPointerDown={onActivate}
    >
      <header className="terminal-toolbar">
        <span className="toolbar-state" aria-live="polite" aria-atomic="true">
          <StatusDot state={workspace.state} /> {terminalStateLabel(workspace)}
        </span>
        <div className="toolbar-actions">
          <button
            className="icon-button"
            type="button"
            onClick={() => {
              setSearchOpen(true);
              window.setTimeout(() => searchInputRef.current?.focus(), 0);
            }}
            aria-label="Find in terminal"
            title="Find in terminal"
          >
            <Search size={14} />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={copySelection}
            disabled={!hasSelection}
            aria-label="Copy terminal selection"
            title="Copy selection"
          >
            <Copy size={14} />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={pasteClipboard}
            disabled={ended}
            aria-label="Paste into terminal"
            title="Paste"
          >
            <Clipboard size={14} />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => terminalRef.current?.clear()}
            aria-label="Clear terminal"
            title="Clear terminal"
          >
            <Eraser size={14} />
          </button>
          {!ended && (
            <button className="toolbar-button" type="button" onClick={onDisconnect}>
              <Power size={14} /> {local ? "Stop" : "Disconnect"}
            </button>
          )}
          {ended && (
            <button className="toolbar-button" type="button" onClick={onReconnect}>
              <RefreshCw size={14} /> {local ? "Restart" : "Reconnect"}
            </button>
          )}
        </div>
      </header>
      {searchOpen && (
        <form
          className="terminal-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            find(true);
          }}
        >
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchInputRef}
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeSearch();
            }}
            aria-label="Find in terminal output"
            placeholder="Find in terminal"
          />
          <span className="terminal-search-count" aria-live="polite">
            {searchResult.count
              ? `${searchResult.index + 1} of ${searchResult.count}`
              : searchTerm
                ? "No matches"
                : ""}
          </span>
          <button type="button" onClick={() => find(false)} aria-label="Previous match">
            <ChevronUp size={14} />
          </button>
          <button type="button" onClick={() => find(true)} aria-label="Next match">
            <ChevronDown size={14} />
          </button>
          <button type="button" onClick={closeSearch} aria-label="Close terminal search">
            <X size={14} />
          </button>
        </form>
      )}
      {(localError || workspace.reason) && (
        <div className="terminal-notice" role="status">
          {localError ?? workspace.reason}
        </div>
      )}
      <div className="terminal-container" ref={containerRef} />
    </section>
  );
}
