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
  // Drives the right-click policy: what is selected, and whether the program in
  // the pty asked for the mouse.
  selection: "",
  mouseTrackingMode: "none",
  reset() {
    this.oscHandlers = 0;
    this.clears = 0;
    this.writes = [];
    this.selection = "";
    this.mouseTrackingMode = "none";
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

const clipboard = {
  readText: vi.fn(async () => ""),
  writeText: vi.fn(async () => undefined),
};

describe("TerminalPane sessions", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  describe("right click", () => {
    /** The pane attaches its handlers to the container xterm was opened into. */
    function terminalContainer(): HTMLElement {
      const container = document.querySelector(".terminal-container");
      if (!container) throw new Error("terminal container was not rendered");
      return container as HTMLElement;
    }

    function rightClick(container: HTMLElement) {
      // The real gesture is a mousedown first, then contextmenu. xterm reports
      // the mouse to the program on the mousedown, so the order matters.
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
      // The click that copies must not also reach the program in the pty, or a
      // copy inside tmux would open tmux's own menu at the same time.
      expect(down.defaultPrevented).toBe(true);
    });

    it("pastes the clipboard into the pty at an ordinary prompt", async () => {
      clipboard.readText.mockResolvedValue("ls -la");
      const container = await openTerminal();

      const { menu } = rightClick(container);

      await vi.waitFor(() =>
        expect(api.writeSession).toHaveBeenCalledWith("local-session", expect.anything()),
      );
      // Through the session, not written into the screen buffer.
      const [, bytes] = api.writeSession.mock.calls[0];
      expect(new TextDecoder().decode(bytes as Uint8Array)).toBe("ls -la");
      expect(clipboard.writeText).not.toHaveBeenCalled();
      expect(menu.defaultPrevented).toBe(true);
    });

    it("leaves the click to a program that reads the mouse", async () => {
      xterm.mouseTrackingMode = "any";
      const container = await openTerminal();

      const { down, menu } = rightClick(container);

      expect(clipboard.readText).not.toHaveBeenCalled();
      expect(clipboard.writeText).not.toHaveBeenCalled();
      expect(api.writeSession).not.toHaveBeenCalled();
      // The menu is still suppressed, which is the whole point: declining the
      // clipboard must not hand the gesture back to the webview.
      expect(menu.defaultPrevented).toBe(true);
      // xterm still gets the mousedown, so Vim or tmux receives its click.
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
      // The reported bug: with the old setting off, right-click fell through to
      // the webview's own Cut/Copy/Paste menu. Every path prevents it now, and
      // none of it depends on a preference.
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
      // The menu key and Shift+F10 raise contextmenu with no button behind it.
      // Suppressing those would remove a keyboard route for no reason.
      const container = await openTerminal();

      const menu = new MouseEvent("contextmenu", { button: 0, bubbles: true, cancelable: true });
      container.dispatchEvent(menu);

      expect(menu.defaultPrevented).toBe(false);
      expect(clipboard.readText).not.toHaveBeenCalled();
      expect(clipboard.writeText).not.toHaveBeenCalled();
    });
  });

  it("gives a running terminal nothing to press", async () => {
    renderPane({ ...createLocalWorkspace(shell), state: "connected", sessionId: "local-session" });
    await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalled());

    // Clearing is what the shell's own `clear` is for, and closing the
    // Workspace is what stops a session. Neither needed a button here.
    expect(screen.queryByRole("button", { name: /Clear/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Disconnect/ })).toBeNull();
    // Recovery is the one control that earns its place, and only once the
    // session has actually ended.
    expect(screen.queryByRole("button", { name: /Restart/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reconnect/ })).toBeNull();
  });

  it("still closes its session when the pane goes away", async () => {
    // Removing the Stop button must not remove the shutdown it used to reach.
    // Unmounting is what a closing Workspace does to this pane.
    renderPane({ ...createLocalWorkspace(shell), state: "connected", sessionId: "local-session" });
    await vi.waitFor(() => expect(api.startLocalSession).toHaveBeenCalled());

    cleanup();

    await vi.waitFor(() => expect(api.closeSession).toHaveBeenCalledWith("local-session"));
    expect(api.closeSession).toHaveBeenCalledTimes(1);
  });
});
