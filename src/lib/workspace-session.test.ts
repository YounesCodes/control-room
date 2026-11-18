import { describe, expect, it } from "vitest";
import { createTerminalLayout, splitTerminalLayout } from "./terminal-layout";
import {
  closeWorkspaceInSession,
  removeConnectionFromSession,
  settleWorkspaceSession,
  type WorkspaceSession,
} from "./workspace-session";
import type { LocalWorkspace, RemoteWorkspace, Workspace } from "../types";
import { emptyCachedList } from "./workspace-cache";

function local(id: string, view: Workspace["view"] = "terminal"): LocalWorkspace {
  return {
    kind: "local",
    id,
    label: null,
    shell: { id: "pwsh", label: "PowerShell", kind: "powershell-7", elevated: false },
    sessionId: null,
    state: "connected",
    reason: null,
    view,
    reconnectToken: 0,
    connectRequested: true,
  };
}

function remote(id: string, connectionId: string): RemoteWorkspace {
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
    sessionId: null,
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

function session(patch: Partial<WorkspaceSession>): WorkspaceSession {
  return {
    workspaces: [],
    activeWorkspaceId: null,
    terminalGroups: [],
    terminalFocusMode: false,
    ...patch,
  };
}

const threePaneGroup = {
  id: "group",
  name: "Group 1",
  layout: splitTerminalLayout(
    splitTerminalLayout(createTerminalLayout("a"), "a", "b", "vertical"),
    "b",
    "c",
    "horizontal",
  ),
};

describe("Workspace session transitions", () => {
  it("leaves Focus Mode when no active Workspace remains", () => {
    expect(settleWorkspaceSession(session({ terminalFocusMode: true })).terminalFocusMode).toBe(
      false,
    );
    expect(
      settleWorkspaceSession(
        session({ workspaces: [local("a")], activeWorkspaceId: "gone", terminalFocusMode: true }),
      ).terminalFocusMode,
    ).toBe(false);
    const focused = session({
      workspaces: [local("a")],
      activeWorkspaceId: "a",
      terminalFocusMode: true,
    });
    expect(settleWorkspaceSession(focused)).toBe(focused);
  });

  it("selects the next pane of the closed Workspace's group in Focus Mode", () => {
    const next = closeWorkspaceInSession(
      session({
        workspaces: [local("a"), local("b", "services"), local("c"), local("d")],
        activeWorkspaceId: "a",
        terminalGroups: [threePaneGroup],
        terminalFocusMode: true,
      }),
      "a",
    );
    expect(next.activeWorkspaceId).toBe("b");
    expect(next.workspaces.find((workspace) => workspace.id === "b")?.view).toBe("terminal");
    expect(next.terminalGroups).toHaveLength(1);
    expect(next.terminalFocusMode).toBe(true);
  });

  it("selects the neighbouring tab outside Focus Mode", () => {
    const next = closeWorkspaceInSession(
      session({
        workspaces: [local("d"), local("a"), local("b"), local("c")],
        activeWorkspaceId: "a",
        terminalGroups: [threePaneGroup],
      }),
      "a",
    );
    expect(next.activeWorkspaceId).toBe("b");
  });

  it("keeps the active Workspace when another one closes", () => {
    const before = session({
      workspaces: [local("a"), local("b")],
      activeWorkspaceId: "a",
    });
    const next = closeWorkspaceInSession(before, "b");
    expect(next.activeWorkspaceId).toBe("a");
    expect(next.workspaces.map((workspace) => workspace.id)).toEqual(["a"]);
  });

  it("ignores a Workspace that is already gone", () => {
    const before = session({ workspaces: [local("a")], activeWorkspaceId: "a" });
    expect(closeWorkspaceInSession(before, "b")).toBe(before);
  });

  it("removes a deleted connection's Workspaces and keeps the rest", () => {
    const next = removeConnectionFromSession(
      session({
        workspaces: [remote("a", "host-a"), local("b"), remote("c", "host-a")],
        activeWorkspaceId: "a",
        terminalFocusMode: true,
      }),
      "host-a",
    );
    expect(next.workspaces.map((workspace) => workspace.id)).toEqual(["b"]);
    expect(next.activeWorkspaceId).toBe("b");
    expect(next.terminalFocusMode).toBe(true);
  });
});
