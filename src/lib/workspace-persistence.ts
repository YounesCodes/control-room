import { emptyCachedList } from "./workspace-cache";
import type { TerminalLayout } from "./terminal-layout";
import type { PersistedWorkspaceState, SavedConnection, Workspace } from "../types";

interface RestoredWorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  terminalLayout: TerminalLayout | null;
}

export function restoreWorkspaceState(
  connections: SavedConnection[],
  state: PersistedWorkspaceState,
): RestoredWorkspaceState {
  const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
  const workspaces = state.workspaces.flatMap<Workspace>((saved) => {
    const connection = connectionsById.get(saved.connectionId);
    if (!connection) return [];
    return [
      {
        id: saved.id,
        label: saved.label,
        connectionId: connection.id,
        connectionSnapshot: { ...connection },
        sessionId: null,
        state: "disconnected",
        reason: null,
        view: saved.view,
        historyPaused: saved.historyPaused,
        reconnectToken: 0,
        connectRequested: false,
        servicesCache: emptyCachedList(),
        containersCache: emptyCachedList(),
        logSource: null,
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
      connectionId: workspace.connectionId,
      view: workspace.view,
      historyPaused: workspace.historyPaused,
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
