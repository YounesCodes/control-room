import { describe, expect, it } from "vitest";
import { createTerminalLayout, splitTerminalLayout } from "./terminal-layout";
import { persistWorkspaceState, restoreWorkspaceState } from "./workspace-persistence";
import type {
  LocalShellProfile,
  PersistedWorkspaceState,
  RemoteWorkspace,
  SavedConnection,
} from "../types";

const powershell: LocalShellProfile = {
  id: "powershell-7",
  label: "PowerShell 7",
  kind: "powershell-7",
};

function connection(id: string): SavedConnection {
  return {
    id,
    displayName: id,
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

describe("Workspace restoration", () => {
  it("restores tabs and splits as disconnected without session IDs", () => {
    const state: PersistedWorkspaceState = {
      workspaces: [
        {
          id: "workspace-a",
          label: "Deploy",
          connectionId: "connection-a",
          localShellId: null,
          view: "terminal",
          historyPaused: false,
        },
        {
          id: "workspace-b",
          label: null,
          connectionId: "connection-b",
          localShellId: null,
          view: "logs",
          historyPaused: true,
        },
      ],
      activeWorkspaceId: "workspace-b",
      terminalLayout: splitTerminalLayout(
        createTerminalLayout("workspace-a"),
        "workspace-a",
        "workspace-b",
        "vertical",
      ),
    };

    const restored = restoreWorkspaceState(
      [connection("connection-a"), connection("connection-b")],
      state,
    );

    expect(restored.activeWorkspaceId).toBe("workspace-b");
    expect(restored.terminalLayout).toEqual(state.terminalLayout);
    expect(
      restored.workspaces.map(({ state, sessionId, connectRequested }) => ({
        state,
        sessionId,
        connectRequested,
      })),
    ).toEqual([
      { state: "disconnected", sessionId: null, connectRequested: false },
      { state: "disconnected", sessionId: null, connectRequested: false },
    ]);
  });

  it("drops Workspaces for deleted connections and prunes their split leaves", () => {
    const state: PersistedWorkspaceState = {
      workspaces: [
        {
          id: "workspace-a",
          label: null,
          connectionId: "connection-a",
          localShellId: null,
          view: "terminal",
          historyPaused: false,
        },
        {
          id: "workspace-b",
          label: null,
          connectionId: "missing",
          localShellId: null,
          view: "terminal",
          historyPaused: false,
        },
      ],
      activeWorkspaceId: "workspace-b",
      terminalLayout: splitTerminalLayout(
        createTerminalLayout("workspace-a"),
        "workspace-a",
        "workspace-b",
        "horizontal",
      ),
    };

    const restored = restoreWorkspaceState([connection("connection-a")], state);

    expect(restored.workspaces).toHaveLength(1);
    expect(restored.activeWorkspaceId).toBe("workspace-a");
    expect(restored.terminalLayout).toEqual(createTerminalLayout("workspace-a"));
    expect(
      persistWorkspaceState(
        restored.workspaces,
        restored.activeWorkspaceId,
        restored.terminalLayout,
      ),
    ).toMatchObject({ activeWorkspaceId: "workspace-a" });
  });

  it("restores a local terminal tab without starting its shell", () => {
    const state: PersistedWorkspaceState = {
      workspaces: [
        {
          id: "workspace-a",
          label: "Build shell",
          connectionId: null,
          localShellId: "powershell-7",
          view: "terminal",
          historyPaused: false,
        },
        {
          id: "workspace-b",
          label: null,
          connectionId: "connection-a",
          localShellId: null,
          view: "terminal",
          historyPaused: false,
        },
      ],
      activeWorkspaceId: "workspace-a",
      terminalLayout: splitTerminalLayout(
        createTerminalLayout("workspace-a"),
        "workspace-a",
        "workspace-b",
        "vertical",
      ),
    };

    const restored = restoreWorkspaceState([connection("connection-a")], state, [powershell]);

    expect(restored.workspaces.map((workspace) => workspace.kind)).toEqual(["local", "remote"]);
    // Restoring a layout starts nothing: no SSH connection and no local
    // process until the user asks.
    expect(
      restored.workspaces.map(({ state, sessionId, connectRequested }) => ({
        state,
        sessionId,
        connectRequested,
      })),
    ).toEqual([
      { state: "disconnected", sessionId: null, connectRequested: false },
      { state: "disconnected", sessionId: null, connectRequested: false },
    ]);
    expect(restored.workspaces[0].label).toBe("Build shell");
    expect(restored.terminalLayout).toEqual(state.terminalLayout);
    // A local and a remote tab persist side by side, each naming one target.
    expect(persistWorkspaceState(restored.workspaces, "workspace-a", null).workspaces).toEqual([
      {
        id: "workspace-a",
        label: "Build shell",
        connectionId: null,
        localShellId: "powershell-7",
        view: "terminal",
        historyPaused: false,
      },
      {
        id: "workspace-b",
        label: null,
        connectionId: "connection-a",
        localShellId: null,
        view: "terminal",
        historyPaused: false,
      },
    ]);
  });

  it("drops a local Workspace whose shell is no longer installed", () => {
    const state: PersistedWorkspaceState = {
      workspaces: [
        {
          id: "workspace-a",
          label: null,
          connectionId: null,
          localShellId: "git-bash",
          view: "terminal",
          historyPaused: false,
        },
        {
          id: "workspace-b",
          label: null,
          connectionId: null,
          localShellId: "powershell-7",
          view: "terminal",
          historyPaused: false,
        },
      ],
      activeWorkspaceId: "workspace-a",
      terminalLayout: splitTerminalLayout(
        createTerminalLayout("workspace-a"),
        "workspace-a",
        "workspace-b",
        "horizontal",
      ),
    };

    // Git for Windows was uninstalled since the layout was saved.
    const restored = restoreWorkspaceState([], state, [powershell]);

    expect(restored.workspaces).toHaveLength(1);
    expect(restored.activeWorkspaceId).toBe("workspace-b");
    expect(restored.terminalLayout).toEqual(createTerminalLayout("workspace-b"));
  });

  it("restores Workspace state written before Local Terminal existed", () => {
    // Exactly the payload older releases wrote: no local shell field at all.
    const legacy = JSON.parse(
      `{"workspaces":[{"id":"workspace-a","label":null,"connectionId":"connection-a","view":"logs","historyPaused":true}],"activeWorkspaceId":"workspace-a","terminalLayout":{"kind":"leaf","workspaceId":"workspace-a"}}`,
    ) as PersistedWorkspaceState;

    const restored = restoreWorkspaceState([connection("connection-a")], legacy);
    const remote = restored.workspaces[0] as RemoteWorkspace;

    expect(restored.workspaces).toHaveLength(1);
    expect(remote.kind).toBe("remote");
    expect(remote.connectionId).toBe("connection-a");
    expect(remote.view).toBe("logs");
    expect(remote.historyPaused).toBe(true);
    expect(remote.state).toBe("disconnected");
    expect(restored.terminalLayout).toEqual(createTerminalLayout("workspace-a"));
  });

  it("keeps Boot Diagnostics and journal evidence out of persisted Workspace state", () => {
    const state: PersistedWorkspaceState = {
      workspaces: [
        {
          id: "workspace-a",
          label: null,
          connectionId: "connection-a",
          localShellId: null,
          view: "boot",
          historyPaused: false,
        },
      ],
      activeWorkspaceId: "workspace-a",
      terminalLayout: null,
    };
    const restored = restoreWorkspaceState([connection("connection-a")], state);
    const remote = restored.workspaces[0] as RemoteWorkspace;
    remote.bootDiagnostics = {
      id: "diagnostic-a",
      collectedAt: "2026-08-31T12:00:00Z",
      selectedBootId: "a".repeat(32),
      boots: {
        collectedAt: "2026-08-31T12:00:00Z",
        data: [],
        error: null,
        permissionRequired: false,
      },
      timing: {
        collectedAt: "2026-08-31T12:00:00Z",
        data: null,
        error: "Unavailable",
        permissionRequired: false,
      },
      slowUnits: {
        collectedAt: "2026-08-31T12:00:00Z",
        data: [],
        error: null,
        permissionRequired: false,
      },
      failedUnits: {
        collectedAt: "2026-08-31T12:00:00Z",
        data: [],
        error: null,
        permissionRequired: false,
      },
      journal: {
        collectedAt: "2026-08-31T12:00:00Z",
        data: ["sensitive journal evidence"],
        error: null,
        permissionRequired: false,
      },
    };

    const persisted = persistWorkspaceState(restored.workspaces, "workspace-a", null);

    expect(persisted.workspaces[0]).not.toHaveProperty("bootDiagnostics");
    expect(JSON.stringify(persisted)).not.toContain("sensitive journal evidence");
  });
});
