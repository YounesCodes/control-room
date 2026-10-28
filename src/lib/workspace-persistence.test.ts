import { describe, expect, it } from "vitest";
import { createTerminalLayout, splitTerminalLayout, resizeTerminalLayout } from "./terminal-layout";
import { persistWorkspaceState, restoreWorkspaceState } from "./workspace-persistence";
import { createLocalWorkspace, createRemoteWorkspace } from "./workspace-target";
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
  elevated: false,
};

const zsh: LocalShellProfile = {
  id: "zsh",
  label: "zsh",
  kind: "zsh",
  elevated: false,
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
  it("restores an installed Mac shell with a fresh process and prunes unavailable profiles", () => {
    const local = createLocalWorkspace(zsh);
    const remote = createRemoteWorkspace(connection("linux-host"));
    const saved = persistWorkspaceState([local, remote], local.id, []);
    const restored = restoreWorkspaceState([connection("linux-host")], saved, [zsh]);
    expect(restored.workspaces[0]).toMatchObject({
      kind: "local",
      shell: zsh,
      sessionId: null,
      connectRequested: true,
    });
    const windows = restoreWorkspaceState([connection("linux-host")], saved, [powershell]);
    expect(windows.workspaces).toHaveLength(1);
    expect(windows.workspaces[0].kind).toBe("remote");
  });
  it("round-trips independent nested split sizes in a mixed local and remote group", () => {
    const state: PersistedWorkspaceState = {
      workspaces: ["local", "remote", "logs"].map((id) => ({
        id,
        label: null,
        connectionId: id === "local" ? null : "host",
        localShellId: id === "local" ? powershell.id : null,
        view: "terminal",
        historyPaused: false,
      })),
      activeWorkspaceId: "remote",
      terminalGroups: [
        {
          id: "mixed",
          name: "Mixed",
          layout: resizeTerminalLayout(
            resizeTerminalLayout(
              splitTerminalLayout(
                splitTerminalLayout(createTerminalLayout("local"), "local", "remote", "vertical"),
                "remote",
                "logs",
                "horizontal",
              ),
              "",
              0.65,
            ),
            "second",
            0.35,
          ),
        },
      ],
    };
    const restored = restoreWorkspaceState([connection("host")], state, [powershell]);
    const saved = persistWorkspaceState(
      restored.workspaces,
      restored.activeWorkspaceId,
      restored.terminalGroups,
    );
    expect(saved.terminalGroups).toEqual(state.terminalGroups);
    expect(restoreWorkspaceState([connection("host")], saved, [powershell]).terminalGroups).toEqual(
      state.terminalGroups,
    );
  });
  it.each(["overview", "services", "ports", "docker", "logs"] as const)(
    "preserves the supported Windows %s view",
    (view) => {
      const workspace = createRemoteWorkspace(connection("windows-host"), {
        id: "powershell",
        label: "Windows PowerShell",
      });
      workspace.view = view;
      const saved = persistWorkspaceState([workspace], workspace.id, []);
      const restored = restoreWorkspaceState([connection("windows-host")], saved);
      expect(restored.workspaces[0].view).toBe(view);
      saved.workspaces[0].view = "boot";
      expect(restoreWorkspaceState([connection("windows-host")], saved).workspaces[0].view).toBe(
        "terminal",
      );
    },
  );
  it("preserves a Windows WSL selection across saving and restoring a tab", () => {
    const workspace = createRemoteWorkspace(connection("windows-host"), {
      id: "wsl:Ubuntu",
      label: "WSL: Ubuntu",
    });
    const saved = persistWorkspaceState([workspace], workspace.id, []);
    const restored = restoreWorkspaceState([connection("windows-host")], saved);
    expect((restored.workspaces[0] as RemoteWorkspace).remoteShell).toEqual(workspace.remoteShell);
    expect(restored.workspaces[0].connectRequested).toBe(true);
    expect(restored.workspaces[0].sessionId).toBeNull();
  });
  it("restores tabs and splits with fresh connection requests and no session IDs", () => {
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
    expect(restored.terminalGroups).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Terminal group",
        layout: state.terminalLayout,
      },
    ]);
    expect(
      restored.workspaces.map(({ state, sessionId, connectRequested }) => ({
        state,
        sessionId,
        connectRequested,
      })),
    ).toEqual([
      { state: "connecting", sessionId: null, connectRequested: true },
      { state: "connecting", sessionId: null, connectRequested: true },
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
    expect(restored.terminalGroups).toEqual([]);
    expect(
      persistWorkspaceState(
        restored.workspaces,
        restored.activeWorkspaceId,
        restored.terminalGroups,
      ),
    ).toMatchObject({ activeWorkspaceId: "workspace-a" });
  });

  it("restores multiple groups and keeps the first claim for duplicate membership", () => {
    const state: PersistedWorkspaceState = {
      workspaces: ["a", "b", "c"].map((id) => ({
        id,
        label: null,
        connectionId: `connection-${id}`,
        localShellId: null,
        view: "terminal",
        historyPaused: false,
      })),
      activeWorkspaceId: "c",
      terminalGroups: [
        {
          id: "first",
          name: "Build",
          layout: splitTerminalLayout(createTerminalLayout("a"), "a", "b", "vertical"),
        },
        {
          id: "second",
          name: "Logs",
          layout: splitTerminalLayout(createTerminalLayout("b"), "b", "c", "horizontal"),
        },
      ],
    };

    const restored = restoreWorkspaceState(
      [connection("connection-a"), connection("connection-b"), connection("connection-c")],
      state,
    );

    expect(restored.terminalGroups).toEqual([state.terminalGroups?.[0]]);
  });

  it("requests a fresh local shell alongside a restored remote session", () => {
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
    // Both tabs start new sessions when their TerminalPanes mount.
    expect(
      restored.workspaces.map(({ state, sessionId, connectRequested }) => ({
        state,
        sessionId,
        connectRequested,
      })),
    ).toEqual([
      { state: "connecting", sessionId: null, connectRequested: true },
      { state: "connecting", sessionId: null, connectRequested: true },
    ]);
    expect(restored.workspaces[0].label).toBe("Build shell");
    expect(restored.terminalGroups[0].layout).toEqual(state.terminalLayout);
    // A local and a remote tab persist side by side, each naming one target.
    expect(persistWorkspaceState(restored.workspaces, "workspace-a", []).workspaces).toEqual([
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
    expect(restored.terminalGroups).toEqual([]);
  });

  it("restores legacy local Scratchpad pages and unsupported local views to Terminal", () => {
    const state: PersistedWorkspaceState = {
      workspaces: [
        {
          id: "workspace-a",
          label: null,
          connectionId: null,
          localShellId: "powershell-7",
          view: "scratchpad",
          historyPaused: false,
        },
        {
          id: "workspace-b",
          label: null,
          connectionId: null,
          localShellId: "git-bash",
          // An unknown or remote-only view falls back to the terminal.
          view: "overview" as PersistedWorkspaceState["workspaces"][number]["view"],
          historyPaused: false,
        },
      ],
      activeWorkspaceId: "workspace-a",
      terminalLayout: null,
    };

    const restored = restoreWorkspaceState([], state, [
      powershell,
      { id: "git-bash", label: "Git Bash", kind: "git-bash", elevated: false },
    ]);
    expect(restored.workspaces.map((workspace) => workspace.view)).toEqual([
      "terminal",
      "terminal",
    ]);
  });

  it("restores a legacy remote Scratchpad page to the same terminal and host", () => {
    const host = connection("saved-host");
    const workspace = createRemoteWorkspace(host);
    const saved = persistWorkspaceState([workspace], workspace.id, []);
    saved.workspaces[0].view = "scratchpad";
    const restored = restoreWorkspaceState([host], saved);
    expect(restored.activeWorkspaceId).toBe(workspace.id);
    expect(restored.workspaces[0]).toMatchObject({
      id: workspace.id,
      connectionId: host.id,
      view: "terminal",
      connectRequested: true,
    });
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
    expect(remote.state).toBe("connecting");
    expect(restored.terminalGroups).toEqual([]);
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

    const persisted = persistWorkspaceState(restored.workspaces, "workspace-a", []);

    expect(persisted.workspaces[0]).not.toHaveProperty("bootDiagnostics");
    expect(JSON.stringify(persisted)).not.toContain("sensitive journal evidence");
  });
});
