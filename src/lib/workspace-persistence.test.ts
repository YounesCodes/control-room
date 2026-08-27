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
});
