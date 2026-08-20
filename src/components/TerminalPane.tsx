import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Eraser, PlugZap, RefreshCw } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { decodeBase64Utf8, timestampFromEpoch } from "../lib/format";
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
  const pendingInputRef = useRef<Uint8Array[]>([]);
  const pendingHistoryRef = useRef<PendingHistory | null>(null);
  const historyPausedRef = useRef(workspace.historyPaused);
  const [generation, setGeneration] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    historyPausedRef.current = workspace.historyPaused;
  }, [workspace.historyPaused]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let resizeTimer: number | undefined;
    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: settings.terminalFontFamily,
      fontSize: settings.terminalFontSize,
      scrollback: settings.terminalScrollback,
      theme: {
        background: "#080b0f",
        foreground: "#dce5ee",
        cursor: "#72b7ff",
        selectionBackground: "#244b6f",
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
    setLocalError(null);
    onState("connecting", null);

    const send = (bytes: Uint8Array) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) {
        pendingInputRef.current.push(bytes);
        return;
      }
      void api.writeSession(sessionId, bytes).catch((error) => setLocalError(errorMessage(error)));
    };
    const dataDisposable = terminal.onData((data) => send(new TextEncoder().encode(data)));
    const binaryDisposable = terminal.onBinary((data) =>
      send(Uint8Array.from(data, (character) => character.charCodeAt(0))),
    );
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || !event.ctrlKey || !event.shiftKey) return true;
      if (event.key.toLowerCase() === "c" && terminal.hasSelection()) {
        void navigator.clipboard.writeText(terminal.getSelection());
        return false;
      }
      if (event.key.toLowerCase() === "v") {
        void navigator.clipboard.readText().then((text) => send(new TextEncoder().encode(text)));
        return false;
      }
      return true;
    });

    const oscDisposable = terminal.parser.registerOscHandler(633, (data) => {
      if (!data.startsWith("ControlRoom;")) return false;
      const parts = data.split(";");
      if (parts[1] === "start" && parts.length >= 5) {
        pendingHistoryRef.current = {
          startedAt: timestampFromEpoch(parts[2]),
          cwd: decodeBase64Utf8(parts[3]) || null,
          command: decodeBase64Utf8(parts[4]),
        };
      } else if (parts[1] === "finish" && parts.length >= 5) {
        const pending = pendingHistoryRef.current;
        pendingHistoryRef.current = null;
        const sessionId = sessionIdRef.current;
        if (pending && sessionId && !historyPausedRef.current) {
          void api.addHistory({
            connectionId: connection.id,
            sessionId,
            command: pending.command,
            cwd: decodeBase64Utf8(parts[4]) || pending.cwd,
            startedAt: pending.startedAt,
            finishedAt: timestampFromEpoch(parts[2]),
            exitCode: Number(parts[3]),
            shell: "bash",
          });
        }
      }
      return true;
    });

    const output = new Channel<ArrayBuffer>();
    output.onmessage = (message) => {
      if (!disposed) terminal.write(new Uint8Array(message));
    };
    void api
      .startSession(connection.id, terminal.cols, terminal.rows, output)
      .then(async ({ sessionId }) => {
        if (disposed) {
          await api.closeSession(sessionId).catch(() => undefined);
          return;
        }
        sessionIdRef.current = sessionId;
        onSession(sessionId);
        onState("connected", null);
        for (const bytes of pendingInputRef.current.splice(0)) {
          await api.writeSession(sessionId, bytes);
        }
      })
      .catch((error) => {
        const message = errorMessage(error);
        setLocalError(message);
        onState("error", message);
      });

    const unlistenPromise = listen<SessionStateEvent>("session-state-changed", ({ payload }) => {
      if (payload.sessionId !== sessionIdRef.current) return;
      onState(payload.state, payload.reason);
      if (payload.state === "disconnected" || payload.state === "error") {
        sessionIdRef.current = null;
        onSession(null);
      }
    });
    const observer = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (!visible) return;
        fit.fit();
        const sessionId = sessionIdRef.current;
        if (sessionId) void api.resizeSession(sessionId, terminal.cols, terminal.rows);
      }, 60);
    });
    observer.observe(container);

    return () => {
      disposed = true;
      observer.disconnect();
      window.clearTimeout(resizeTimer);
      dataDisposable.dispose();
      binaryDisposable.dispose();
      oscDisposable.dispose();
      void unlistenPromise.then((unlisten) => unlisten());
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      if (sessionId) void api.closeSession(sessionId).catch(() => undefined);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [connection.id, generation, workspace.reconnectToken]);

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
    if (sessionIdRef.current) await api.closeSession(sessionIdRef.current);
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
              onClick={() => setGeneration((v) => v + 1)}
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
        <div className="terminal-notice">{localError ?? workspace.reason}</div>
      )}
      <div className="terminal-container" ref={containerRef} />
    </section>
  );
}
