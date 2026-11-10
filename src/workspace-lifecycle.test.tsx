// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  listLocalShells: vi.fn(),
  discoverRemoteShells: vi.fn().mockResolvedValue({
    platform: "linux",
    shells: [],
    windowsTerminalAvailable: false,
    wslError: null,
  }),
  cachedCapabilities: vi.fn(),
  refreshCapabilities: vi.fn(),
  updateConnection: vi.fn(),
  deleteConnection: vi.fn(),
  deleteScratchpadNote: vi.fn(),
  scratchpadNote: vi.fn(),
  saveScratchpadNote: vi.fn(),
  closeSession: vi.fn(),
  // Control Room's own updater. Mounted once by App, so every test that renders
  // App reaches it.
  currentAppVersion: vi.fn(),
  checkForUpdate: vi.fn(),
  pendingUpdateNotice: vi.fn(),
  dismissUpdateNotice: vi.fn(),
}));

vi.mock("./lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock("./components/WindowControls", () => ({
  WindowControls: () => <div data-testid="window-controls" />,
}));

vi.mock("./components/TerminalPane", () => ({
  TerminalPane: ({
    workspace,
    onSession,
    onState,
  }: {
    workspace: { id: string; reconnectToken: number };
    onSession: (sessionId: string) => void;
    onState: (state: string, reason?: string | null) => void;
  }) => (
    <div data-testid={`terminal-${workspace.id}`} data-reconnect-token={workspace.reconnectToken}>
      {/* The pty reporting a started session and a state change. That is the
          only way a Workspace acquires either, and both arrive whenever the
          host answers rather than when the UI is ready for them. */}
      <button
        type="button"
        className="test-pty"
        onClick={() => onSession(`session-${workspace.id}`)}
      >
        {`start ${workspace.id}`}
      </button>
      <button type="button" className="test-pty" onClick={() => onState("connected")}>
        {`connect ${workspace.id}`}
      </button>
    </div>
  ),
}));

import { App } from "./App";
import { capabilities } from "./test/app-fixtures";
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
  globalSudoEnabled: false,
  automaticUpdateChecks: true,
  hiddenLocalShells: [],
  localTerminalMode: false,
  defaultLocalShellId: null,
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
    sudoEnabled: false,
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
      localShellId: null,
      view: "terminal",
      historyPaused: false,
    })),
    activeWorkspaceId: connectionIds.length ? "workspace-0" : null,
    terminalLayout: connectionIds.length ? { kind: "leaf", workspaceId: "workspace-0" } : null,
  };
}

/// A hidden Workspace's pane is `aria-hidden`, so role queries skip it. The
/// stand-in pty controls are reached through the pane itself.
function ptyButton(workspaceId: string, action: "start" | "connect"): HTMLElement {
  return within(screen.getByTestId(`terminal-${workspaceId}`)).getByText(
    `${action} ${workspaceId}`,
  );
}

/// The rail entry that opens a Saved Connection, as distinct from its actions
/// menu and from a Workspace tab carrying the same name.
function railEntry(displayName: string): HTMLElement {
  const entry = screen
    .getAllByRole("button")
    .find(
      (button) =>
        button.className.includes("host-main") &&
        (button.textContent ?? "").startsWith(displayName),
    );
  if (!entry) throw new Error(`no rail entry for ${displayName}`);
  return entry;
}

/// Open Workspace tabs for one connection, counted from the tab strip rather
/// than the rail, so a Saved Connection that is merely listed does not read as
/// one that is open.
function workspaceTabCount(displayName: string): number {
  return screen
    .getAllByRole("button")
    .filter(
      (button) =>
        button.className.includes("session-tab-main") && button.textContent === displayName,
    ).length;
}

function stripOrder(): (string | null)[] {
  return Array.from(document.querySelectorAll(".session-tabs .session-tab-label")).map(
    (label) => label.textContent,
  );
}

function tabMainButton(label: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(".session-tab-main")).find(
    (button) => button.textContent === label,
  )!;
}

