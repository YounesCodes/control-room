// @vitest-environment jsdom

import { createRef, type Ref } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  startSession: vi.fn(),
  startLocalSession: vi.fn(),
  writeSession: vi.fn(),
  resizeSession: vi.fn(),
  acknowledgeSessionOutput: vi.fn(),
  closeSession: vi.fn(),
  addHistory: vi.fn(),
}));
const channels = vi.hoisted(
  () => [] as Array<{ onmessage: ((message: ArrayBuffer) => void) | null }>,
);
const nativeEvents = vi.hoisted(
  () => new Map<string, Set<(event: { payload: unknown }) => void>>(),
);

const xterm = vi.hoisted(() => ({
  initialCols: 100,
  fit: vi.fn(),
  focus: vi.fn(),
  oscHandlers: 0,
  osc: new Map<number, (data: string) => boolean>(),
  prompt: "$ ",
  alternate: false,
  writes: [] as string[],
  pastes: [] as string[],
  searchNext: vi.fn(),
  searchPrevious: vi.fn(),
  searchCount: 0,
  searchResults: null as ((event: { resultIndex: number; resultCount: number }) => void) | null,
  terminalOptions: null as Record<string, unknown> | null,
  selection: "",
  mouseTrackingMode: "none",
  onData: null as ((data: string) => void) | null,
  onTitle: null as ((title: string) => void) | null,
  parseWrite: null as (() => void) | null,
  deferWrites: false,
  pendingWrites: [] as Array<() => void>,
  resize: null as ((cols: number, rows: number) => void) | null,
  selectionChange: null as (() => void) | null,
  customKeyHandler: null as ((event: KeyboardEvent) => boolean) | null,
  reset() {
    this.initialCols = 100;
    this.fit.mockReset();
    this.focus.mockReset();
    this.onData = null;
    this.onTitle = null;
    this.parseWrite = null;
    this.deferWrites = false;
    this.pendingWrites = [];
    this.resize = null;
    this.selectionChange = null;
    this.customKeyHandler = null;
    this.oscHandlers = 0;
    this.osc.clear();
    this.prompt = "$ ";
    this.alternate = false;
    this.writes = [];
    this.pastes = [];
    this.searchNext.mockReset();
    this.searchPrevious.mockReset();
    this.searchCount = 0;
    this.searchResults = null;
    this.terminalOptions = null;
    this.selection = "";
    this.mouseTrackingMode = "none";
    channels.length = 0;
  },
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((message: ArrayBuffer) => void) | null = null;
    constructor() {
      channels.push(this);
    }
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    const listeners = nativeEvents.get(name) ?? new Set();
    listeners.add(handler);
    nativeEvents.set(name, listeners);
    return () => listeners.delete(handler);
  }),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {
      xterm.fit();
    }
  },
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    onDidChangeResults(listener: (event: { resultIndex: number; resultCount: number }) => void) {
      xterm.searchResults = listener;
      return { dispose: () => undefined };
    }
    findNext(term: string, options: unknown) {
      xterm.searchNext(term, options);
      xterm.searchResults?.({ resultIndex: 0, resultCount: xterm.searchCount });
      return xterm.searchCount > 0;
    }
    findPrevious(term: string, options: unknown) {
      xterm.searchPrevious(term, options);
      xterm.searchResults?.({ resultIndex: 0, resultCount: xterm.searchCount });
      return xterm.searchCount > 0;
    }
    clearDecorations() {}
    dispose() {}
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = xterm.initialCols;
    rows = 30;
    options: Record<string, unknown> = {};
    constructor(options: Record<string, unknown>) {
      xterm.terminalOptions = options;
      this.options = options;
    }
    parser = {
      registerOscHandler: (id: number, handler: (data: string) => boolean) => {
        xterm.oscHandlers += 1;
        xterm.osc.set(id, handler);
        return { dispose: () => undefined };
      },
    };
    loadAddon() {}
    open() {}
    onData(handler: (data: string) => void) {
      xterm.onData = handler;
      return { dispose: () => undefined };
    }
    onBinary() {
      return { dispose: () => undefined };
    }
    onTitleChange(handler: (title: string) => void) {
      xterm.onTitle = handler;
      return {
        dispose: () => {
          xterm.onTitle = null;
        },
      };
    }
    onResize(handler: (size: { cols: number; rows: number }) => void) {
      xterm.resize = (cols, rows) => {
        this.cols = cols;
        this.rows = rows;
        handler({ cols, rows });
      };
      return {
        dispose: () => {
          xterm.resize = null;
        },
      };
    }
    onSelectionChange(handler: () => void) {
      xterm.selectionChange = handler;
      return { dispose: () => undefined };
    }
    onBell() {
      return { dispose: () => undefined };
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      xterm.customKeyHandler = handler;
    }
    get modes() {
      return { mouseTrackingMode: xterm.mouseTrackingMode };
    }
    hasSelection() {
      return xterm.selection.length > 0;
    }
    getSelection() {
      return xterm.selection;
    }
    reset() {}
    resize(cols: number, rows: number) {
      xterm.resize?.(cols, rows);
    }
    get buffer() {
      return {
        active: {
          type: xterm.alternate ? "alternate" : "normal",
          cursorX: xterm.alternate ? 0 : xterm.prompt.length,
          cursorY: 0,
          baseY: 0,
          getLine: () => (xterm.alternate ? undefined : { translateToString: () => xterm.prompt }),
        },
      };
    }
    write(data: unknown, done?: () => void) {
      if (typeof data === "string") xterm.writes.push(data);
      const parse = () => {
        if (typeof data !== "string" || data.length > 0) xterm.parseWrite?.();
        done?.();
      };
      if (xterm.deferWrites) xterm.pendingWrites.push(parse);
      else parse();
    }
    paste(data: string) {
      xterm.pastes.push(data);
      const normalized = data.replace(/\r?\n/g, "\r");
      xterm.onData?.(`\u001b[200~${normalized}\u001b[201~`);
    }
    focus() {
      xterm.focus();
    }
    dispose() {}
  },
}));

