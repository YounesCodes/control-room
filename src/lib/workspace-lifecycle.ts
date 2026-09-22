import { getTerminalLayoutIds } from "./terminal-layout";
import {
  pruneTerminalGroups,
  terminalGroupForWorkspace,
  type TerminalGroup,
} from "./terminal-groups";
import { isRemoteWorkspace, workspaceTargetKey, workspaceTargetName } from "./workspace-target";
import type { SavedConnection, Workspace } from "../types";

interface RemovedConnectionWorkspaces {
  remaining: Workspace[];
  removed: Workspace[];
  nextActiveId: string | null;
  nextGroups: TerminalGroup[];
}

export function removeConnectionWorkspaces(
  workspaces: Workspace[],
  connectionId: string,
  activeWorkspaceId: string | null,
  terminalGroups: TerminalGroup[],
): RemovedConnectionWorkspaces {
  // Deleting a Saved Connection touches its own Workspaces only. Local
  // Workspaces have no connection to lose and stay open.
  const belongsToConnection = (workspace: Workspace) =>
    isRemoteWorkspace(workspace) && workspace.connectionId === connectionId;
  const removed = workspaces.filter(belongsToConnection);
  const remaining = workspaces.filter((workspace) => !belongsToConnection(workspace));
  const activeIndex = workspaces.findIndex((workspace) => workspace.id === activeWorkspaceId);
  const activeWasRemoved = removed.some((workspace) => workspace.id === activeWorkspaceId);
  const activeGroup = terminalGroupForWorkspace(terminalGroups, activeWorkspaceId);
  const nextGroups = pruneTerminalGroups(
    terminalGroups,
    new Set(remaining.map((workspace) => workspace.id)),
  );

  if (!activeWasRemoved) {
    return { remaining, removed, nextActiveId: activeWorkspaceId, nextGroups };
  }

  const nextGroup = activeGroup
    ? (nextGroups.find((group) => group.id === activeGroup.id) ?? null)
    : null;
  const nextLayoutId = nextGroup ? getTerminalLayoutIds(nextGroup.layout)[0] : null;
  const nextActive =
    remaining.find((workspace) => workspace.id === nextLayoutId) ??
    remaining[Math.min(Math.max(activeIndex, 0), remaining.length - 1)] ??
    null;

  return {
    remaining,
    removed,
    nextActiveId: nextActive?.id ?? null,
    nextGroups,
  };
}

export function updateWorkspaceConnectionSnapshots(
  workspaces: Workspace[],
  connection: SavedConnection,
): Workspace[] {
  return workspaces.map((workspace) =>
    isRemoteWorkspace(workspace) && workspace.connectionId === connection.id
      ? { ...workspace, connectionSnapshot: { ...connection } }
      : workspace,
  );
}

export function workspaceDisplayLabel(workspace: Workspace, workspaces: Workspace[]): string {
  const custom = workspace.label?.trim();
  if (custom) return custom;
  const key = workspaceTargetKey(workspace);
  const siblings = workspaces.filter((item) => workspaceTargetKey(item) === key);
  const position = siblings.findIndex((item) => item.id === workspace.id);
  const name = workspaceTargetName(workspace);
  return position > 0 ? `${name} ${position + 1}` : name;
}