/// The jsdom strip reports zero boxes; pin the uniform tab slots the browser
/// would lay out before driving a pointer drag.
function stubTabStripLayout() {
  const content = document.querySelector<HTMLElement>(".session-tabs .session-tab-content");
  if (!content) throw new Error("no workspace tab strip");
  const rect = (left: number): DOMRect =>
    ({
      x: left,
      y: 0,
      left,
      right: left + 175,
      top: 0,
      bottom: 34,
      width: 175,
      height: 34,
      toJSON: () => ({}),
    }) as DOMRect;
  content.getBoundingClientRect = () => rect(0);
  Array.from(
    content.querySelectorAll<HTMLElement>(
      ":scope > .session-tab-wrap, :scope > .session-tab-group",
    ),
  ).forEach((wrap, index) => {
    wrap.getBoundingClientRect = () => rect(index * 175);
  });
}

/// The repo's pointer event pattern: a MouseEvent with pointer properties.
function stripPointer(node: Element, type: string, x: number, y = 17) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
  fireEvent(node, event);
}

/// The most recent order App asked to persist, as workspace ids.
function lastSavedWorkspaceIds() {
  const calls = api.saveWorkspaceState.mock.calls;
  return (calls[calls.length - 1]?.[0] as { workspaces: { id: string }[] }).workspaces.map(
    (workspace) => workspace.id,
  );
}

function activeTabLabel() {
  return document.querySelector(".session-tab-wrap.active .session-tab-main")?.textContent;
}

/// Focus-mode strip: two two-pane groups around one plain Workspace, with a
/// group member active: Alpha owns workspaces 0 and 1, Beta owns 3 and 4.
function restoredGroupedState(): PersistedWorkspaceState {
  return {
    workspaces: ["a", "b", "c", "d", "e"].map((connectionId, index) => ({
      id: `workspace-${index}`,
      label: null,
      connectionId,
      localShellId: null,
      view: "terminal",
      historyPaused: false,
    })),
    activeWorkspaceId: "workspace-0",
    terminalLayout: { kind: "leaf", workspaceId: "workspace-0" },
    terminalGroups: [
      {
        id: "group-alpha",
        name: "Alpha",
        layout: {
          kind: "split",
          direction: "vertical",
          first: { kind: "leaf", workspaceId: "workspace-0" },
          second: { kind: "leaf", workspaceId: "workspace-1" },
        },
      },
      {
        id: "group-beta",
        name: "Beta",
        layout: {
          kind: "split",
          direction: "vertical",
          first: { kind: "leaf", workspaceId: "workspace-3" },
          second: { kind: "leaf", workspaceId: "workspace-4" },
        },
      },
    ],
  };
}

/// Focus mode collapses each terminal group to one slot, so the strip reads
/// `Alpha 2` for a group and `Host C` for a plain Workspace.
function focusStripLabels(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(".session-tabs .session-tab-content > *"),
  ).map((tab) => {
    if (tab.classList.contains("session-tab-group")) {
      return (tab.querySelector(".session-tab-group-main")?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim();
    }
    return tab.querySelector(".session-tab-label")?.textContent ?? "";
  });
}

function groupTab(name: string): HTMLElement {
  // The group row's scope keeps the aria name short; Rename and Ungroup sit beside it.
  return within(screen.getByRole("group", { name })).getByRole("button", { name: /^Open / });
}

async function renderFocusGroupedApp() {
  api.listConnections.mockResolvedValue(
    ["a", "b", "c", "d", "e"].map((id, index) =>
      connection(id, `Host ${String.fromCharCode(65 + index)}`),
    ),
  );
  api.workspaceState.mockResolvedValue(restoredGroupedState());
  render(<App />);
  await screen.findByTestId("terminal-workspace-0", undefined, { timeout: 5_000 });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Focus terminal" }));
  expect(focusStripLabels()).toEqual(["Alpha 2", "Host C", "Beta 2"]);
  return user;
}

