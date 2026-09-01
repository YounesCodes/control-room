// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listConnections: vi.fn(),
  settingsContract: vi.fn(),
  environment: vi.fn(),
  workspaceState: vi.fn(),
  listConnectionGroups: vi.fn(),
  listConnectionTags: vi.fn(),
  saveWorkspaceState: vi.fn(),
  cachedCapabilities: vi.fn(),
  deleteConnection: vi.fn(),
  deleteScratchpadNote: vi.fn(),
  scratchpadNote: vi.fn(),
  saveScratchpadNote: vi.fn(),
  closeSession: vi.fn(),
}));

vi.mock("./lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock("./components/WindowControls", () => ({
  WindowControls: () => <div data-testid="window-controls" />,
}));

vi.mock("./components/TerminalPane", () => ({
  TerminalPane: ({ workspace }: { workspace: { id: string; reconnectToken: number } }) => (
    <div data-testid={`terminal-${workspace.id}`} data-reconnect-token={workspace.reconnectToken} />
  ),
}));

import { App } from "./App";
import type { AppSettings, PersistedWorkspaceState, SavedConnection } from "./types";

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
};

function connection(id: string, displayName: string): SavedConnection {
  return {
    id,
    displayName,
    destination: id,
    username: "user",
    port: null,
    identityFile: null,
    historyEnabled: false,
    groupId: null,
    tags: [],
    createdAt: "",
    updatedAt: "",
    lastConnectedAt: null,
  };
}

function restoredState(connectionIds: string[]): PersistedWorkspaceState {
  return {
    workspaces: connectionIds.map((connectionId, index) => ({
      id: `workspace-${index}`,
      label: null,
      connectionId,
      view: "terminal",
      historyPaused: false,
    })),
    activeWorkspaceId: connectionIds.length ? "workspace-0" : null,
    terminalLayout: connectionIds.length ? { kind: "leaf", workspaceId: "workspace-0" } : null,
  };
}

describe("App Workspace behavior", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    api.listConnections.mockResolvedValue([]);
    api.settingsContract.mockResolvedValue({
      current: settings,
      defaults: settings,
      logTailOptions: [50, 100, 200, 500, 1000],
    });
    api.environment.mockResolvedValue({
      sshPath: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
      sshConfigPath: "C:\\Users\\test\\.ssh\\config",
      sshAgentAvailable: true,
      platformSupported: true,
    });
    api.workspaceState.mockResolvedValue(restoredState([]));
    api.listConnectionGroups.mockResolvedValue([]);
    api.listConnectionTags.mockResolvedValue([]);
    api.saveWorkspaceState.mockResolvedValue(undefined);
    api.cachedCapabilities.mockResolvedValue(null);
    api.deleteConnection.mockResolvedValue(undefined);
    api.deleteScratchpadNote.mockResolvedValue(undefined);
    api.scratchpadNote.mockResolvedValue(null);
    api.saveScratchpadNote.mockResolvedValue({});
    api.closeSession.mockResolvedValue(undefined);
  });

  it("keeps an unrelated terminal mounted when the active Saved Connection is deleted", async () => {
    const user = userEvent.setup();
    const first = connection("11111111-1111-4111-8111-111111111111", "Host A");
    const second = connection("22222222-2222-4222-8222-222222222222", "Host B");
    api.listConnections.mockResolvedValue([first, second]);
    api.workspaceState.mockResolvedValue(restoredState([first.id, second.id]));

    render(<App />);

    expect(await screen.findByTestId("terminal-workspace-0")).toBeTruthy();
    expect(screen.getByTestId("terminal-workspace-1")).toBeTruthy();
    await user.click(screen.getByLabelText("Open actions for Host A"));
    await user.click(screen.getByRole("menuitem", { name: /Delete connection/i }));
    // Confirm the deletion in the in-app dialog.
    await user.click(screen.getByRole("button", { name: /Delete connection/i }));

    await waitFor(() => expect(screen.queryByTestId("terminal-workspace-0")).toBeNull());
    expect(screen.getByTestId("terminal-workspace-1")).toBeTruthy();
  });

  it("asks before leaving a dirty Settings page", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByLabelText("Open Settings"));
    await user.clear(screen.getByLabelText("Font family"));
    await user.type(screen.getByLabelText("Font family"), "Cascadia Mono");
    await user.click(screen.getByRole("button", { name: "Back to terminal" }));

    // The in-app confirm dialog appears and Settings stays open.
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByText("Discard unsaved Settings changes?")).toBeTruthy();

    // Cancel keeps the Settings page.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();

    // Discarding leaves Settings.
    await user.click(screen.getByRole("button", { name: "Back to terminal" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull());
  });

  it("does not reconnect a Workspace when its shortcut is pressed inside a dialog", async () => {
    const user = userEvent.setup();
    const saved = connection("11111111-1111-4111-8111-111111111111", "Host A");
    api.listConnections.mockResolvedValue([saved]);
    api.workspaceState.mockResolvedValue(restoredState([saved.id]));
    render(<App />);

    const terminal = await screen.findByTestId("terminal-workspace-0");
    await user.click(screen.getByRole("button", { name: /Add connection/i }));
    const displayName = screen.getByLabelText("Display name");
    fireEvent.keyDown(displayName, { key: "r", ctrlKey: true, shiftKey: true });

    expect(terminal.getAttribute("data-reconnect-token")).toBe("0");
  });

  it("closes a Workspace without deleting connection or global Scratchpad notes", async () => {
    const user = userEvent.setup();
    const saved = connection("11111111-1111-4111-8111-111111111111", "Host A");
    api.listConnections.mockResolvedValue([saved]);
    api.workspaceState.mockResolvedValue(restoredState([saved.id]));
    render(<App />);

    expect(await screen.findByTestId("terminal-workspace-0")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close Host A Workspace" }));

    await waitFor(() => expect(screen.queryByTestId("terminal-workspace-0")).toBeNull());
    expect(api.deleteScratchpadNote).not.toHaveBeenCalled();
  });
});