import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";
import {
  createContainerWorkspace,
  createLocalWorkspace,
  createRemoteWorkspace,
} from "../lib/workspace-target";
import { TERMINAL_TITLE_DELAY_MS } from "../lib/terminal-title";
import type { AppSettings, ConnectionState, LocalShellProfile, SavedConnection } from "../types";

const settings: AppSettings = {
  automaticTerminalTitles: true,
  hostMetricsEnabled: false,
  hostMetrics: ["cpu", "ram", "gpu", "diskIo", "uptime"],
  hostMetricsIntervalSeconds: 5,
  terminalFontFamily: "Consolas",
  terminalFontSize: 14,
  terminalScrollback: 10_000,
  terminalForeground: "#f2f2ee",
  terminalRed: "#ff6f7d",
  terminalGreen: "#52cf91",
  terminalYellow: "#e8c56c",
  terminalBlue: "#55aef2",
  terminalMagenta: "#c793ff",
  terminalCyan: "#65d4d1",
  defaultLogTail: 200,
  globalHistoryEnabled: true,
  globalSudoEnabled: false,
  automaticUpdateChecks: true,
  hiddenLocalShells: [],
  localTerminalMode: false,
  defaultLocalShellId: null,
};

const shell: LocalShellProfile = {
  id: "powershell-7",
  label: "PowerShell 7",
  kind: "powershell-7",
  elevated: false,
};

const connection: SavedConnection = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "prod-web",
  destination: "prod-web",
  username: "deploy",
  port: null,
  identityFile: null,
  historyEnabled: true,
  sudoEnabled: false,
  groupId: null,
  tags: [],
  createdAt: "",
  updatedAt: "",
  lastConnectedAt: null,
};

function renderPane(
  workspace: ReturnType<typeof createLocalWorkspace> | ReturnType<typeof createRemoteWorkspace>,
  onState = vi.fn(),
  options: {
    ref?: Ref<TerminalPaneHandle>;
    onSelectionChange?: (hasSelection: boolean) => void;
    onProcessing?: (busy: boolean) => void;
    onTitle?: (title: string | null) => void;
    findRequest?: number;
    platform?: "windows" | "macos";
    onReconnect?: () => void;
    onSession?: (sessionId: string | null) => void;
  } = {},
) {
  render(
    <TerminalPane
      platform="windows"
      workspace={workspace}
      settings={settings}
      visible
      active
      onActivate={() => undefined}
      onSession={() => undefined}
      onState={onState}
      {...options}
    />,
  );
  return onState;
}

const clipboard = {
  readText: vi.fn(async () => ""),
  writeText: vi.fn(async () => undefined),
};

