import type { TerminalLayout } from "./terminal-layout";
import { createLocalWorkspace, createRemoteWorkspace, isRemoteWorkspace } from "./workspace-target";
import type {
  LocalShellProfile,
  PersistedWorkspaceState,
  SavedConnection,
  Workspace,
} from "../types";

interface RestoredWorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  terminalLayout: TerminalLayout | null;
}

/// Rebuilds the saved tabs and split layout. Nothing is started here: every
/// restored Workspace comes back disconnected with no session and no connect
/// request, remote and local alike, so restarting the app never opens an SSH
/// connection or a local process on its own.
export function restoreWorkspaceState(
  connections: SavedConnection[],
  state: PersistedWorkspaceState,
  localShells: LocalShellProfile[] = [],
): RestoredWorkspaceState {
  const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
  const shellsById = new Map(localShells.map((shell) => [shell.id, shell]));
  const workspaces = state.workspaces.flatMap<Workspace>((saved) => {
    const dormant = {
      id: saved.id,
      label: saved.label,
      state: "disconnected",
      connectRequested: false,
    } as const;
    if (saved.localShellId) {
      // A shell that is no longer installed is dropped, the way a Workspace for
      // a deleted Saved Connection is.
      const shell = shellsById.get(saved.localShellId);
      if (!shell) return [];
      // A local Workspace is terminal-only, whatever view the payload names.
      return [{ ...createLocalWorkspace(shell), ...dormant, view: "terminal" }];
    }
    const connection = saved.connectionId ? connectionsById.get(saved.connectionId) : undefined;
    if (!connection) return [];
    return [
      {
        ...createRemoteWorkspace(connection),
        ...dormant,
        view: saved.view,
        historyPaused: saved.historyPaused,
      },
    ];
  });
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const activeWorkspaceId = workspaceIds.has(state.activeWorkspaceId ?? "")
    ? state.activeWorkspaceId
    : (workspaces[0]?.id ?? null);

  return {
    workspaces,
    activeWorkspaceId,
    terminalLayout: pruneTerminalLayout(state.terminalLayout, workspaceIds),
  };
}

export function persistWorkspaceState(
  workspaces: Workspace[],
  activeWorkspaceId: string | null,
  terminalLayout: TerminalLayout | null,
): PersistedWorkspaceState {
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  return {
    workspaces: workspaces.map((workspace) => ({
      id: workspace.id,
      label: workspace.label,
      connectionId: isRemoteWorkspace(workspace) ? workspace.connectionId : null,
      localShellId: isRemoteWorkspace(workspace) ? null : workspace.shell.id,
      view: workspace.view,
      historyPaused: isRemoteWorkspace(workspace) ? workspace.historyPaused : false,
    })),
    activeWorkspaceId: workspaceIds.has(activeWorkspaceId ?? "") ? activeWorkspaceId : null,
    terminalLayout: pruneTerminalLayout(terminalLayout, workspaceIds),
  };
}

function pruneTerminalLayout(
  layout: TerminalLayout | null,
  workspaceIds: Set<string>,
): TerminalLayout | null {
  if (!layout) return null;
  if (layout.kind === "leaf") return workspaceIds.has(layout.workspaceId) ? layout : null;
  const first = pruneTerminalLayout(layout.first, workspaceIds);
  const second = pruneTerminalLayout(layout.second, workspaceIds);
  if (!first) return second;
  if (!second) return first;
  return { ...layout, first, second };
}
