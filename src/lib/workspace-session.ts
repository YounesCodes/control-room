import { getTerminalLayoutIds } from "./terminal-layout";
import {
  pruneTerminalGroups,
  terminalGroupForWorkspace,
  type TerminalGroup,
} from "./terminal-groups";
import { removeConnectionWorkspaces } from "./workspace-lifecycle";
import type { Workspace } from "../types";

export interface WorkspaceSession {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  terminalGroups: TerminalGroup[];
  terminalFocusMode: boolean;
}

export const emptyWorkspaceSession: WorkspaceSession = {
  workspaces: [],
  activeWorkspaceId: null,
  terminalGroups: [],
  terminalFocusMode: false,
};

export function settleWorkspaceSession(session: WorkspaceSession): WorkspaceSession {
  const focusHasTerminal = session.workspaces.some(
    (workspace) => workspace.id === session.activeWorkspaceId,
  );
  return session.terminalFocusMode && !focusHasTerminal
    ? { ...session, terminalFocusMode: false }
    : session;
}

export function closeWorkspaceInSession(session: WorkspaceSession, id: string): WorkspaceSession {
  const index = session.workspaces.findIndex((item) => item.id === id);
  if (index < 0) return session;
  const remaining = session.workspaces.filter((item) => item.id !== id);
  const previousGroup = terminalGroupForWorkspace(session.terminalGroups, id);
  const terminalGroups = pruneTerminalGroups(
    session.terminalGroups,
    new Set(remaining.map((item) => item.id)),
  );
  if (session.activeWorkspaceId !== id)
    return { ...session, workspaces: remaining, terminalGroups };
  const remainingGroup = previousGroup
    ? terminalGroups.find((group) => group.id === previousGroup.id)
    : null;
  const remainingSplitIds = remainingGroup
    ? getTerminalLayoutIds(remainingGroup.layout)
    : previousGroup
      ? getTerminalLayoutIds(previousGroup.layout).filter((memberId) => memberId !== id)
      : [];
  const keepFocusGroup = session.terminalFocusMode && previousGroup;
  const nextActive =
    (keepFocusGroup ? remaining.find((item) => item.id === remainingSplitIds[0]) : null) ??
    remaining[Math.min(index, remaining.length - 1)] ??
    null;
  return {
    ...session,
    workspaces:
      keepFocusGroup && nextActive
        ? remaining.map((item) =>
            item.id === nextActive.id ? { ...item, view: "terminal" } : item,
          )
        : remaining,
    activeWorkspaceId: nextActive?.id ?? null,
    terminalGroups,
  };
}

export function removeConnectionFromSession(
  session: WorkspaceSession,
  connectionId: string,
): WorkspaceSession {
  const removal = removeConnectionWorkspaces(
    session.workspaces,
    connectionId,
    session.activeWorkspaceId,
    session.terminalGroups,
  );
  return {
    ...session,
    workspaces: removal.remaining,
    activeWorkspaceId: removal.nextActiveId,
    terminalGroups: removal.nextGroups,
  };
}
