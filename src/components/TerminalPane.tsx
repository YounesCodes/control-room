import { Search } from "./MagnifierIcon";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import { ChevronDown, ChevronUp, RotateCw, X } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { isControlRoomConnectedOsc, parseHistoryOsc } from "../lib/history-osc";
import { notifyHistoryChanged } from "../lib/history-events";
import { nextFrameOrTimeout } from "../lib/animation-timing";
import {
  BoundedByteQueue,
  isControlRoomShortcut,
  terminalRightClickAction,
} from "../lib/terminal-flow";
import { trackCodexMouse } from "../lib/terminal-mouse";
import { buildTerminalTheme } from "../lib/terminal-theme";
import { TerminalProcessing } from "../lib/terminal-processing";
import { TerminalTitle } from "../lib/terminal-title";
import { formatTerminalStartup, TerminalStartupTiming } from "../lib/terminal-startup-timing";
import { readTerminalView } from "../lib/terminal-screen";
import { deferHiddenSelectionRepaint } from "../lib/terminal-selection-repaint";
import { isRemoteWorkspace } from "../lib/workspace-target";
import type {
  AppSettings,
  ConnectionState,
  EnvironmentInfo,
  SessionStateEvent,
  Workspace,
} from "../types";

export interface TerminalPaneHandle {
  focus: () => void;
  copySelection: () => void;
  pasteClipboard: () => void;
  toggleSearch: () => void;
}

interface TerminalPaneProps {
  ref?: Ref<TerminalPaneHandle>;
  workspace: Workspace;
  platform: EnvironmentInfo["platform"];
  settings: AppSettings;
  visible: boolean;
  active: boolean;
  nativeClipboard?: boolean;
  onActivate: () => void;
  onSession: (sessionId: string | null) => void;
  onState: (state: ConnectionState, reason: string | null) => void;
  onSelectionChange?: (hasSelection: boolean) => void;
  onActivity?: (kind: "output" | "bell") => void;
  onProcessing?: (busy: boolean) => void;
  onSearchOpenChange?: (open: boolean) => void;
  onTitle?: (title: string | null) => void;
  findRequest?: number;
  onReconnect?: () => void;
}

interface PendingHistory {
  command: string;
  cwd: string | null;
  startedAt: string;
}

const MAX_EARLY_SESSION_EVENTS = 16;

const WEBKIT_SUSPENDED_FRAME_TIMEOUT_MS = 100;

