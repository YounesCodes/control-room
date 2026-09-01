import { describe, expect, it } from "vitest";
import { createTerminalLayout, splitTerminalLayout } from "./terminal-layout";
import { emptyCachedList } from "./workspace-cache";
import {
  removeConnectionWorkspaces,
  updateWorkspaceConnectionSnapshots,
  workspaceDisplayLabel,
} from "./workspace-lifecycle";
import type { Workspace } from "../types";

function workspace(id: string, connectionId: string): Workspace {
  return {
    id,
    label: null,
    connectionId,
    connectionSnapshot: {
      id: connectionId,
      displayName: connectionId,
      destination: connectionId,
      username: "user",
      port: null,
      identityFile: null,
      historyEnabled: false,
      groupId: null,
      tags: [],
      createdAt: "",
      updatedAt: "",
      lastConnectedAt: null,
    },
    sessionId: `${id}-session`,
    state: "connected",
    reason: null,
    view: "terminal",
    historyPaused: false,
    reconnectToken: 0,
    connectRequested: true,
    servicesCache: emptyCachedList(),
    portsCache: emptyCachedList(),
    containersCache: emptyCachedList(),
    systemdSelectionId: null,
    containerSelectionId: null,
    containerDetailsCache: {},
    logSource: null,
  };
}

describe("Saved Connection workspace removal", () => {
  it("selects and preserves an unrelated Workspace when the active connection is deleted", () => {
    const first = workspace("first", "connection-a");
    const second = workspace("second", "connection-b");
    const layout = splitTerminalLayout(
      createTerminalLayout(first.id),
      first.id,
      second.id,
      "vertical",
    );

    const result = removeConnectionWorkspaces(
      [first, second],
      first.connectionId,
      first.id,
      layout,
    );

    expect(result.removed).toEqual([first]);
    expect(result.remaining).toEqual([second]);
    expect(result.nextActiveId).toBe(second.id);
    expect(result.nextLayout).toEqual(createTerminalLayout(second.id));
  });

  it("keeps the current active Workspace when another connection is deleted", () => {
    const first = workspace("first", "connection-a");
    const second = workspace("second", "connection-b");

    const result = removeConnectionWorkspaces(
      [first, second],
      second.connectionId,
      first.id,
      createTerminalLayout(first.id),
    );

    expect(result.nextActiveId).toBe(first.id);
    expect(result.remaining).toEqual([first]);
  });
});

describe("Saved Connection edits", () => {
  it("updates open Workspace details without replacing its running session", () => {
    const current = workspace("first", "connection-a");
    const updatedConnection = {
      ...current.connectionSnapshot,
      displayName: "Renamed host",
      destination: "new-host",
      updatedAt: "later",
    };

    const [updated] = updateWorkspaceConnectionSnapshots([current], updatedConnection);

    expect(updated.connectionSnapshot).toEqual(updatedConnection);
    expect(updated.sessionId).toBe(current.sessionId);
    expect(updated.state).toBe("connected");
  });
});

describe("Workspace labels", () => {
  it("uses a custom label without changing the Saved Connection name", () => {
    const first = workspace("first", "connection-a");
    const second = { ...workspace("second", "connection-a"), label: "Deploy" };

    expect(workspaceDisplayLabel(first, [first, second])).toBe("connection-a");
    expect(workspaceDisplayLabel(second, [first, second])).toBe("Deploy");
    expect(second.connectionSnapshot.displayName).toBe("connection-a");
  });
});
