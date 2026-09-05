// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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

/// Records what the pane asked of xterm, so the test can see which handlers a
/// session installs without rendering a real terminal.
const xterm = vi.hoisted(() => ({
  oscHandlers: 0,
  clears: 0,
  writes: [] as string[],
  reset() {
    this.oscHandlers = 0;
    this.clears = 0;
    this.writes = [];
  },
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((message: ArrayBuffer) => void) | null = null;
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 100;
    rows = 30;
    options: Record<string, unknown> = {};
    parser = {
      registerOscHandler: () => {
        xterm.oscHandlers += 1;
        return { dispose: () => undefined };
      },
    };
    loadAddon() {}
    open() {}
    onData() {
      return { dispose: () => undefined };
    }
    onBinary() {
      return { dispose: () => undefined };
    }
    attachCustomKeyEventHandler() {}
    hasSelection() {
      return false;
    }
    getSelection() {
      return "";
    }
    reset() {}
    clear() {
      xterm.clears += 1;
    }
    write(data: unknown) {
      if (typeof data === "string") xterm.writes.push(data);
    }
    focus() {}
    dispose() {}
  },
}));

import { TerminalPane } from "./TerminalPane";
import { createLocalWorkspace, createRemoteWorkspace } from "../lib/workspace-target";
import type { AppSettings, ConnectionState, LocalShellProfile, SavedConnection } from "../types";

const settings: AppSettings = {
  terminalFontFamily: "Consolas",
  terminalFontSize: 14,
  terminalScrollback: 10_000,
  terminalRightClickPaste: false,
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
};

const shell: LocalShellProfile = {
  id: "powershell-7",
  label: "PowerShell 7",
  kind: "powershell-7",
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
) {
  render(
    <TerminalPane
      workspace={workspace}
      settings={settings}
      visible
      active
      onActivate={() => undefined}
      onSession={() => undefined}
      onState={onState}
      onReconnect={() => undefined}
    />,
  );
  return onState;
}

describe("TerminalPane sessions", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    xterm.reset();
    global.ResizeObserver = class {
      observe() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    api.startSession.mockResolvedValue({ sessionId: "ssh-session" });
    api.startLocalSession.mockResolvedValue({ sessionId: "local-session" });
    api.closeSession.mockResolvedValue(undefined);
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
    // A spawned shell is running; there is no authentication to wait for.
    await vi.waitFor(() => expect(onState).toHaveBeenCalledWith("connected", null));
  });

  it("starts a remote Workspace through the SSH session API and waits to be connected", async () => {
    const onState = renderPane(createRemoteWorkspace(connection));

    await vi.waitFor(() =>
      expect(api.startSession).toHaveBeenCalledWith(connection.id, 100, 30, expect.anything()),
    );
    expect(api.startLocalSession).not.toHaveBeenCalled();
    // The connected marker comes from the remote shell, not from the start call.
    expect(onState).toHaveBeenCalledWith("connecting", null);
    expect(onState).not.toHaveBeenCalledWith("connected", null);
  });

  it("captures no command history for a local shell", async () => {
    renderPane(createLocalWorkspace(shell));
    await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalled());

    // Enhanced History is remote and Bash-only, so a local session installs no
    // shell integration handler to record from.
    expect(xterm.oscHandlers).toBe(0);
    expect(api.addHistory).not.toHaveBeenCalled();

    cleanup();
    xterm.reset();
    renderPane(createRemoteWorkspace(connection));
    await vi.waitFor(() => expect(api.startSession).toHaveBeenCalled());
    expect(xterm.oscHandlers).toBe(1);
  });

  it("does not start a restored Workspace of either kind", async () => {
    const local = { ...createLocalWorkspace(shell), connectRequested: false } as const;
    renderPane(local);
    cleanup();
    renderPane({ ...createRemoteWorkspace(connection), connectRequested: false });

    await Promise.resolve();
    expect(api.startLocalSession).not.toHaveBeenCalled();
    expect(api.startSession).not.toHaveBeenCalled();
  });

  it("says a local shell runs and stops, and a remote session connects", () => {
    const running = (state: ConnectionState) => ({ ...createLocalWorkspace(shell), state });

    renderPane({ ...running("connected"), sessionId: "local-session" });
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stop/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Disconnect/ })).toBeNull();
    cleanup();

    // An exited shell keeps its Workspace, reports the exit, and offers Restart.
    renderPane({
      ...running("disconnected"),
      connectRequested: false,
      reason: "PowerShell 7 exited.",
    });
    expect(screen.getByText("stopped")).toBeTruthy();
    expect(screen.getByText("PowerShell 7 exited.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Restart/ })).toBeTruthy();
    cleanup();

    renderPane({ ...createRemoteWorkspace(connection), state: "connected", sessionId: "ssh" });
    expect(screen.getByText("connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Disconnect/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  });

  it("clears without erasing the prompt line or touching the shell", async () => {
    renderPane({ ...createLocalWorkspace(shell), state: "connected", sessionId: "local-session" });
    await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalled());

    screen.getByRole("button", { name: /Clear/ }).click();

    // Clearing around the cursor keeps the prompt on screen; erasing the
    // display would leave the pane blank until the next keystroke.
    expect(xterm.clears).toBe(1);
    expect(xterm.writes).toEqual([]);
    expect(api.writeSession).not.toHaveBeenCalled();
  });

  it("stops only its own session", async () => {
    renderPane({ ...createLocalWorkspace(shell), state: "connected", sessionId: "local-session" });
    await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalled());

    screen.getByRole("button", { name: /Stop/ }).click();

    await vi.waitFor(() => expect(api.closeSession).toHaveBeenCalledWith("local-session"));
    expect(api.closeSession).toHaveBeenCalledTimes(1);
  });
});