describe("TerminalPane sessions", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    nativeEvents.clear();
    xterm.reset();
    clipboard.readText.mockResolvedValue("");
    clipboard.writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
    global.ResizeObserver = class {
      observe() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    api.startSession.mockResolvedValue({ sessionId: "ssh-session" });
    api.startLocalSession.mockResolvedValue({ sessionId: "local-session" });
    api.closeSession.mockResolvedValue(undefined);
    api.writeSession.mockResolvedValue(undefined);
    api.acknowledgeSessionOutput.mockResolvedValue(undefined);
    api.resizeSession.mockResolvedValue(undefined);
  });

  it("starts a local Workspace through the local session API", async () => {
    const onState = renderPane(createLocalWorkspace(shell));

    await vi.waitFor(() =>
      expect(api.startLocalSession).toHaveBeenCalledWith(
        "powershell-7",
        100,
        30,
        expect.anything(),
      ),
    );
    expect(api.startSession).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onState).toHaveBeenCalledWith("connected", null));
  });

  it("starts a remote Workspace through the SSH session API and waits to be connected", async () => {
    const onState = renderPane(createRemoteWorkspace(connection));

    await vi.waitFor(() =>
      expect(api.startSession).toHaveBeenCalledWith(
        connection.id,
        100,
        30,
        expect.anything(),
        null,
        null,
      ),
    );
    expect(api.startLocalSession).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledWith("connecting", null);
    expect(onState).not.toHaveBeenCalledWith("connected", null);
  });

  it.each(["local", "remote"])(
    "resizes a running %s PTY when xterm's grid changes",
    async (kind) => {
      const sessionId = `${kind === "local" ? "local" : "ssh"}-session`;
      const onSession = vi.fn();
      renderPane(
        kind === "local" ? createLocalWorkspace(shell) : createRemoteWorkspace(connection),
        vi.fn(),
        { onSession },
      );
      await vi.waitFor(() => expect(onSession).toHaveBeenCalledWith(sessionId));
      act(() => xterm.resize!(80, 24));
      expect(api.resizeSession).toHaveBeenCalledWith(sessionId, 80, 24);
      cleanup();
      expect(xterm.resize).toBeNull();
    },
  );

  it("synchronizes a grid change during startup before releasing queued input", async () => {
    let finishStart!: (value: { sessionId: string }) => void;
    api.startLocalSession.mockReturnValueOnce(
      new Promise((resolve) => {
        finishStart = resolve;
      }),
    );
    renderPane(createLocalWorkspace(shell));
    await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalled());
    act(() => {
      xterm.resize!(80, 24);
      xterm.onData!("queued input");
    });
    expect(api.resizeSession).not.toHaveBeenCalled();
    await act(async () => finishStart({ sessionId: "local-session" }));
    expect(api.resizeSession).toHaveBeenCalledWith("local-session", 80, 24);
    expect(api.writeSession).toHaveBeenCalledWith(
      "local-session",
      new TextEncoder().encode("queued input"),
    );
    expect(api.resizeSession.mock.invocationCallOrder[0]).toBeLessThan(
      api.writeSession.mock.invocationCallOrder[0],
    );
  });

  it("starts a settled shell even when the webview stops delivering animation frames", async () => {
    const frames = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    try {
      renderPane(createLocalWorkspace(shell));
      await vi.waitFor(
        () =>
          expect(api.startLocalSession).toHaveBeenCalledWith(
            "powershell-7",
            100,
            30,
            expect.anything(),
          ),
        { timeout: 500 },
      );
      expect(api.startLocalSession).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
      frames.mockRestore();
    }
  });

  it("waits for the terminal font without waiting for unrelated page fonts", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(document, "fonts");
    let finishFont!: () => void;
    const load = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishFont = resolve;
        }),
    );
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load, ready: new Promise(() => undefined) },
    });
    try {
      renderPane(createLocalWorkspace(shell));
      await vi.waitFor(() => expect(load).toHaveBeenCalledWith("14px Consolas", "MW"));
      expect(api.startLocalSession).not.toHaveBeenCalled();
      await act(async () => finishFont());
      await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalledTimes(1));
    } finally {
      cleanup();
      if (descriptor) Object.defineProperty(document, "fonts", descriptor);
      else Reflect.deleteProperty(document, "fonts");
    }
  });

  it("starts with the smallest measured grid when font metrics keep alternating", async () => {
    let fits = 0;
    xterm.initialCols = 107;
    xterm.fit.mockImplementation(() => {
      if (xterm.resize) {
        fits++;
        xterm.resize(fits % 2 ? 106 : 107, fits % 2 ? 29 : 30);
      }
    });
    try {
      renderPane(createLocalWorkspace(shell));
      await vi.waitFor(() =>
        expect(api.startLocalSession).toHaveBeenCalledWith(
          "powershell-7",
          106,
          29,
          expect.anything(),
        ),
      );
      expect(api.startLocalSession).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it("settles the first rendered grid before starting a shell with width-dependent prompt output", async () => {
    xterm.initialCols = 107;
    xterm.fit.mockImplementation(() => xterm.resize?.(106, 30));
    renderPane(createLocalWorkspace(shell));
    await vi.waitFor(() =>
      expect(api.startLocalSession).toHaveBeenCalledWith(
        "powershell-7",
        106,
        30,
        expect.anything(),
      ),
    );
    expect(api.startLocalSession).toHaveBeenCalledTimes(1);
  });

  it("starts a host shell from the first fit and syncs the settled grid before queued input", async () => {
    let finishStart!: (value: { sessionId: string }) => void;
    api.startSession.mockReturnValueOnce(
      new Promise((resolve) => {
        finishStart = resolve;
      }),
    );
    let fitsAfterStart = 0;
    xterm.fit.mockImplementation(() => {
      const requested = api.startSession.mock.calls.length > 0;
      if (requested) fitsAfterStart++;
      xterm.resize?.(requested ? 100 : 106, requested ? 28 : 30);
    });
    renderPane(createRemoteWorkspace(connection));
    await vi.waitFor(() =>
      expect(api.startSession).toHaveBeenCalledWith(
        connection.id,
        106,
        30,
        expect.anything(),
        null,
        null,
      ),
    );
    act(() => xterm.onData!("queued input"));
    await vi.waitFor(() => expect(fitsAfterStart).toBeGreaterThanOrEqual(2));
    await act(async () => finishStart({ sessionId: "ssh-session" }));
    await vi.waitFor(() => expect(api.resizeSession).toHaveBeenCalledWith("ssh-session", 100, 28));
    await vi.waitFor(() => expect(api.writeSession).toHaveBeenCalled());
    expect(api.resizeSession.mock.invocationCallOrder[0]).toBeLessThan(
      api.writeSession.mock.invocationCallOrder[0],
    );
    expect(api.startSession).toHaveBeenCalledTimes(1);
  });

  it.each(["macos", "windows"] as const)(
    "starts a local %s shell at the settled grid so it never resizes after its first prompt",
    async (platform) => {
      let framed = false;
      const frames = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        window.setTimeout(() => {
          framed = true;
          callback(0);
        }, 0);
        return 1;
      });
      xterm.fit.mockImplementation(() => xterm.resize?.(framed ? 100 : 106, framed ? 28 : 30));
      try {
        renderPane(createLocalWorkspace(shell), vi.fn(), { platform });
        await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalledTimes(1));
        expect(api.startLocalSession).toHaveBeenCalledWith(
          "powershell-7",
          100,
          28,
          expect.anything(),
        );
        expect(api.resizeSession).not.toHaveBeenCalled();
      } finally {
        cleanup();
        frames.mockRestore();
      }
    },
  );

  it("closes a host session that started while the pane closed during its first fit", async () => {
    renderPane(createRemoteWorkspace(connection));
    await vi.waitFor(() => expect(api.startSession).toHaveBeenCalledTimes(1));
    cleanup();
    await vi.waitFor(() => expect(api.closeSession).toHaveBeenCalledWith("ssh-session"));
  });

  it.each([
    ["a Windows host shell waits for", "powershell", 100, 28],
    ["a macOS host shell starts before", "macos:zsh", 106, 30],
  ])("%s the settled grid", async (_, shellId, cols, rows) => {
    let framed = false;
    const frames = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      window.setTimeout(() => {
        framed = true;
        callback(0);
      }, 0);
      return 1;
    });
    xterm.fit.mockImplementation(() => xterm.resize?.(framed ? 100 : 106, framed ? 28 : 30));
    try {
      renderPane(createRemoteWorkspace(connection, { id: shellId, label: "Shell" }));
      await vi.waitFor(() => expect(api.startSession).toHaveBeenCalledTimes(1));
      expect(api.startSession).toHaveBeenCalledWith(
        connection.id,
        cols,
        rows,
        expect.anything(),
        shellId,
        null,
      );
    } finally {
      cleanup();
      frames.mockRestore();
    }
  });

  it("does not start a shell when the pane closes while its first grid is settling", async () => {
    renderPane(createLocalWorkspace(shell));
    cleanup();
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
    expect(api.startLocalSession).not.toHaveBeenCalled();
  });

  it("passes the selected WSL distribution on remote startup", async () => {
    renderPane(createRemoteWorkspace(connection, { id: "wsl:Ubuntu", label: "WSL: Ubuntu" }));
    await vi.waitFor(() =>
      expect(api.startSession).toHaveBeenCalledWith(
        connection.id,
        100,
        30,
        expect.anything(),
        "wsl:Ubuntu",
        null,
      ),
    );
  });

  it("starts a container terminal with only the container's ID", async () => {
    renderPane(
      createContainerWorkspace(connection, { id: "a".repeat(64), name: "web", image: "nginx" }),
    );
    await vi.waitFor(() =>
      expect(api.startSession).toHaveBeenCalledWith(
        connection.id,
        100,
        30,
        expect.anything(),
        null,
        "a".repeat(64),
      ),
    );
  });

  it("captures no command history for a local shell", async () => {
    renderPane(createLocalWorkspace(shell));
    await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalled());

    expect(xterm.oscHandlers).toBe(3);
    xterm.osc.get(633)?.("ControlRoom;start;0;L3RtcA==;cHdk");
    xterm.osc.get(633)?.("ControlRoom;finish;1;0;L3RtcA==");
    expect(api.addHistory).not.toHaveBeenCalled();

    cleanup();
    xterm.reset();
    renderPane(createRemoteWorkspace(connection));
    await vi.waitFor(() => expect(api.startSession).toHaveBeenCalled());
    expect(xterm.oscHandlers).toBe(3);
  });

  it.each(["local", "remote"])(
    "clears %s titles at command completion and disconnect, ignoring retired output",
    async (kind) => {
      const onTitle = vi.fn();
      const workspace =
        kind === "local" ? createLocalWorkspace(shell) : createRemoteWorkspace(connection);
      renderPane({ ...workspace, state: "connected" }, vi.fn(), { onTitle });
      await vi.waitFor(() =>
        expect(kind === "local" ? api.startLocalSession : api.startSession).toHaveBeenCalled(),
      );
      await act(async () => undefined);
      expect(xterm.onTitle).toBeNull();
      act(() => xterm.osc.get(633)?.("E;npm run dev --token private"));
      await vi.waitFor(() => expect(onTitle).toHaveBeenLastCalledWith("npm"));
      act(() => xterm.osc.get(133)?.("D;0"));
      expect(onTitle).toHaveBeenLastCalledWith(null);
      act(() => xterm.osc.get(633)?.("E;python private.py"));
      await vi.waitFor(() => expect(onTitle).toHaveBeenLastCalledWith("python"));
      act(() => xterm.osc.get(633)?.("E;vim secret.txt"));
      act(() =>
        nativeEvents.get("session-state-changed")?.forEach((listener) =>
          listener({
            payload: {
              sessionId: kind === "local" ? "local-session" : "ssh-session",
              state: "disconnected",
              reason: null,
            },
          }),
        ),
      );
      expect(onTitle).toHaveBeenLastCalledWith(null);
      xterm.parseWrite = () => xterm.osc.get(633)?.("E;vim secret.txt");
      act(() => channels[0].onmessage?.(new TextEncoder().encode("retired title").buffer));
      await act(() => new Promise((resolve) => setTimeout(resolve, TERMINAL_TITLE_DELAY_MS + 50)));
      expect(onTitle).toHaveBeenLastCalledWith(null);
      expect(onTitle).not.toHaveBeenCalledWith("vim");
    },
  );

  it("names each command typed at the prompt until the prompt returns", async () => {
    const onTitle = vi.fn();
    renderPane({ ...createLocalWorkspace(shell), state: "connected" }, vi.fn(), { onTitle });
    await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalled());
    for (const command of ["npm", "python"]) {
      act(() => xterm.onData?.(command));
      xterm.prompt = `$ ${command} --private secret`;
      act(() => xterm.onData?.("\r"));
      await vi.waitFor(() => expect(onTitle).toHaveBeenLastCalledWith(command));
      xterm.prompt = "$ ";
      act(() => channels[0].onmessage?.(new TextEncoder().encode("$ ").buffer));
      expect(onTitle).toHaveBeenLastCalledWith(null);
    }
  });

  it("reports command processing until the rendered prompt returns and clears on unmount", async () => {
    const onProcessing = vi.fn();
    renderPane({ ...createLocalWorkspace(shell), state: "connected" }, vi.fn(), { onProcessing });
    await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalled());
    await act(async () => {
      xterm.onData?.("sleep 60\r");
    });
    expect(onProcessing).toHaveBeenLastCalledWith(true);
    xterm.prompt = "";
    act(() => channels[0].onmessage?.(new TextEncoder().encode("working").buffer));
    expect(onProcessing).toHaveBeenLastCalledWith(true);
    xterm.prompt = "$ ";
    act(() => channels[0].onmessage?.(new TextEncoder().encode("$ ").buffer));
    expect(onProcessing).toHaveBeenLastCalledWith(false);
    act(() => {
      xterm.osc.get(133)?.("C");
    });
    expect(onProcessing).toHaveBeenLastCalledWith(true);
    cleanup();
    expect(onProcessing).toHaveBeenLastCalledWith(false);
  });

  it("stays idle while a coding agent waits on its own screen", async () => {
    const onProcessing = vi.fn();
    renderPane({ ...createLocalWorkspace(shell), state: "connected" }, vi.fn(), { onProcessing });
    await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalled());
    await act(async () => {
      xterm.onData?.("agent\r");
    });
    expect(onProcessing).toHaveBeenLastCalledWith(true);
    xterm.alternate = true;
    act(() => channels[0].onmessage?.(new TextEncoder().encode("Welcome").buffer));
    expect(onProcessing).toHaveBeenLastCalledWith(false);
    for (let frame = 0; frame < 5; frame++) {
      await act(async () => {
        xterm.onData?.("build the app");
      });
      act(() => channels[0].onmessage?.(new TextEncoder().encode("frame").buffer));
      expect(onProcessing).toHaveBeenLastCalledWith(false);
    }
    act(() => {
      xterm.osc.get(9)?.("4;3");
    });
    expect(onProcessing).toHaveBeenLastCalledWith(true);
    act(() => channels[0].onmessage?.(new TextEncoder().encode("frame").buffer));
    expect(onProcessing).toHaveBeenLastCalledWith(true);
    act(() => {
      xterm.osc.get(9)?.("4;0");
    });
    expect(onProcessing).toHaveBeenLastCalledWith(false);
  });
  it("ignores command markers arriving after a session has disconnected", async () => {
    const onProcessing = vi.fn();
    renderPane({ ...createLocalWorkspace(shell), state: "connected" }, vi.fn(), { onProcessing });
    await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalled());
    act(() => xterm.osc.get(133)?.("C"));
    expect(onProcessing).toHaveBeenLastCalledWith(true);
    act(() =>
      nativeEvents.get("session-state-changed")?.forEach((listener) =>
        listener({
          payload: { sessionId: "local-session", state: "disconnected", reason: null },
        }),
      ),
    );
    expect(onProcessing).toHaveBeenLastCalledWith(false);
    xterm.parseWrite = () => {
      xterm.osc.get(133)?.("C");
      xterm.osc.get(9)?.("4;3");
    };
    act(() => channels[0].onmessage?.(new TextEncoder().encode("\x1b]133;C\x07").buffer));
    expect(onProcessing).toHaveBeenLastCalledWith(false);
  });

  it("drains old buffered markers before starting a replacement session", async () => {
    const onProcessing = vi.fn();
    const workspace = { ...createLocalWorkspace(shell), state: "connected" as const };
    const pane = (reconnectToken: number) => (
      <TerminalPane
        platform="windows"
        workspace={{ ...workspace, reconnectToken }}
        settings={settings}
        visible
        active
        onActivate={() => undefined}
        onSession={() => undefined}
        onState={() => undefined}
        onProcessing={onProcessing}
      />
    );
    const view = render(pane(0));
    await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    xterm.deferWrites = true;
    xterm.parseWrite = () => xterm.osc.get(133)?.("C");
    act(() => channels[0].onmessage?.(new TextEncoder().encode("old command marker").buffer));
    view.rerender(pane(1));
    await act(async () => undefined);
    act(() => xterm.pendingWrites.shift()?.());
    expect(onProcessing).not.toHaveBeenLastCalledWith(true);
    await act(async () => {
      while (xterm.pendingWrites.length) xterm.pendingWrites.shift()?.();
    });
    await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalledTimes(2));
    xterm.deferWrites = false;
    act(() => channels.at(-1)?.onmessage?.(new TextEncoder().encode("new command marker").buffer));
    expect(onProcessing).toHaveBeenLastCalledWith(true);
  });

  it("does not start a restored Workspace of either kind", async () => {
    const local = {
      ...createLocalWorkspace(shell),
      connectRequested: false,
      state: "disconnected",
      restored: true,
    } as const;
    renderPane(local);
    expect(document.querySelector(".terminal-toolbar")).toBeNull();
    cleanup();
    renderPane({
      ...createRemoteWorkspace(connection),
      connectRequested: false,
      state: "disconnected",
      restored: true,
    });
    expect(document.querySelector(".terminal-toolbar")).toBeNull();

    await Promise.resolve();
    expect(api.startLocalSession).not.toHaveBeenCalled();
    expect(api.startSession).not.toHaveBeenCalled();
  });

  it("hides a concealed session behind a connecting status until the host is known to run it", async () => {
    const workspace = {
      ...createRemoteWorkspace(connection),
      state: "error" as const,
      reason: "SSH session ended.",
    };
    const pane = (concealed: boolean, reconnectToken = 0) => (
      <TerminalPane
        platform="windows"
        workspace={{ ...workspace, reconnectToken }}
        settings={settings}
        visible
        active
        concealed={concealed}
        onActivate={() => undefined}
        onSession={() => undefined}
        onState={() => undefined}
      />
    );
    const { rerender } = render(pane(true));
    await vi.waitFor(() => expect(api.startSession).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status").textContent).toBe("Connecting…");
    expect(screen.queryByText("SSH session ended.")).toBeNull();
    expect(document.querySelector(".terminal-pane")?.classList).toContain("terminal-concealed");

    rerender(pane(true, 1));
    await vi.waitFor(() => expect(api.startSession).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("status").textContent).toBe("Connecting…");

    xterm.focus.mockClear();
    rerender(pane(false, 1));
    expect(screen.queryByText("Connecting…")).toBeNull();
    expect(screen.getByText("SSH session ended.")).toBeTruthy();
    expect(xterm.focus).toHaveBeenCalled();
  });

  it("keeps session errors visible without a redundant status row", () => {
    const running = (state: ConnectionState) => ({ ...createLocalWorkspace(shell), state });

    renderPane({ ...running("connected"), sessionId: "local-session" });
    expect(screen.queryByText("running")).toBeNull();
    expect(document.querySelector(".terminal-toolbar")).toBeNull();
    cleanup();

    renderPane({
      ...running("disconnected"),
      connectRequested: false,
      reason: "PowerShell 7 exited.",
    });
    expect(screen.queryByText("stopped")).toBeNull();
    expect(screen.getByText("PowerShell 7 exited.")).toBeTruthy();
    cleanup();

    renderPane({ ...createRemoteWorkspace(connection), state: "connected", sessionId: "ssh" });
    expect(screen.queryByText("connected")).toBeNull();
  });

  describe("right click", () => {
    function terminalContainer(): HTMLElement {
      const container = document.querySelector(".terminal-container");
      if (!container) throw new Error("terminal container was not rendered");
      return container as HTMLElement;
    }

    function rightClick(container: HTMLElement) {
      const down = new MouseEvent("mousedown", { button: 2, bubbles: true, cancelable: true });
      container.dispatchEvent(down);
      const menu = new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true });
      container.dispatchEvent(menu);
      return { down, menu };
    }

    async function openTerminal() {
      renderPane({
        ...createLocalWorkspace(shell),
        state: "connected",
        sessionId: "local-session",
      });
      await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalled());
      api.writeSession.mockClear();
      return terminalContainer();
    }

    it("copies the selection and pastes nothing", async () => {
      xterm.selection = "hello";
      const container = await openTerminal();

      const { down, menu } = rightClick(container);

      expect(clipboard.writeText).toHaveBeenCalledWith("hello");
      expect(clipboard.readText).not.toHaveBeenCalled();
      expect(api.writeSession).not.toHaveBeenCalled();
      expect(menu.defaultPrevented).toBe(true);
      expect(down.defaultPrevented).toBe(true);
    });

    it("pastes the clipboard into the pty at an ordinary prompt", async () => {
      clipboard.readText.mockResolvedValue("ls -la");
      const container = await openTerminal();

      const { menu } = rightClick(container);

      await vi.waitFor(() =>
        expect(api.writeSession).toHaveBeenCalledWith("local-session", expect.anything()),
      );
      const [, bytes] = api.writeSession.mock.calls[0];
      expect(xterm.pastes).toEqual(["ls -la"]);
      expect(new TextDecoder().decode(bytes as Uint8Array)).toBe("\u001b[200~ls -la\u001b[201~");
      expect(clipboard.writeText).not.toHaveBeenCalled();
      expect(menu.defaultPrevented).toBe(true);
    });

    it("says a refused paste was denied and lets the notice be dismissed", async () => {
      clipboard.readText.mockRejectedValue(
        new DOMException(
          "Failed to execute 'readText' on 'Clipboard': Read permission denied.",
          "NotAllowedError",
        ),
      );
      const container = await openTerminal();

      rightClick(container);

      const notice = await screen.findByRole("alert");
      expect(notice.textContent).toBe("Could not paste: clipboard access was denied.");
      expect(notice.dataset.tone).toBe("error");
      fireEvent.click(screen.getByRole("button", { name: "Dismiss terminal notice" }));
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("leaves the click to a program that reads the mouse", async () => {
      xterm.mouseTrackingMode = "any";
      const container = await openTerminal();

      const { down, menu } = rightClick(container);

      expect(clipboard.readText).not.toHaveBeenCalled();
      expect(clipboard.writeText).not.toHaveBeenCalled();
      expect(api.writeSession).not.toHaveBeenCalled();
      expect(menu.defaultPrevented).toBe(true);
      expect(down.defaultPrevented).toBe(false);
    });

    it("still copies a selection made while a program reads the mouse", async () => {
      xterm.selection = "chosen";
      xterm.mouseTrackingMode = "any";
      const container = await openTerminal();

      const { menu } = rightClick(container);

      expect(clipboard.writeText).toHaveBeenCalledWith("chosen");
      expect(clipboard.readText).not.toHaveBeenCalled();
      expect(menu.defaultPrevented).toBe(true);
    });

    it("never lets the webview menu open from a pointer right click", async () => {
      for (const state of [
        { selection: "text", mouseTrackingMode: "none" },
        { selection: "", mouseTrackingMode: "none" },
        { selection: "", mouseTrackingMode: "any" },
      ]) {
        xterm.selection = state.selection;
        xterm.mouseTrackingMode = state.mouseTrackingMode;
        const container = await openTerminal();
        expect(rightClick(container).menu.defaultPrevented).toBe(true);
        cleanup();
        vi.clearAllMocks();
      }
    });

    it("leaves a context menu the keyboard raised alone", async () => {
      const container = await openTerminal();

      const menu = new MouseEvent("contextmenu", { button: 0, bubbles: true, cancelable: true });
      container.dispatchEvent(menu);

      expect(menu.defaultPrevented).toBe(false);
      expect(clipboard.readText).not.toHaveBeenCalled();
      expect(clipboard.writeText).not.toHaveBeenCalled();
    });
  });

  function writtenText(): string[] {
    return api.writeSession.mock.calls.map(([, bytes]) =>
      new TextDecoder().decode(bytes as Uint8Array),
    );
  }

  it("delivers input typed during the pending drain after the input it queued", async () => {
    let startSession: (started: { sessionId: string }) => void = () => {};
    api.startSession.mockImplementation(
      () => new Promise((resolve) => (startSession = resolve as typeof startSession)),
    );
    const writes: Array<() => void> = [];
    api.writeSession.mockImplementation(
      () => new Promise<void>((resolve) => writes.push(() => resolve())),
    );

    renderPane(createRemoteWorkspace(connection));
    await vi.waitFor(() => expect(xterm.onData).toBeTruthy());

    xterm.onData?.("a");
    xterm.onData?.("b");
    expect(api.writeSession).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(api.startSession).toHaveBeenCalled());
    startSession({ sessionId: "session-1" });
    await vi.waitFor(() => expect(api.writeSession).toHaveBeenCalled());

    xterm.onData?.("z");
    for (const resolve of [...writes]) resolve();
    await vi.waitFor(() => expect(writtenText().length).toBe(3));

    expect(writtenText()).toEqual(["a", "b", "z"]);
  });

  it("sends terminal input as its exact UTF-8 bytes", async () => {
    api.startSession.mockResolvedValue({ sessionId: "session-1" });
    api.writeSession.mockResolvedValue(undefined);
    renderPane(createRemoteWorkspace(connection));
    await vi.waitFor(() => expect(api.startSession).toHaveBeenCalled());
    await vi.waitFor(() => expect(xterm.onData).toBeTruthy());

    const typed = ["a", "\r", "\n", "", "[A", "é", "→", "🙂", " "];
    for (const data of typed) xterm.onData?.(data);
    await vi.waitFor(() => expect(api.writeSession).toHaveBeenCalledTimes(typed.length));

    expect(writtenText()).toEqual(typed);
    const emoji = api.writeSession.mock.calls.at(-2)?.[1] as Uint8Array;
    expect(Array.from(emoji)).toEqual([0xf0, 0x9f, 0x99, 0x82]);
  });

  it("sends a large paste as a single write", async () => {
    const pasted = "echo ".concat("x".repeat(20_000), "\r");
    clipboard.readText.mockResolvedValue(pasted);
    api.startSession.mockResolvedValue({ sessionId: "session-1" });
    api.writeSession.mockResolvedValue(undefined);
    renderPane(createRemoteWorkspace(connection));
    await vi.waitFor(() => expect(api.startSession).toHaveBeenCalled());

    const container = document.querySelector(".terminal-container") as HTMLElement;
    container.dispatchEvent(new MouseEvent("mousedown", { button: 2, bubbles: true }));
    container.dispatchEvent(
      new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(api.writeSession).toHaveBeenCalledTimes(1));
    expect(xterm.pastes).toEqual([pasted]);
    expect(writtenText()).toEqual([`\u001b[200~${pasted}\u001b[201~`]);
  });

  it("routes multiline right-click paste through xterm's bracketed paste handling", async () => {
    const pasted = "echo first\r\necho second";
    clipboard.readText.mockResolvedValue(pasted);
    api.startSession.mockResolvedValue({ sessionId: "session-1" });
    api.writeSession.mockResolvedValue(undefined);
    renderPane(createRemoteWorkspace(connection));
    await vi.waitFor(() => expect(api.startSession).toHaveBeenCalled());

    const container = document.querySelector(".terminal-container") as HTMLElement;
    container.dispatchEvent(new MouseEvent("mousedown", { button: 2, bubbles: true }));
    container.dispatchEvent(
      new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true }),
    );

    await vi.waitFor(() => expect(clipboard.readText).toHaveBeenCalledTimes(1));
    expect(xterm.pastes).toEqual([pasted]);
    await vi.waitFor(() => expect(api.writeSession).toHaveBeenCalledTimes(1));
    expect(writtenText()).toEqual(["\u001b[200~echo first\recho second\u001b[201~"]);
  });

  it("leaves Ctrl+Shift+V to xterm's single native paste path", async () => {
    clipboard.readText.mockResolvedValue("echo once");
    api.startSession.mockResolvedValue({ sessionId: "session-1" });
    api.writeSession.mockResolvedValue(undefined);
    renderPane(createRemoteWorkspace(connection));
    await vi.waitFor(() => expect(xterm.customKeyHandler).toBeTruthy());

    const handledByXterm = xterm.customKeyHandler?.(
      new KeyboardEvent("keydown", {
        key: "v",
        ctrlKey: true,
        shiftKey: true,
      }),
    );

    expect(handledByXterm).toBe(true);
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(api.writeSession).not.toHaveBeenCalled();

    xterm.onData?.("echo once");
    await vi.waitFor(() => expect(api.writeSession).toHaveBeenCalledTimes(1));
    expect(writtenText()).toEqual(["echo once"]);
  });

  it("uses Command shortcuts on macOS while leaving Control input to the shell", async () => {
    api.startSession.mockResolvedValue({ sessionId: "session-mac" });
    renderPane(createRemoteWorkspace(connection), vi.fn(), { platform: "macos" });
    await vi.waitFor(() => expect(xterm.customKeyHandler).toBeTruthy());
    for (const key of ["t", "w", "r", "p", "f"]) {
      expect(
        xterm.customKeyHandler?.(
          new KeyboardEvent("keydown", { key, metaKey: true, shiftKey: true }),
        ),
      ).toBe(false);
      expect(
        xterm.customKeyHandler?.(
          new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey: true }),
        ),
      ).toBe(true);
    }
    xterm.selection = "Mac selection";
    expect(
      xterm.customKeyHandler?.(
        new KeyboardEvent("keydown", { key: "c", metaKey: true, shiftKey: true }),
      ),
    ).toBe(false);
    expect(clipboard.writeText).toHaveBeenCalledWith("Mac selection");
    expect(
      xterm.customKeyHandler?.(new KeyboardEvent("keydown", { key: "v", metaKey: true })),
    ).toBe(true);
    expect(clipboard.readText).not.toHaveBeenCalled();
  });

  it("ends a cleanly exited SSH session with a calm notice and Reconnect", () => {
    const onReconnect = vi.fn();
    renderPane(
      {
        ...createRemoteWorkspace(connection),
        state: "disconnected",
        connectRequested: false,
        reason: "SSH session ended.",
      },
      vi.fn(),
      { onReconnect },
    );

    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("SSH session ended.");
    expect(notice.getAttribute("data-tone")).toBe("neutral");
    screen.getByRole("button", { name: "Reconnect" }).click();
    expect(onReconnect).toHaveBeenCalledTimes(1);
    cleanup();

    renderPane({
      ...createRemoteWorkspace(connection),
      state: "error",
      connectRequested: false,
      reason: "SSH connection was lost (exit code 255)",
    });
    expect(screen.getByRole("alert").getAttribute("data-tone")).toBe("error");
  });

  it("keeps the original connection failure when input is attempted", () => {
    renderPane({
      ...createRemoteWorkspace(connection),
      state: "error",
      connectRequested: false,
      reason: "Connection refused by prod-web.",
    });

    xterm.onData?.("x");

    expect(screen.getByText("Connection refused by prod-web.")).toBeTruthy();
    expect(screen.queryByText("Reconnect before sending terminal input.")).toBeNull();
  });

  it("exposes copy and paste to the shared tab controls", async () => {
    api.writeSession.mockResolvedValue(undefined);
    clipboard.readText.mockResolvedValue("echo ready");
    const ref = createRef<TerminalPaneHandle>();
    const onSelectionChange = vi.fn();
    renderPane(
      { ...createLocalWorkspace(shell), state: "connected", sessionId: "local-session" },
      vi.fn(),
      { ref, onSelectionChange },
    );
    await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalled());

    expect(ref.current).not.toBeNull();
    expect(onSelectionChange).toHaveBeenCalledWith(false);
    xterm.selection = "selected text";
    act(() => xterm.selectionChange?.());
    expect(onSelectionChange).toHaveBeenLastCalledWith(true);
    act(() => ref.current?.copySelection());
    expect(clipboard.writeText).toHaveBeenCalledWith("selected text");

    act(() => ref.current?.pasteClipboard());
    await vi.waitFor(() => expect(api.writeSession).toHaveBeenCalled());
    expect(xterm.pastes).toEqual(["echo ready"]);
    expect(document.querySelector(".terminal-toolbar")).toBeNull();
  });

  it("steps back with Shift+Enter and disables stepping when nothing matches", async () => {
    renderPane(
      { ...createLocalWorkspace(shell), state: "connected", sessionId: "local-session" },
      vi.fn(),
      { findRequest: 1 },
    );
    await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalled());
    const input = screen.getByRole("textbox", { name: "Find in terminal output" });
    const previous = () => screen.getByRole("button", { name: "Previous match" });

    fireEvent.change(input, { target: { value: "panic" } });
    await vi.waitFor(() => expect(screen.getByText("No matches")).toBeTruthy());
    expect(previous()).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Next match" })).toHaveProperty("disabled", true);

    xterm.searchCount = 3;
    fireEvent.change(input, { target: { value: "worker" } });
    await vi.waitFor(() => expect(screen.getByText("1 of 3")).toBeTruthy());
    expect(previous()).toHaveProperty("disabled", false);
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(xterm.searchPrevious).toHaveBeenLastCalledWith("worker", expect.anything());
  });

  it("keeps search results legible without covering terminal colors", async () => {
    renderPane(
      { ...createLocalWorkspace(shell), state: "connected", sessionId: "local-session" },
      vi.fn(),
      { findRequest: 1 },
    );
    await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalled());

    expect(document.querySelector(".terminal-search")?.parentElement).toHaveProperty(
      "className",
      "terminal-content",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Find in terminal output" }), {
      target: { value: "needle" },
    });

    await vi.waitFor(() => expect(xterm.searchNext).toHaveBeenCalled());
    expect(xterm.terminalOptions).toMatchObject({ allowProposedApi: true });
    expect(xterm.terminalOptions).toMatchObject({
      overviewRuler: { width: 8, showTopBorder: false, showBottomBorder: false },
    });
    expect(xterm.searchNext).toHaveBeenLastCalledWith(
      "needle",
      expect.objectContaining({
        incremental: true,
        decorations: expect.objectContaining({
          matchBorder: "#92928e",
          activeMatchBorder: "#f2f2ee",
          matchOverviewRuler: "#92928e",
          activeMatchColorOverviewRuler: "#f2f2ee",
        }),
      }),
    );
    const searchOptions = xterm.searchNext.mock.calls.at(-1)?.[1] as {
      decorations: Record<string, unknown>;
    };
    expect(searchOptions.decorations).not.toHaveProperty("matchBackground");
    expect(searchOptions.decorations).not.toHaveProperty("activeMatchBackground");
    expect((xterm.terminalOptions?.theme as Record<string, unknown>)?.selectionBackground).toBe(
      "transparent",
    );

    fireEvent.click(screen.getByRole("button", { name: "Close terminal search" }));
    expect((xterm.terminalOptions?.theme as Record<string, unknown>)?.selectionBackground).toBe(
      "#393939",
    );
  });

  it("draws bold output at regular weight in the configured colors", async () => {
    renderPane({ ...createLocalWorkspace(shell), state: "connected", sessionId: "local-session" });
    await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalled());

    expect(xterm.terminalOptions).toMatchObject({
      fontWeightBold: "normal",
      drawBoldTextInBrightColors: false,
      theme: expect.objectContaining({
        red: settings.terminalRed,
        brightRed: settings.terminalRed,
      }),
    });
  });

  it("reports output that arrives in a background terminal", async () => {
    const onActivity = vi.fn();
    render(
      <TerminalPane
        platform="windows"
        workspace={createLocalWorkspace(shell)}
        settings={settings}
        visible={false}
        active={false}
        onActivate={() => undefined}
        onSession={() => undefined}
        onState={() => undefined}
        onActivity={onActivity}
      />,
    );
    await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalled());

    channels[0]?.onmessage?.(new TextEncoder().encode("background output").buffer);

    expect(onActivity).toHaveBeenCalledWith("output");
  });

  it("focuses on becoming active but never takes focus from an open popover", () => {
    const workspace = createLocalWorkspace(shell);
    const props = {
      platform: "windows" as const,
      workspace,
      settings,
      visible: true,
      onActivate: () => undefined,
      onSession: () => undefined,
      onState: () => undefined,
    };
    const popover = document.createElement("button");
    popover.setAttribute("data-app-popover", "");
    document.body.append(popover);
    const { rerender } = render(<TerminalPane {...props} active={false} />);

    popover.focus();
    rerender(<TerminalPane {...props} active />);
    expect(xterm.focus).not.toHaveBeenCalled();

    rerender(<TerminalPane {...props} active={false} />);
    popover.blur();
    rerender(<TerminalPane {...props} active />);
    expect(xterm.focus).toHaveBeenCalledTimes(1);

    rerender(<TerminalPane {...props} active settings={{ ...settings }} />);
    expect(xterm.focus).toHaveBeenCalledTimes(1);
    popover.remove();
  });

  it("still closes its session when the pane goes away", async () => {
    renderPane({ ...createLocalWorkspace(shell), state: "connected", sessionId: "local-session" });
    await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalled());

    cleanup();

    await vi.waitFor(() => expect(api.closeSession).toHaveBeenCalledWith("local-session"));
    expect(api.closeSession).toHaveBeenCalledTimes(1);
  });
});
