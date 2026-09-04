import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { CircleStop, Eraser, PlugZap, RefreshCw } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { isControlRoomConnectedOsc, parseHistoryOsc } from "../lib/history-osc";
import { clearTerminalDisplay } from "../lib/terminal-display";
import {
  BoundedByteQueue,
  isControlRoomShortcut,
  shouldPasteOnRightClick,
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
}: TerminalPaneProps) {
  const remote = isRemoteWorkspace(workspace) ? workspace : null;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const sessionGenerationRef = useRef(0);
  const pendingInputRef = useRef(new BoundedByteQueue());
  const acceptingInputRef = useRef(false);
  const pendingHistoryRef = useRef<PendingHistory | null>(null);
  const earlySessionEventsRef = useRef(new Map<string, SessionStateEvent>());
  const historyPausedRef = useRef(remote?.historyPaused ?? false);
  const globalHistoryEnabledRef = useRef(settings.globalHistoryEnabled);
  const rightClickPasteRef = useRef(settings.terminalRightClickPaste);
  const visibleRef = useRef(visible);
  const connectionIdRef = useRef(remote?.connectionId ?? null);
  const onSessionRef = useRef(onSession);
  const onStateRef = useRef(onState);
  const handleSessionStateRef = useRef<(event: SessionStateEvent) => void>(() => undefined);
  const sendInputRef = useRef<(bytes: Uint8Array) => void>(() => undefined);
  const [localError, setLocalError] = useState<string | null>(null);

  historyPausedRef.current = remote?.historyPaused ?? false;
  globalHistoryEnabledRef.current = settings.globalHistoryEnabled;
  rightClickPasteRef.current = settings.terminalRightClickPaste;
  visibleRef.current = visible;
  connectionIdRef.current = remote?.connectionId ?? null;
  onSessionRef.current = onSession;
  onStateRef.current = onState;

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
      setLocalError(
        workspace.kind === "local"
          ? "Restart the shell before sending terminal input."
          : "Reconnect before sending terminal input.",
      );
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
    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      // Bold text (prompts, directory listings, error lines) is rendered with
      // weight, not a brighter hue, so a bold `01;34` directory shows the exact
      // "Blue and directories" color the user picked instead of a lightened
      // variant. This keeps the terminal matching the Settings color preview.
      drawBoldTextInBrightColors: false,
      fontFamily: settings.terminalFontFamily,
      fontSize: settings.terminalFontSize,
      scrollback: settings.terminalScrollback,
      theme: buildTerminalTheme(settings),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    fit.fit();
    terminalRef.current = terminal;
    fitRef.current = fit;

    const send = (bytes: Uint8Array) => sendInputRef.current(bytes);
    const pasteClipboard = () => {
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) send(new TextEncoder().encode(text));
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
      if (event.key.toLowerCase() === "v") {
        pasteClipboard();
        return false;
      }
      return true;
    });

    // The right click is taken over only while the setting is on, so the
    // webview menu keeps the gesture in every other case.
    const handleContextMenu = (event: MouseEvent) => {
      const paste = shouldPasteOnRightClick({
        enabled: rightClickPasteRef.current,
        button: event.button,
        mouseTrackingMode: terminal.modes.mouseTrackingMode,
      });
      if (!paste) return;
      event.preventDefault();
      pasteClipboard();
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
      container.removeEventListener("contextmenu", handleContextMenu);
      window.clearTimeout(resizeTimer);
      dataDisposable.dispose();
      binaryDisposable.dispose();
      oscDisposable?.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

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

        for (const bytes of pendingInputRef.current.drain()) {
          if (disposed || generation !== sessionGenerationRef.current) break;
          await api.writeSession(sessionId, bytes);
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

  async function endSession() {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    try {
      await api.closeSession(sessionId);
    } catch (error) {
      setLocalError(errorMessage(error));
    }
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
        <span className="toolbar-state">
          <StatusDot state={workspace.state} /> {terminalStateLabel(workspace)}
        </span>
        <div className="toolbar-actions">
          {ended && (
            <button className="toolbar-button" type="button" onClick={onReconnect}>
              <RefreshCw size={14} /> {local ? "Restart" : "Reconnect"}
            </button>
          )}
          <button
            className="toolbar-button"
            type="button"
            onClick={() => {
              const terminal = terminalRef.current;
              if (terminal) clearTerminalDisplay(terminal);
            }}
          >
            <Eraser size={14} /> Clear
          </button>
          <button
            className="toolbar-button"
            type="button"
            onClick={endSession}
            disabled={!workspace.sessionId}
          >
            {local ? <CircleStop size={14} /> : <PlugZap size={14} />}{" "}
            {local ? "Stop" : "Disconnect"}
          </button>
        </div>
      </header>
      {(localError || workspace.reason) && (
        <div className="terminal-notice" role="status">
          {localError ?? workspace.reason}
        </div>
      )}
      <div className="terminal-container" ref={containerRef} />
    </section>
  );
}
