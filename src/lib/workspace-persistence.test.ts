import { describe, expect, it } from "vitest";
import { createTerminalLayout, splitTerminalLayout } from "./terminal-layout";
import { persistWorkspaceState, restoreWorkspaceState } from "./workspace-persistence";
import type { PersistedWorkspaceState, SavedConnection } from "../types";

function connection(id: string): SavedConnection {
  return {
    id,
    displayName: id,
    destination: id,
    username: "user",
    port: null,
    identityFile: null,
    historyEnabled: false,
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
          view: "terminal",
          historyPaused: false,
        },
        {
          id: "workspace-b",
          label: null,
          connectionId: "connection-b",
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
          view: "terminal",
          historyPaused: false,
        },
        {
          id: "workspace-b",
          label: null,
          connectionId: "missing",
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

  it("keeps resource samples out of persisted Workspace state", () => {
    const state: PersistedWorkspaceState = {
      workspaces: [
        {
          id: "workspace-a",
          label: null,
          connectionId: "connection-a",
          view: "resources",
          historyPaused: false,
        },
      ],
      activeWorkspaceId: "workspace-a",
      terminalLayout: null,
    };
    const restored = restoreWorkspaceState([connection("connection-a")], state);
    restored.workspaces[0].resourceSnapshot = {
      id: "sample-a",
      collectedAt: "2026-08-31T12:00:00Z",
      cpu: {
        collectedAt: "2026-08-31T12:00:00Z",
        data: { cpuCount: 4, loadOne: 1, loadFive: 1, loadFifteen: 1 },
        error: null,
      },
      memory: {
        collectedAt: "2026-08-31T12:00:00Z",
        data: {
          totalBytes: 8,
          availableBytes: 4,
          usedBytes: 4,
          swapTotalBytes: 0,
          swapUsedBytes: 0,
        },
        error: null,
      },
      filesystems: { collectedAt: "2026-08-31T12:00:00Z", data: [], error: null },
      processes: {
        collectedAt: "2026-08-31T12:00:00Z",
        data: { sort: "CPU usage descending", limit: 10, rows: [] },
        error: null,
      },
    };

    const persisted = persistWorkspaceState(restored.workspaces, "workspace-a", null);

    expect(persisted.workspaces[0]).not.toHaveProperty("resourceSnapshot");
    expect(JSON.stringify(persisted)).not.toContain("sample-a");
  });
});
