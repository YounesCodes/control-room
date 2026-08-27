import {
  getTerminalLayoutIds,
  removeTerminalFromLayout,
  type TerminalLayout,
} from "./terminal-layout";
import type { Workspace } from "../types";

interface RemovedConnectionWorkspaces {
  remaining: Workspace[];
  removed: Workspace[];
  nextActiveId: string | null;
  nextLayout: TerminalLayout | null;
}

export function removeConnectionWorkspaces(
  workspaces: Workspace[],
  connectionId: string,
  activeWorkspaceId: string | null,
  terminalLayout: TerminalLayout | null,
): RemovedConnectionWorkspaces {
  const removed = workspaces.filter((workspace) => workspace.connectionId === connectionId);
  const remaining = workspaces.filter((workspace) => workspace.connectionId !== connectionId);
  const activeIndex = workspaces.findIndex((workspace) => workspace.id === activeWorkspaceId);
  const activeWasRemoved = removed.some((workspace) => workspace.id === activeWorkspaceId);
  const nextLayout = removed.reduce<TerminalLayout | null>(
    (layout, workspace) => (layout ? removeTerminalFromLayout(layout, workspace.id) : null),
    terminalLayout,
  );

  if (!activeWasRemoved) {
    return { remaining, removed, nextActiveId: activeWorkspaceId, nextLayout };
  }

  const nextLayoutId = nextLayout ? getTerminalLayoutIds(nextLayout)[0] : null;
  const nextActive =
    remaining.find((workspace) => workspace.id === nextLayoutId) ??
    remaining[Math.min(Math.max(activeIndex, 0), remaining.length - 1)] ??
    null;

  return {
    remaining,
    removed,
    nextActiveId: nextActive?.id ?? null,
    nextLayout,
  };
}

export function updateWorkspaceConnectionSnapshots(
  workspaces: Workspace[],
  connection: Workspace["connectionSnapshot"],
): Workspace[] {
  return workspaces.map((workspace) =>
    workspace.connectionId === connection.id
      ? { ...workspace, connectionSnapshot: { ...connection } }
      : workspace,
  );
}

export function workspaceDisplayLabel(workspace: Workspace, workspaces: Workspace[]): string {
  const custom = workspace.label?.trim();
  if (custom) return custom;
  const siblings = workspaces.filter((item) => item.connectionId === workspace.connectionId);
  const position = siblings.findIndex((item) => item.id === workspace.id);
  return position > 0
    ? `${workspace.connectionSnapshot.displayName} ${position + 1}`
    : workspace.connectionSnapshot.displayName;
}
