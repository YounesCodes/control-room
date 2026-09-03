import { emptyCachedList } from "./workspace-cache";
import type {
  LocalShellProfile,
  LocalWorkspace,
  RemoteWorkspace,
  SavedConnection,
  Workspace,
} from "../types";

export function isRemoteWorkspace(workspace: Workspace): workspace is RemoteWorkspace {
  return workspace.kind === "remote";
}

export function isLocalWorkspace(workspace: Workspace): workspace is LocalWorkspace {
  return workspace.kind === "local";
}

/// What a Workspace is attached to. Tabs on the same target are numbered
/// against each other, so a second PowerShell 7 reads as "PowerShell 7 2"
/// exactly as a second Workspace on one Saved Connection does.
export function workspaceTargetKey(workspace: Workspace): string {
  return isRemoteWorkspace(workspace)
    ? `connection:${workspace.connectionId}`
    : `local:${workspace.shell.id}`;
}

export function workspaceTargetName(workspace: Workspace): string {
  return isRemoteWorkspace(workspace)
    ? workspace.connectionSnapshot.displayName
    : workspace.shell.label;
}

/// A local shell runs and stops; a remote session connects and disconnects.
/// The lifecycle is identical, so only the words differ.
export function terminalStateLabel(workspace: Workspace): string {
  if (isRemoteWorkspace(workspace)) return workspace.state;
  switch (workspace.state) {
    case "connecting":
      return "starting";
    case "connected":
      return "running";
    case "disconnected":
      return "stopped";
    case "error":
      return "error";
  }
}

/// A new Workspace on a Remote Host, asked to connect.
export function createRemoteWorkspace(connection: SavedConnection): RemoteWorkspace {
  return {
    kind: "remote",
    id: crypto.randomUUID(),
    label: null,
    connectionId: connection.id,
    connectionSnapshot: { ...connection },
    sessionId: null,
    state: "connecting",
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

/// A new Workspace on a local Windows shell, asked to start. It carries no
/// Saved Connection, no inspection caches, and no History state, because a
/// local shell has none of those.
export function createLocalWorkspace(shell: LocalShellProfile): LocalWorkspace {
  return {
    kind: "local",
    id: crypto.randomUUID(),
    label: null,
    shell: { ...shell },
    sessionId: null,
    state: "connecting",
    reason: null,
    view: "terminal",
    reconnectToken: 0,
    connectRequested: true,
  };
}