describe("App Workspace behavior", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    api.currentAppVersion.mockResolvedValue("0.6.1");
    api.checkForUpdate.mockResolvedValue(null);
    api.pendingUpdateNotice.mockResolvedValue(null);
    api.dismissUpdateNotice.mockResolvedValue(undefined);
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
    api.listLocalShells.mockResolvedValue({
      profiles: [],
      administratorStatus: "unsupportedWindows",
    });
    api.cachedCapabilities.mockResolvedValue(null);
    api.refreshCapabilities.mockReset();
    api.refreshCapabilities.mockImplementation(async (id: string) => capabilities(id));
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

    // App loads TerminalPane lazily. Parallel full-suite runs can delay that
    // import beyond Testing Library's one-second default without delaying App.
    expect(
      await screen.findByTestId("terminal-workspace-0", undefined, { timeout: 5_000 }),
    ).toBeTruthy();
    expect(screen.getByTestId("terminal-workspace-1")).toBeTruthy();
    await user.click(screen.getByLabelText("Open actions for Host A"));
    await user.click(screen.getByRole("menuitem", { name: /Delete connection/i }));
    // Confirm the deletion in the in-app dialog.
    await user.click(screen.getByRole("button", { name: /Delete connection/i }));

    await waitFor(() => expect(screen.queryByTestId("terminal-workspace-0")).toBeNull());
    expect(screen.getByTestId("terminal-workspace-1")).toBeTruthy();
  });

  it("discovers an edited target after an old target read finishes without restarting its terminal", async () => {
    const saved = connection("11111111-1111-4111-8111-111111111111", "Host A");
    api.listConnections.mockResolvedValue([saved]);
    api.workspaceState.mockResolvedValue(restoredState([saved.id]));
    let finish!: (value: ReturnType<typeof capabilities>) => void;
    api.refreshCapabilities
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({
        ...capabilities(saved.id),
        osId: "windows",
        osName: "Windows",
        osVersion: "11",
      });
    api.updateConnection.mockResolvedValue({ ...saved, destination: "new-target" });
    render(<App />);
    const terminal = await screen.findByTestId("terminal-workspace-0");
    fireEvent.click(ptyButton("workspace-0", "connect"));
    await waitFor(() => expect(api.refreshCapabilities).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByLabelText("Open actions for Host A"));
    await userEvent.click(screen.getByRole("menuitem", { name: /Edit connection/i }));
    await userEvent.clear(screen.getByLabelText("SSH destination"));
    await userEvent.type(screen.getByLabelText("SSH destination"), "new-target");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.updateConnection).toHaveBeenCalled());
    await act(async () => finish(capabilities(saved.id)));
    await waitFor(() => expect(api.refreshCapabilities).toHaveBeenCalledTimes(2));
    expect(await screen.findAllByRole("img", { name: "Windows host" })).not.toHaveLength(0);
    expect(screen.getByTestId("terminal-workspace-0")).toBe(terminal);
    expect(terminal.getAttribute("data-reconnect-token")).toBe("0");
  });

  it("asks before leaving a dirty Settings page", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByLabelText("Open Settings"));
    await user.click(screen.getByRole("button", { name: "Terminal" }));
    await user.clear(screen.getByLabelText("Font family"));
    await user.type(screen.getByLabelText("Font family"), "Cascadia Mono");
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Close Settings" }));

    // The in-app confirm dialog appears and Settings stays open.
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByText("Discard unsaved Settings changes?")).toBeTruthy();

    // Cancel keeps the Settings page.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();

    // Discarding leaves Settings.
    await user.click(screen.getByRole("button", { name: "Close Settings" }));
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

  // CR-AUDIT-005. `performDeleteConnection` reads `workspaces` from the render
  // that created the confirmation callback, awaits the backend, and then writes
  // a whole array back. Anything that changed the Workspace list while it was
  // waiting is inside neither copy, so the write puts the older list back and
  // the change is gone.
  //
  // Deleting a Saved Connection is the reachable version: the dialog closes
  // before the work starts, so the rail stays live and opening another host's
  // Workspace during a slow delete is an ordinary thing to do.
  it("keeps a Workspace opened while a connection deletion is in flight", async () => {
    const user = userEvent.setup();
    const first = connection("11111111-1111-4111-8111-111111111111", "Host A");
    const second = connection("22222222-2222-4222-8222-222222222222", "Host B");
    api.listConnections.mockResolvedValue([first, second]);
    api.workspaceState.mockResolvedValue(restoredState([first.id]));

    let finishDelete = () => {};
    api.deleteConnection.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = () => resolve();
        }),
    );

    render(<App />);
    expect(await screen.findByTestId("terminal-workspace-0")).toBeTruthy();

    await user.click(screen.getByLabelText("Open actions for Host A"));
    await user.click(screen.getByRole("menuitem", { name: /Delete connection/i }));
    await user.click(screen.getByRole("button", { name: /Delete connection/i }));
    await waitFor(() => expect(api.deleteConnection).toHaveBeenCalled());

    // The delete has not come back yet. Open the other host's Workspace.
    await user.click(railEntry("Host B"));
    await waitFor(() => expect(workspaceTabCount("Host B")).toBe(1));

    finishDelete();

    // Host A's Workspace goes, and Host B's stays.
    await waitFor(() => expect(screen.queryByTestId("terminal-workspace-0")).toBeNull());
    expect(
      workspaceTabCount("Host B"),
      "the Workspace opened during the delete was rolled back",
    ).toBe(1);
  });

  // The second async window inside the same deletion. Once the backend record
  // is gone, the deleted connection's own Terminal Sessions still have to be
  // torn down, and each teardown is a round trip. Taking the Workspace list
  // before that loop and writing the result after it is the same stale-state
  // shape as the test above, one await later.
  it("keeps a Workspace opened while a deleted connection's session is closing", async () => {
    const user = userEvent.setup();
    const first = connection("11111111-1111-4111-8111-111111111111", "Host A");
    const second = connection("22222222-2222-4222-8222-222222222222", "Host B");
    api.listConnections.mockResolvedValue([first, second]);
    api.workspaceState.mockResolvedValue(restoredState([first.id]));

    // The delete itself returns at once. It is the pty teardown behind it that
    // takes time here.
    api.deleteConnection.mockResolvedValue(undefined);
    const closes: Array<() => void> = [];
    api.closeSession.mockImplementation(
      () => new Promise<void>((resolve) => closes.push(() => resolve())),
    );

    const { container } = render(<App />);
    expect(await screen.findByTestId("terminal-workspace-0")).toBeTruthy();

    // Host A's Workspace has a live session, so deleting it has something to
    // close.
    await user.click(ptyButton("workspace-0", "start"));

    await user.click(screen.getByLabelText("Open actions for Host A"));
    await user.click(screen.getByRole("menuitem", { name: /Delete connection/i }));
    await user.click(screen.getByRole("button", { name: /Delete connection/i }));
    await waitFor(() => expect(api.closeSession).toHaveBeenCalledWith("session-workspace-0"));

    // The record is deleted and the pty is still closing. Open the other host.
    await user.click(railEntry("Host B"));
    await waitFor(() => expect(workspaceTabCount("Host B")).toBe(1));

    for (const resolve of [...closes]) resolve();

    // Host A's Workspace goes, and Host B's stays.
    await waitFor(() => expect(screen.queryByTestId("terminal-workspace-0")).toBeNull());
    expect(
      workspaceTabCount("Host B"),
      "the Workspace opened during the session teardown was rolled back",
    ).toBe(1);
    // Host A's rail entry is gone too, and Host B's is not.
    expect(container.textContent).not.toContain("Host Auser@");
    expect(railEntry("Host B")).toBeTruthy();
  });

  // Deletion now removes the connection from the rail before it awaits, and
  // derives the removal from the list as it is afterwards. That reordering has
  // to leave the rest of the teardown exactly as it was, so this covers a
  // connection with more than one Workspace, only one of which has a session,
  // beside an unrelated Workspace that has to survive all of it.
  it("removes every Workspace of a deleted connection and leaves the rest intact", async () => {
    const user = userEvent.setup();
    const first = connection("11111111-1111-4111-8111-111111111111", "Host A");
    const second = connection("22222222-2222-4222-8222-222222222222", "Host B");
    api.listConnections.mockResolvedValue([first, second]);
    api.workspaceState.mockResolvedValue(restoredState([first.id, first.id, second.id]));
    // A pty that refuses to close is still best effort: the Workspaces go.
    api.closeSession.mockRejectedValue(new Error("session is already gone"));

    render(<App />);
    expect(await screen.findByTestId("terminal-workspace-0")).toBeTruthy();
    await user.click(ptyButton("workspace-1", "start"));

    await user.click(screen.getByLabelText("Open actions for Host A"));
    await user.click(screen.getByRole("menuitem", { name: /Delete connection/i }));
    await user.click(screen.getByRole("button", { name: /Delete connection/i }));

    await waitFor(() => expect(screen.queryByTestId("terminal-workspace-0")).toBeNull());
    expect(screen.queryByTestId("terminal-workspace-1")).toBeNull();
    expect(screen.getByTestId("terminal-workspace-2")).toBeTruthy();
    expect(workspaceTabCount("Host A")).toBe(0);
    expect(workspaceTabCount("Host B")).toBe(1);

    // The one session that existed was closed, and the one Workspace that had
    // none asked for nothing.
    expect(api.closeSession).toHaveBeenCalledWith("session-workspace-1");
    expect(api.closeSession).toHaveBeenCalledTimes(1);

    // The active Workspace was one of the deleted ones, so it falls back to
    // what is left rather than to nothing.
    const activeTab = screen
      .getAllByRole("button", { current: "page" })
      .filter((button) => button.className.includes("session-tab-main"));
    expect(activeTab).toHaveLength(1);
    expect(activeTab[0].textContent).toBe("Host B");
  });

  // The path with nothing to await at all. It shares the reordered code, so a
  // change that only works when there is a session to close fails here.
  it("deletes a connection that has no open Workspace", async () => {
    const user = userEvent.setup();
    const first = connection("11111111-1111-4111-8111-111111111111", "Host A");
    const second = connection("22222222-2222-4222-8222-222222222222", "Host B");
    api.listConnections.mockResolvedValue([first, second]);
    api.workspaceState.mockResolvedValue(restoredState([second.id]));

    const { container } = render(<App />);
    expect(await screen.findByTestId("terminal-workspace-0")).toBeTruthy();

    await user.click(screen.getByLabelText("Open actions for Host A"));
    await user.click(screen.getByRole("menuitem", { name: /Delete connection/i }));
    await user.click(screen.getByRole("button", { name: /Delete connection/i }));

    await waitFor(() => expect(container.textContent).not.toContain("Host Auser@"));
    expect(api.closeSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("terminal-workspace-0")).toBeTruthy();
    expect(workspaceTabCount("Host B")).toBe(1);
  });

  // The other half of CR-AUDIT-005. Closing a Workspace with a live session
  // asks first, then awaits the pty teardown, and only then replaces the whole
  // list. A session that reported connected in that window belongs to a
  // Workspace the replacement does not know about.
  it("keeps a session state that arrives while another Workspace is closing", async () => {
    const user = userEvent.setup();
    const first = connection("11111111-1111-4111-8111-111111111111", "Host A");
    const second = connection("22222222-2222-4222-8222-222222222222", "Host B");
    api.listConnections.mockResolvedValue([first, second]);
    api.workspaceState.mockResolvedValue(restoredState([first.id, second.id]));

    let finishClose = () => {};
    api.closeSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClose = () => resolve();
        }),
    );

    const { container } = render(<App />);
    expect(await screen.findByTestId("terminal-workspace-0")).toBeTruthy();

    // Host A's Workspace has a live session, so closing it asks first.
    await user.click(ptyButton("workspace-0", "start"));
    await user.click(screen.getByRole("button", { name: "Close Host A Workspace" }));
    await user.click(screen.getByRole("button", { name: "Disconnect & close" }));
    await waitFor(() => expect(api.closeSession).toHaveBeenCalled());

    // Host B connects while the teardown is still in flight.
    await user.click(ptyButton("workspace-1", "connect"));
    await waitFor(() => expect(container.querySelector(".presence-connected")).toBeTruthy());

    finishClose();

    await waitFor(() => expect(screen.queryByTestId("terminal-workspace-0")).toBeNull());
    expect(
      container.querySelector(".presence-connected"),
      "Host B's session state was rolled back by the close that followed it",
    ).toBeTruthy();
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

  it("reorders a dragged Workspace tab and keeps the active terminal live", async () => {
    const user = userEvent.setup();
    const first = connection("11111111-1111-4111-8111-111111111111", "Host A");
    const second = connection("22222222-2222-4222-8222-222222222222", "Host B");
    const third = connection("33333333-3333-4333-8333-333333333333", "Host C");
    api.listConnections.mockResolvedValue([first, second, third]);
    api.workspaceState.mockResolvedValue(restoredState([first.id, second.id, third.id]));
    render(<App />);

    const terminalA = await screen.findByTestId("terminal-workspace-0", undefined, {
      timeout: 5_000,
    });
    const terminalB = screen.getByTestId("terminal-workspace-1");
    const terminalC = screen.getByTestId("terminal-workspace-2");
    expect(stripOrder()).toEqual(["Host A", "Host B", "Host C"]);

    stubTabStripLayout();
    const hostCTab = tabMainButton("Host C");
    stripPointer(hostCTab, "pointerdown", 480);
    stripPointer(hostCTab, "pointermove", 60);
    // Mid-drag the tab is lifted and the rest slide.
    expect(document.querySelector(".session-tab-dragged")).toBeTruthy();
    stripPointer(hostCTab, "pointerup", 60);

    expect(stripOrder()).toEqual(["Host C", "Host A", "Host B"]);
    // The reordered tab keeps its terminal instance, session included, and the
    // active Workspace is untouched by the motion next to it.
    expect(screen.getByTestId("terminal-workspace-2")).toBe(terminalC);
    expect(screen.getByTestId("terminal-workspace-0")).toBe(terminalA);
    expect(screen.getByTestId("terminal-workspace-1")).toBe(terminalB);
    expect(activeTabLabel()).toBe("Host A");
    await waitFor(() =>
      expect(lastSavedWorkspaceIds()).toEqual(["workspace-2", "workspace-0", "workspace-1"]),
    );

    // A finished drag does not swallow the next click: selecting still works.
    await user.click(tabMainButton("Host B"));
    await waitFor(() => expect(activeTabLabel()).toBe("Host B"));
    expect(stripOrder()).toEqual(["Host C", "Host A", "Host B"]);
  });

  it("restores the strip untouched when a Workspace drag is canceled", async () => {
    const user = userEvent.setup();
    const first = connection("11111111-1111-4111-8111-111111111111", "Host A");
    const second = connection("22222222-2222-4222-8222-222222222222", "Host B");
    const third = connection("33333333-3333-4333-8333-333333333333", "Host C");
    api.listConnections.mockResolvedValue([first, second, third]);
    api.workspaceState.mockResolvedValue(restoredState([first.id, second.id, third.id]));
    render(<App />);

    await screen.findByTestId("terminal-workspace-0", undefined, { timeout: 5_000 });
    expect(stripOrder()).toEqual(["Host A", "Host B", "Host C"]);
    stubTabStripLayout();

    const hostCTab = tabMainButton("Host C");
    stripPointer(hostCTab, "pointerdown", 480);
    stripPointer(hostCTab, "pointermove", 60);
    expect(document.querySelector(".session-tab-dragged")).toBeTruthy();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector(".session-tab-dragged")).toBeNull();

    stripPointer(hostCTab, "pointerup", 60);
    expect(stripOrder()).toEqual(["Host A", "Host B", "Host C"]);
    await waitFor(() =>
      expect(lastSavedWorkspaceIds()).toEqual(["workspace-0", "workspace-1", "workspace-2"]),
    );

    // The canceled drag left normal tab selection in place.
    await user.click(tabMainButton("Host C"));
    await waitFor(() => expect(activeTabLabel()).toBe("Host C"));
  });

  it("drags a terminal group in focus mode and its Workspaces stay one block", async () => {
    await renderFocusGroupedApp();

    stubTabStripLayout();
    const betaTab = groupTab("Beta");
    stripPointer(betaTab, "pointerdown", 437);
    stripPointer(betaTab, "pointermove", 60);
    expect(document.querySelector(".session-tab-dragged")).toBeTruthy();
    stripPointer(betaTab, "pointerup", 60);

    expect(focusStripLabels()).toEqual(["Beta 2", "Alpha 2", "Host C"]);
    // The group moves whole, so its two Workspaces land together and in pane
    // order, ahead of the plain Workspace it passed.
    await waitFor(() =>
      expect(lastSavedWorkspaceIds()).toEqual([
        "workspace-3",
        "workspace-4",
        "workspace-0",
        "workspace-1",
        "workspace-2",
      ]),
    );
    // Both groups stay single slots and the active group keeps its mark.
    expect(screen.getByRole("group", { name: "Alpha" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Beta" })).toBeTruthy();
    expect(document.querySelector(".session-tab-group.active")?.textContent).toContain("Alpha");
  });

  it("restores the focus strip untouched when a group drag is canceled", async () => {
    await renderFocusGroupedApp();

    stubTabStripLayout();
    const alphaTab = groupTab("Alpha");
    stripPointer(alphaTab, "pointerdown", 87);
    stripPointer(alphaTab, "pointermove", 450);
    expect(document.querySelector(".session-tab-dragged")).toBeTruthy();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector(".session-tab-dragged")).toBeNull();

    stripPointer(alphaTab, "pointerup", 450);
    expect(focusStripLabels()).toEqual(["Alpha 2", "Host C", "Beta 2"]);
    // The strip keeps its group block, plain tab, and group blocks in order.
    await waitFor(() =>
      expect(lastSavedWorkspaceIds()).toEqual([
        "workspace-0",
        "workspace-1",
        "workspace-2",
        "workspace-3",
        "workspace-4",
      ]),
    );
  });

  it("moves a focused group with Control and Shift arrow keys in focus mode", async () => {
    await renderFocusGroupedApp();

    stubTabStripLayout();
    const alphaTab = groupTab("Alpha");
    act(() => alphaTab.focus());
    fireEvent.keyDown(alphaTab, { key: "ArrowRight", ctrlKey: true, shiftKey: true });
    expect(focusStripLabels()).toEqual(["Host C", "Alpha 2", "Beta 2"]);
    // Moving the group one slot moves its Workspaces as one block.
    await waitFor(() =>
      expect(lastSavedWorkspaceIds()).toEqual([
        "workspace-2",
        "workspace-0",
        "workspace-1",
        "workspace-3",
        "workspace-4",
      ]),
    );
  });

  it("moves a focused tab with the keyboard and closes keep the new order", async () => {
    const user = userEvent.setup();
    const first = connection("11111111-1111-4111-8111-111111111111", "Host A");
    const second = connection("22222222-2222-4222-8222-222222222222", "Host B");
    const third = connection("33333333-3333-4333-8333-333333333333", "Host C");
    api.listConnections.mockResolvedValue([first, second, third]);
    api.workspaceState.mockResolvedValue(restoredState([first.id, second.id, third.id]));
    render(<App />);

    await screen.findByTestId("terminal-workspace-0", undefined, { timeout: 5_000 });
    expect(stripOrder()).toEqual(["Host A", "Host B", "Host C"]);

    act(() => tabMainButton("Host B").focus());
    const hostB = tabMainButton("Host B");
    fireEvent.keyDown(hostB, { key: "ArrowLeft", ctrlKey: true, shiftKey: true });
    expect(stripOrder()).toEqual(["Host B", "Host A", "Host C"]);
    // Moving a tab never moves the active Workspace with it.
    expect(activeTabLabel()).toBe("Host A");
    await waitFor(() =>
      expect(lastSavedWorkspaceIds()).toEqual(["workspace-1", "workspace-0", "workspace-2"]),
    );

    // Closing the moved tab leaves the survivors in their new relative order.
    await user.click(screen.getByRole("button", { name: "Close Host B Workspace" }));
    await waitFor(() => expect(screen.queryByTestId("terminal-workspace-1")).toBeNull());
    expect(stripOrder()).toEqual(["Host A", "Host C"]);
    await waitFor(() => expect(lastSavedWorkspaceIds()).toEqual(["workspace-0", "workspace-2"]));
  });
});