export function TerminalPane({
  ref,
  workspace,
  platform,
  settings,
  visible,
  active,
  nativeClipboard = false,
  onActivate,
  onSession,
  onState,
  onSelectionChange,
  onActivity = () => undefined,
  onProcessing = () => undefined,
  onSearchOpenChange,
  onTitle = () => undefined,
  findRequest = 0,
  onReconnect,
}: TerminalPaneProps) {
  const remote = isRemoteWorkspace(workspace) ? workspace : null;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wasActiveRef = useRef(false);
  const platformRef = useRef(platform);
  platformRef.current = platform;
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const selectionRepaintRef = useRef<{ flush: () => void } | null>(null);
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
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onActivityRef = useRef(onActivity);
  const onProcessingRef = useRef(onProcessing);
  const onTitleRef = useRef(onTitle);
  const titleRef = useRef<TerminalTitle | null>(null);
  if (!titleRef.current) titleRef.current = new TerminalTitle((title) => onTitleRef.current(title));
  const processingRef = useRef<TerminalProcessing | null>(null);
  const startupTimingRef = useRef<TerminalStartupTiming | null>(null);
  if (!processingRef.current) {
    processingRef.current = new TerminalProcessing(
      (busy) => onProcessingRef.current(busy),
      () => titleRef.current?.idle(),
      (command) => titleRef.current?.command(command),
    );
  }
  const handleSessionStateRef = useRef<(event: SessionStateEvent) => void>(() => undefined);
  const sendInputRef = useRef<(bytes: Uint8Array) => void>(() => undefined);
  const [localNotice, setLocalNotice] = useState<{
    message: string;
    tone: "error" | "warning";
  } | null>(null);
  const setLocalError = (message: string | null) =>
    setLocalNotice(message === null ? null : { message, tone: "error" });
  const setLocalWarning = (message: string) => setLocalNotice({ message, tone: "warning" });
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResult, setSearchResult] = useState({ index: -1, count: 0 });

  const nativeClipboardRef = useRef(nativeClipboard);
  nativeClipboardRef.current = nativeClipboard;
  const copySelection = useCallback(() => {
    const text = terminalRef.current?.getSelection();
    if (!text) return;
    const write = nativeClipboardRef.current
      ? api.writeClipboard(text)
      : navigator.clipboard.writeText(text);
    void write.catch((error) => setLocalError(clipboardFailure("copy", error)));
  }, []);

  const pasteClipboard = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const generation = sessionGenerationRef.current;
    terminal.focus();
    const read = nativeClipboardRef.current ? api.readClipboard() : navigator.clipboard.readText();
    void read
      .then((text) => {
        if (
          text &&
          terminalRef.current === terminal &&
          sessionGenerationRef.current === generation
        ) {
          terminal.paste(text);
        }
      })
      .catch((error) => setLocalError(clipboardFailure("paste", error)));
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => terminalRef.current?.focus(),
    copySelection,
    pasteClipboard,
    toggleSearch: () => (searchOpen ? closeSearch() : openSearch()),
  }));

  historyPausedRef.current = remote?.historyPaused ?? false;
  globalHistoryEnabledRef.current = settings.globalHistoryEnabled;
  visibleRef.current = visible;
  activeRef.current = active;
  connectionIdRef.current = remote?.connectionId ?? null;
  workspaceReasonRef.current = workspace.reason;
  onSessionRef.current = onSession;
  onStateRef.current = onState;
  onSelectionChangeRef.current = onSelectionChange;
  onActivityRef.current = onActivity;
  onProcessingRef.current = onProcessing;
  onTitleRef.current = onTitle;

  handleSessionStateRef.current = (event) => {
    onStateRef.current(event.state, event.reason);
    if (event.state !== "disconnected" && event.state !== "error") return;
    processingRef.current?.reset();
    titleRef.current?.reset();
    acceptingInputRef.current = false;
    pendingInputRef.current.clear();
    sessionIdRef.current = null;
    pendingHistoryRef.current = null;
    onSessionRef.current(null);
  };

  sendInputRef.current = (bytes) => {
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      const view = readTerminalView(terminalRef.current);
      if (workspace.state === "connected") {
        processingRef.current?.input(bytes, view.line, view.alternate);
      }
      void api.writeSession(sessionId, bytes).catch((error) => {
        if (sessionIdRef.current !== sessionId) return;
        processingRef.current?.reset();
        titleRef.current?.reset();
        setLocalError(errorMessage(error));
      });
      return;
    }
    if (!acceptingInputRef.current) {
      if (workspace.kind === "local") {
        setLocalWarning("Restart the shell before sending terminal input.");
      } else if (!workspaceReasonRef.current) {
        setLocalWarning("Reconnect before sending terminal input.");
      }
      return;
    }
    if (!pendingInputRef.current.enqueue(bytes)) {
      setLocalWarning("Terminal input is paused while the session catches up.");
    }
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let resizeTimer: number | undefined;
    let bellTimer: number | undefined;
    const theme = buildTerminalTheme(settings);
    const terminal = new Terminal({
      // SearchAddon match decorations require xterm's proposed API.
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      macOptionClickForcesSelection: true,
      fontWeightBold: "normal",
      drawBoldTextInBrightColors: false,
      fontFamily: settings.terminalFontFamily,
      fontSize: settings.terminalFontSize,
      overviewRuler: { width: 8, showTopBorder: false, showBottomBorder: false },
      scrollback: settings.terminalScrollback,
      theme,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    terminal.open(container);
    const codexMouse = trackCodexMouse(container, terminal);
    fit.fit();
    terminalRef.current = terminal;
    fitRef.current = fit;
    searchRef.current = search;
    selectionRepaintRef.current = deferHiddenSelectionRepaint(terminal, () => visibleRef.current);

    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        void api
          .resizeSession(sessionId, cols, rows)
          .catch((error) => setLocalError(errorMessage(error)));
      }
    });

    const selectionDisposable = terminal.onSelectionChange(() =>
      onSelectionChangeRef.current?.(terminal.hasSelection()),
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
    const dataDisposable = terminal.onData((data) => send(new TextEncoder().encode(data)));
    const binaryDisposable = terminal.onBinary((data) =>
      send(Uint8Array.from(data, (character) => character.charCodeAt(0))),
    );
    terminal.attachCustomKeyEventHandler((event) => {
      const useMetaKey = platformRef.current === "macos";
      if (isControlRoomShortcut(event, useMetaKey ? "meta" : "control")) return false;
      const primary = useMetaKey ? event.metaKey : event.ctrlKey;
      const other = useMetaKey ? event.ctrlKey : event.metaKey;
      if (event.type !== "keydown" || !primary || event.altKey || other) return true;
      const key = event.key.toLowerCase();
      if (key === "c" && terminal.hasSelection()) {
        event.preventDefault();
        copySelection();
        return false;
      }
      if (key === "v" && event.shiftKey && nativeClipboardRef.current) {
        event.preventDefault();
        pasteClipboard();
        return false;
      }
      return true;
    });

    const rightClickAction = (event: MouseEvent) =>
      terminalRightClickAction({
        button: event.button,
        hasSelection: terminal.hasSelection(),
        mouseTrackingMode: terminal.modes.mouseTrackingMode,
        isCodex: codexMouse.isCodex(),
      });

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 2) return;
      const action = rightClickAction(event);
      if (action !== "copy" && action !== "paste") return;
      event.preventDefault();
      event.stopPropagation();
    };
    container.addEventListener("mousedown", handleMouseDown, { capture: true });

    const handleMouseMove = (event: MouseEvent) => {
      // xterm reports hover moves as terminal input, which clears its selection.
      if (
        event.buttons === 0 &&
        terminal.modes.mouseTrackingMode === "any" &&
        terminal.hasSelection()
      ) {
        event.stopPropagation();
      }
    };
    container.addEventListener("mousemove", handleMouseMove, { capture: true });

    // Runs before xterm moves its textarea for the browser context menu.
    const handleContextMenu = (event: MouseEvent) => {
      const action = rightClickAction(event);
      if (action === "ignore") return;

      event.preventDefault();
      event.stopPropagation();
      if (action === "copy") copySelection();
      if (action === "paste") pasteClipboard();
    };
    container.addEventListener("contextmenu", handleContextMenu, { capture: true });

    const promptDisposable = terminal.parser.registerOscHandler(133, (data) => {
      startupTimingRef.current?.shellMarker(data);
      if (!sessionIdRef.current) return false;
      titleRef.current?.marker(data);
      processingRef.current?.shellMarker(data);
      return false;
    });
    const progressDisposable = terminal.parser.registerOscHandler(9, (data) => {
      if (!sessionIdRef.current) return false;
      return processingRef.current?.progress(data) ?? false;
    });
    const oscDisposable = terminal.parser.registerOscHandler(633, (data) => {
      if (!data.startsWith("ControlRoom;")) {
        startupTimingRef.current?.shellMarker(data);
        if (sessionIdRef.current) titleRef.current?.marker(data);
        if (sessionIdRef.current) processingRef.current?.shellMarker(data);
        return false;
      }
      if (isControlRoomConnectedOsc(data)) return true;
      if (!sessionIdRef.current) return true;
      try {
        const event = parseHistoryOsc(data);
        if (!event) {
          pendingHistoryRef.current = null;
          return true;
        }
        processingRef.current?.command(event.kind === "start");
        if (event.kind === "start") titleRef.current?.command(event.command);
        else titleRef.current?.idle();
        if (!connectionIdRef.current) return true;
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
                shell: remote?.remoteShell?.id === "macos:zsh" ? "zsh" : "bash",
              })
              .then(() => notifyHistoryChanged(connectionId))
              .catch((error) => setLocalError(`History capture failed: ${errorMessage(error)}`));
          }
        }
      } catch (error) {
        pendingHistoryRef.current = null;
        setLocalError(`History capture failed: ${errorMessage(error)}`);
      }
      return true;
    });

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
      }, 60);
    });
    observer.observe(container);

    return () => {
      listenerDisposed = true;
      unlisten?.();
      observer.disconnect();
      codexMouse.dispose();
      container.removeEventListener("mousedown", handleMouseDown, { capture: true });
      container.removeEventListener("mousemove", handleMouseMove, { capture: true });
      container.removeEventListener("contextmenu", handleContextMenu, { capture: true });
      window.clearTimeout(resizeTimer);
      window.clearTimeout(bellTimer);
      dataDisposable.dispose();
      binaryDisposable.dispose();
      resizeDisposable.dispose();
      selectionDisposable.dispose();
      bellDisposable.dispose();
      searchDisposable.dispose();
      promptDisposable.dispose();
      progressDisposable.dispose();
      oscDisposable.dispose();
      processingRef.current?.reset();
      titleRef.current?.reset();
      search.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      selectionRepaintRef.current = null;
    };
  }, [copySelection, pasteClipboard]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const theme = buildTerminalTheme(settings);

    // SearchAddon selects the active match, which would recolor ANSI output.
    terminal.options.theme =
      searchOpen && searchTerm ? { ...theme, selectionBackground: "transparent" } : theme;
  }, [settings, searchOpen, searchTerm]);

  const targetId = workspace.kind === "local" ? workspace.shell.id : workspace.connectionId;

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (!workspace.connectRequested) {
      processingRef.current?.reset();
      titleRef.current?.reset();
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
    const startupContainer = containerRef.current;
    const startupTiming = new TerminalStartupTiming(
      workspace.kind === "local"
        ? `local:${workspace.shell.id}`
        : workspace.container
          ? "ssh:container"
          : `ssh:${workspace.remoteShell?.id ?? "default"}`,
      (report) => {
        console.info(formatTerminalStartup(report));
        startupContainer?.setAttribute("data-terminal-startup-timing", JSON.stringify(report));
      },
    );
    startupTimingRef.current?.cancel();
    startupTimingRef.current = startupTiming;

    acceptingInputRef.current = true;
    processingRef.current?.reset();
    titleRef.current?.reset();
    pendingInputRef.current.clear();
    pendingHistoryRef.current = null;
    earlySessionEventsRef.current.clear();
    sessionIdRef.current = null;
    onSessionRef.current(null);
    onStateRef.current("connecting", null);
    setLocalError(null);
    onSelectionChangeRef.current?.(false);

    const flushAcknowledgements = () => {
      window.clearTimeout(acknowledgementTimer);
      acknowledgementTimer = undefined;
      if (ownedSessionId && sessionIdRef.current !== ownedSessionId) {
        acknowledgedBytes = 0;
        return;
      }
      if (!ownedSessionId || acknowledgedBytes === 0) return;
      const bytes = acknowledgedBytes;
      acknowledgedBytes = 0;
      void api.acknowledgeSessionOutput(ownedSessionId, bytes).catch((error) => {
        if (
          !disposed &&
          generation === sessionGenerationRef.current &&
          sessionIdRef.current === ownedSessionId
        ) {
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
      if (!sessionIdRef.current && !acceptingInputRef.current) return;
      const bytes = new Uint8Array(message);
      startupTiming.mark("firstOutput");
      if (!activeRef.current) onActivityRef.current("output");
      terminal.write(bytes, () => {
        if (disposed || generation !== sessionGenerationRef.current) return;
        if (!sessionIdRef.current && !acceptingInputRef.current) return;
        const view = readTerminalView(terminal);
        startupTiming.rendered(view.line);
        processingRef.current?.output(
          view.line,
          view.alternate,
          () => readTerminalView(terminal, true).status,
        );
        acknowledge(bytes.byteLength);
      });
    };

    let initialCols = terminal.cols;
    let initialRows = terminal.rows;
    const startupPhase = (phase: string) =>
      startupContainer?.setAttribute("data-terminal-startup-phase", phase);
    const started = (async () => {
      startupPhase("draining");
      await new Promise<void>((resolve) => terminal.write("", resolve));
      if (disposed || generation !== sessionGenerationRef.current) return null;
      startupTiming.mark("drained");
      terminal.reset();
      startupPhase("font");
      await document.fonts
        ?.load(`${settings.terminalFontSize}px ${settings.terminalFontFamily}`, "MW")
        .catch(() => undefined);
      startupTiming.mark("fontLoaded");
      let measuredCols: number | undefined;
      let measuredRows: number | undefined;
      let smallestCols = Number.POSITIVE_INFINITY;
      let smallestRows = Number.POSITIVE_INFINITY;
      let settled = false;
      for (
        let pass = 0;
        pass < 8 && !disposed && generation === sessionGenerationRef.current;
        pass++
      ) {
        startupPhase("layout");
        await nextFrameOrTimeout(WEBKIT_SUSPENDED_FRAME_TIMEOUT_MS);
        if (disposed || generation !== sessionGenerationRef.current) return null;
        fitRef.current?.fit();
        smallestCols = Math.min(smallestCols, terminal.cols);
        smallestRows = Math.min(smallestRows, terminal.rows);
        startupContainer?.setAttribute(
          "data-terminal-startup-grid",
          `${terminal.cols}x${terminal.rows}`,
        );
        startupContainer?.setAttribute("data-terminal-fit-pass", String(pass + 1));
        if (terminal.cols === measuredCols && terminal.rows === measuredRows) {
          settled = true;
          break;
        }
        measuredCols = terminal.cols;
        measuredRows = terminal.rows;
      }
      if (disposed || generation !== sessionGenerationRef.current) return null;
      if (!settled) terminal.resize(smallestCols, smallestRows);
      startupPhase("native");
      startupTiming.mark("layout");
      initialCols = terminal.cols;
      initialRows = terminal.rows;
      return workspace.kind === "local"
        ? api.startLocalSession(workspace.shell.id, initialCols, initialRows, output)
        : api.startSession(
            workspace.connectionId,
            initialCols,
            initialRows,
            output,
            workspace.remoteShell?.id ?? null,
            workspace.container?.id ?? null,
          );
    })();

    void started
      .then(async (result) => {
        if (!result) return;
        const { sessionId } = result;
        if (disposed || generation !== sessionGenerationRef.current) {
          await api.closeSession(sessionId).catch(() => undefined);
          return;
        }
        startupPhase("started");
        startupTiming.mark("started");
        ownedSessionId = sessionId;
        sessionIdRef.current = sessionId;
        if (terminal.cols !== initialCols || terminal.rows !== initialRows) {
          await api.resizeSession(sessionId, terminal.cols, terminal.rows);
          if (disposed || generation !== sessionGenerationRef.current) return;
        }
        acceptingInputRef.current = false;
        onSessionRef.current(sessionId);
        if (acknowledgedBytes > 0) flushAcknowledgements();
        if (workspace.kind === "local") onStateRef.current("connected", null);

        const earlyEvent = earlySessionEventsRef.current.get(sessionId);
        earlySessionEventsRef.current.delete(sessionId);
        if (earlyEvent) {
          handleSessionStateRef.current(earlyEvent);
          if (earlyEvent.state === "disconnected" || earlyEvent.state === "error") return;
        }

        for (const bytes of pendingInputRef.current.drain()) {
          if (disposed || generation !== sessionGenerationRef.current) break;
          sendInputRef.current(bytes);
        }
      })
      .catch((error) => {
        if (disposed || generation !== sessionGenerationRef.current) return;
        startupPhase("error");
        startupTiming.cancel();
        acceptingInputRef.current = false;
        pendingInputRef.current.clear();
        const message = errorMessage(error);
        setLocalError(message);
        processingRef.current?.reset();
        titleRef.current?.reset();
        onStateRef.current("error", message);
      });

    return () => {
      disposed = true;
      startupTiming.cancel();
      if (startupTimingRef.current === startupTiming) startupTimingRef.current = null;
      sessionGenerationRef.current += 1;
      acceptingInputRef.current = false;
      pendingInputRef.current.clear();
      pendingHistoryRef.current = null;
      processingRef.current?.reset();
      titleRef.current?.reset();
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
    if (visible) {
      fitRef.current?.fit();
      selectionRepaintRef.current?.flush();
    }
    const focusOwner = document.activeElement;
    const popoverOwnsFocus =
      focusOwner instanceof Element &&
      focusOwner.closest("[data-app-popover]:not([inert])") !== null;
    if (active && !wasActiveRef.current && !popoverOwnsFocus) terminal.focus();
    wasActiveRef.current = active;
  }, [settings, visible, active]);

  useEffect(() => {
    if (findRequest > 0) openSearch();
  }, [findRequest]);

  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  useEffect(() => {
    if (searchFocusRequest > 0) searchInputRef.current?.focus();
  }, [searchFocusRequest]);

  const onSearchOpenChangeRef = useRef(onSearchOpenChange);
  onSearchOpenChangeRef.current = onSearchOpenChange;
  useEffect(() => {
    onSearchOpenChangeRef.current?.(searchOpen);
  }, [searchOpen]);

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
        matchBorder: "#92928e",
        matchOverviewRuler: "#92928e",
        activeMatchBorder: "#f2f2ee",
        activeMatchColorOverviewRuler: "#f2f2ee",
      },
    };
    if (next) search.findNext(searchTerm, options);
    else search.findPrevious(searchTerm, options);
  }

  function openSearch() {
    setSearchOpen(true);
    setSearchFocusRequest((current) => current + 1);
  }

  function closeSearch() {
    searchRef.current?.clearDecorations();
    setSearchOpen(false);
    setSearchResult({ index: -1, count: 0 });
    terminalRef.current?.focus();
  }

  const terminalEnded = workspace.state === "disconnected" || workspace.state === "error";
  const noticeTone =
    localNotice?.tone ?? (workspace.state === "disconnected" ? "neutral" : "error");
  return (
    <section
      className={`terminal-pane ${visible ? "terminal-visible" : "terminal-hidden"}`}
      onPointerDown={onActivate}
    >
      {(localNotice || workspace.reason) && (
        <div
          className="terminal-notice"
          data-tone={noticeTone}
          role={noticeTone === "error" ? "alert" : "status"}
        >
          <span className="terminal-notice-message">
            {localNotice?.message ?? workspace.reason}
          </span>
          {terminalEnded && onReconnect ? (
            <button type="button" className="terminal-notice-action" onClick={onReconnect}>
              <RotateCw size={13} aria-hidden="true" />
              <span>{isRemoteWorkspace(workspace) ? "Reconnect" : "Restart"}</span>
            </button>
          ) : (
            localNotice && (
              <button
                type="button"
                className="terminal-notice-dismiss"
                aria-label="Dismiss terminal notice"
                onClick={() => {
                  setLocalNotice(null);
                  terminalRef.current?.focus();
                }}
              >
                <X size={14} aria-hidden="true" />
              </button>
            )
          )}
        </div>
      )}
      <div className="terminal-content">
        <div className="terminal-container" ref={containerRef} />
        {searchOpen && (
          <form
            className="search-field terminal-search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              find(true);
            }}
          >
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchInputRef}
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") closeSearch();
                if (event.key === "Enter" && event.shiftKey) {
                  event.preventDefault();
                  find(false);
                }
              }}
              aria-label="Find in terminal output"
              placeholder="Find in terminal"
            />
            <span
              className="terminal-search-count"
              data-none={searchTerm && !searchResult.count ? "" : undefined}
              aria-live="polite"
            >
              {searchResult.count
                ? `${searchResult.index + 1} of ${searchResult.count}`
                : searchTerm
                  ? "No matches"
                  : ""}
            </span>
            <button
              className="icon-button"
              type="button"
              onClick={() => find(false)}
              disabled={!searchResult.count}
              aria-label="Previous match"
            >
              <ChevronUp size={14} />
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={() => find(true)}
              disabled={!searchResult.count}
              aria-label="Next match"
            >
              <ChevronDown size={14} />
            </button>
            <span className="terminal-search-divider" aria-hidden="true" />
            <button
              className="icon-button"
              type="button"
              onClick={closeSearch}
              aria-label="Close terminal search"
            >
              <X size={14} />
            </button>
          </form>
        )}
      </div>
    </section>
  );
}

function clipboardFailure(action: "copy" | "paste", error: unknown) {
  const denied =
    (error instanceof DOMException && error.name === "NotAllowedError") ||
    /permission denied/i.test(errorMessage(error));
  return denied
    ? `Could not ${action}: clipboard access was denied.`
    : `Could not ${action}: ${errorMessage(error)}`;
}
