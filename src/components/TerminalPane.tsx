import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Eraser, PlugZap, RefreshCw } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { parseHistoryOsc } from "../lib/history-osc";
import { BoundedByteQueue, isControlRoomShortcut } from "../lib/terminal-flow";
import type {
  AppSettings,
  ConnectionState,
  SavedConnection,
  SessionStateEvent,
  Workspace,
} from "../types";
import { StatusDot } from "./StatusDot";

interface TerminalPaneProps {
  connection: SavedConnection;
  workspace: Workspace;
  settings: AppSettings;
  visible: boolean;
  onSession: (sessionId: string | null) => void;
  onState: (state: ConnectionState, reason: string | null) => void;
}

interface PendingHistory {
  command: string;
  cwd: string | null;
  startedAt: string;
}

const MAX_EARLY_SESSION_EVENTS = 16;

export function TerminalPane({
  connection,
  workspace,
  settings,
  visible,
  onSession,
  onState,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const sessionGenerationRef = useRef(0);
  const pendingInputRef = useRef(new BoundedByteQueue());
  const acceptingInputRef = useRef(false);
  const pendingHistoryRef = useRef<PendingHistory | null>(null);
  const earlySessionEventsRef = useRef(new Map<string, SessionStateEvent>());
  const historyPausedRef = useRef(workspace.historyPaused);
  const globalHistoryEnabledRef = useRef(settings.globalHistoryEnabled);
  const visibleRef = useRef(visible);
  const connectionIdRef = useRef(connection.id);
  const onSessionRef = useRef(onSession);
  const onStateRef = useRef(onState);
  const handleSessionStateRef = useRef<(event: SessionStateEvent) => void>(() => undefined);
  const sendInputRef = useRef<(bytes: Uint8Array) => void>(() => undefined);
  const [reconnectGeneration, setReconnectGeneration] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);

  historyPausedRef.current = workspace.historyPaused;
  globalHistoryEnabledRef.current = settings.globalHistoryEnabled;
  visibleRef.current = visible;
  connectionIdRef.current = connection.id;
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
      setLocalError("Reconnect before sending terminal input.");
      return;
    }
    if (!pendingInputRef.current.enqueue(bytes)) {
      setLocalError("Terminal input is paused while the SSH session catches up.");
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
      fontFamily: settings.terminalFontFamily,
      fontSize: settings.terminalFontSize,
      scrollback: settings.terminalScrollback,
      theme: {
        background: "#080b0f",
        foreground: "#dce5ee",
        cursor: "#55d68b",
        selectionBackground: "#173b25",
        black: "#151b22",
        red: "#ff6b72",
        green: "#55d68b",
        yellow: "#e7c664",
        blue: "#65a9ff",
        magenta: "#c58bff",
        cyan: "#5dd9d2",
        white: "#dce5ee",
        brightBlack: "#657180",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    fit.fit();
    terminalRef.current = terminal;
    fitRef.current = fit;

    const send = (bytes: Uint8Array) => sendInputRef.current(bytes);
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
        void navigator.clipboard
          .readText()
          .then((text) => send(new TextEncoder().encode(text)))
          .catch((error) => setLocalError(`Paste failed: ${errorMessage(error)}`));
        return false;
      }
      return true;
    });

    const oscDisposable = terminal.parser.registerOscHandler(633, (data) => {
      if (!data.startsWith("ControlRoom;")) return false;
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
          if (
            pending &&
            sessionId &&
            globalHistoryEnabledRef.current &&
            !historyPausedRef.current
          ) {
            void api
              .addHistory({
                connectionId: connectionIdRef.current,
                sessionId,
                command: pending.command,
                cwd: event.cwd || pending.cwd,
                startedAt: pending.startedAt,
                finishedAt: event.finishedAt,
                exitCode: event.exitCode,
                shell: "bash",
              })
              .catch((error) => setLocalError(`History capture failed: ${errorMessage(error)}`));
          }
        }
      } catch (error) {
        pendingHistoryRef.current = null;
        setLocalError(`History capture failed: ${errorMessage(error)}`);
      }
      return true;
    });

    const unlistenPromise = listen<SessionStateEvent>("session-state-changed", ({ payload }) => {
      if (payload.sessionId === sessionIdRef.current) {
        handleSessionStateRef.current(payload);
        return;
      }
      const events = earlySessionEventsRef.current;
      events.set(payload.sessionId, payload);
      while (events.size > MAX_EARLY_SESSION_EVENTS) {
        const oldest = events.keys().next().value;
        if (oldest === undefined) break;
        events.delete(oldest);
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
      observer.disconnect();
      window.clearTimeout(resizeTimer);
      dataDisposable.dispose();
      binaryDisposable.dispose();
      oscDisposable.dispose();
      void unlistenPromise.then((unlisten) => unlisten());
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const generation = ++sessionGenerationRef.current;
    let ownedSessionId: string | null = null;
    let acknowledgedBytes = 0;
    let acknowledgementTimer: number | undefined;
    let disposed = false;

    acceptingInputRef.current = true;
    pendingInputRef.current.clear();
    pendingHistoryRef.current = null;
    sessionIdRef.current = null;
    onSessionRef.current(null);
    onStateRef.current("connecting", null);
    setLocalError(null);

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

    void api
      .startSession(connection, terminal.cols, terminal.rows, output)
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
  }, [connection.id, reconnectGeneration, workspace.reconnectToken]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontFamily = settings.terminalFontFamily;
    terminal.options.fontSize = settings.terminalFontSize;
    terminal.options.scrollback = settings.terminalScrollback;
    if (visible) {
      fitRef.current?.fit();
      terminal.focus();
    }
  }, [settings, visible]);

  async function disconnect() {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    try {
      await api.closeSession(sessionId);
    } catch (error) {
      setLocalError(errorMessage(error));
    }
  }

  return (
    <section className={`terminal-pane ${visible ? "terminal-visible" : "terminal-hidden"}`}>
      <header className="terminal-toolbar">
        <span className="toolbar-state">
          <StatusDot state={workspace.state} /> {workspace.state}
        </span>
        <div className="toolbar-actions">
          {(workspace.state === "disconnected" || workspace.state === "error") && (
            <button
              className="toolbar-button"
              type="button"
              onClick={() => setReconnectGeneration((value) => value + 1)}
            >
              <RefreshCw size={14} /> Reconnect
            </button>
          )}
          <button
            className="toolbar-button"
            type="button"
            onClick={() => terminalRef.current?.clear()}
          >
            <Eraser size={14} /> Clear
          </button>
          <button
            className="toolbar-button"
            type="button"
            onClick={disconnect}
            disabled={!workspace.sessionId}
          >
            <PlugZap size={14} /> Disconnect
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
