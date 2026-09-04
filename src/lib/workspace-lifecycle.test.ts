import { describe, expect, it } from "vitest";
import { createTerminalLayout, splitTerminalLayout } from "./terminal-layout";
import { emptyCachedList } from "./workspace-cache";
import {
  removeConnectionWorkspaces,
  updateWorkspaceConnectionSnapshots,
  workspaceDisplayLabel,
} from "./workspace-lifecycle";
import type { LocalWorkspace, RemoteWorkspace } from "../types";

function workspace(id: string, connectionId: string): RemoteWorkspace {
  return {
    kind: "remote",
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
      sudoEnabled: false,
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
    bootDiagnostics: null,
    logSource: null,
    baselineSelectionId: null,
  };
}

function localWorkspace(id: string, shellId: string, label: string): LocalWorkspace {
  return {
    kind: "local",
    id,
    label: null,
    shell: { id: shellId, label, kind: "powershell-7" },
    sessionId: `${id}-session`,
    state: "connected",
    reason: null,
    view: "terminal",
    reconnectToken: 0,
    connectRequested: true,
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

  it("leaves local Workspaces open when a Saved Connection is deleted", () => {
    // A local shell has no Saved Connection to lose, so deleting one must not
    // touch it or its session.
    const remote = workspace("remote", "connection-a");
    const local = localWorkspace("local", "powershell-7", "PowerShell 7");

    const result = removeConnectionWorkspaces(
      [remote, local],
      remote.connectionId,
      remote.id,
      splitTerminalLayout(createTerminalLayout(remote.id), remote.id, local.id, "vertical"),
    );

    expect(result.removed).toEqual([remote]);
    expect(result.remaining).toEqual([local]);
    expect(result.nextActiveId).toBe(local.id);
    expect(updateWorkspaceConnectionSnapshots([local], remote.connectionSnapshot)).toEqual([local]);
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

    const [updated] = updateWorkspaceConnectionSnapshots(
      [current],
      updatedConnection,
    ) as RemoteWorkspace[];

    expect(updated.connectionSnapshot).toEqual(updatedConnection);
    expect(updated.sessionId).toBe(current.sessionId);
    expect(updated.state).toBe("connected");
  });
});

describe("Workspace labels", () => {
  it("numbers local terminals of the same shell against each other", () => {
    const first = localWorkspace("first", "powershell-7", "PowerShell 7");
    const second = localWorkspace("second", "powershell-7", "PowerShell 7");
    const bash = localWorkspace("bash", "git-bash", "Git Bash");
    const remote = workspace("remote", "connection-a");
    const open = [first, second, bash, remote];

    expect(workspaceDisplayLabel(first, open)).toBe("PowerShell 7");
    expect(workspaceDisplayLabel(second, open)).toBe("PowerShell 7 2");
    // A different shell starts its own numbering, as a different connection does.
    expect(workspaceDisplayLabel(bash, open)).toBe("Git Bash");
    expect(workspaceDisplayLabel(remote, open)).toBe("connection-a");
  });

  it("uses a custom label without changing the Saved Connection name", () => {
    const first = workspace("first", "connection-a");
    const second = { ...workspace("second", "connection-a"), label: "Deploy" };

    expect(workspaceDisplayLabel(first, [first, second])).toBe("connection-a");
    expect(workspaceDisplayLabel(second, [first, second])).toBe("Deploy");
    expect(second.connectionSnapshot.displayName).toBe("connection-a");
  });
});
