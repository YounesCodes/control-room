import { emptyCachedList } from "./workspace-cache";
import type {
  ContainerTerminalTarget,
  LocalShellProfile,
  LocalWorkspace,
  RemoteWorkspace,
  RemoteShellProfile,
  SavedConnection,
  Workspace,
} from "../types";

export function isRemoteWorkspace(workspace: Workspace): workspace is RemoteWorkspace {
  return workspace.kind === "remote";
}

export function isLocalWorkspace(workspace: Workspace): workspace is LocalWorkspace {
  return workspace.kind === "local";
}

export type ContainerWorkspace = RemoteWorkspace & { container: ContainerTerminalTarget };

/// A Container Terminal: a shell inside one container on a Remote Host. It
/// belongs to its host's Saved Connection but is terminal-only.
export function isContainerWorkspace(workspace: Workspace): workspace is ContainerWorkspace {
  return isRemoteWorkspace(workspace) && !!workspace.container;
}

/// What a Workspace is attached to. Tabs on the same target are numbered
/// against each other, so a second PowerShell 7 reads as "PowerShell 7 2"
/// exactly as a second Workspace on one Saved Connection does. A container is
/// its own target, so its terminal is never numbered against the host's.
export function workspaceTargetKey(workspace: Workspace): string {
  if (isContainerWorkspace(workspace))
    return `container:${workspace.connectionId}:${workspace.container.id}`;
  return isRemoteWorkspace(workspace)
    ? `connection:${workspace.connectionId}`
    : `local:${workspace.shell.id}`;
}

/// The host a Container Terminal runs on, shown beside the container's name
/// wherever the name alone would not say which host it is.
export function workspaceHostContext(workspace: Workspace): string | null {
  return isContainerWorkspace(workspace) ? workspace.connectionSnapshot.displayName : null;
}

export function workspaceTargetName(workspace: Workspace): string {
  if (isContainerWorkspace(workspace)) return workspace.container.name;
  return isRemoteWorkspace(workspace)
    ? workspace.remoteShell
      ? `${workspace.connectionSnapshot.displayName} · ${workspace.remoteShell.label}`
      : workspace.connectionSnapshot.displayName
    : workspace.shell.elevated
      ? `${workspace.shell.label} (Administrator)`
      : workspace.shell.label;
}

/// A local shell runs and stops; a remote session connects and disconnects.
/// The lifecycle is identical, so only the words differ.
export function terminalStateLabel(workspace: Workspace): string {
  if (workspace.restored && !workspace.connectRequested) {
    return isRemoteWorkspace(workspace) ? "not connected" : "not started";
  }
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
export function createRemoteWorkspace(
  connection: SavedConnection,
  remoteShell?: RemoteShellProfile | null,
): RemoteWorkspace {
  return {
    kind: "remote",
    id: crypto.randomUUID(),
    label: null,
    connectionId: connection.id,
    connectionSnapshot: { ...connection },
    ...(remoteShell ? { remoteShell } : {}),
    sessionId: null,
    state: "connecting",
    reason: null,
    view: "terminal",
    historyPaused: false,
    reconnectToken: 0,
    connectRequested: true,
    restored: false,
    servicesCache: emptyCachedList(),
    portsCache: emptyCachedList(),
    containersCache: emptyCachedList(),
    systemdSelectionId: null,
    containerSelectionId: null,
    containerDetailsCache: {},
    logSource: null,
  };
}

/// A new Container Terminal on a Remote Host, asked to connect. It starts in
/// its terminal and has no inspection pages of its own.
export function createContainerWorkspace(
  connection: SavedConnection,
  container: ContainerTerminalTarget,
): ContainerWorkspace {
  return {
    ...createRemoteWorkspace(connection),
    container: { id: container.id, name: container.name, image: container.image },
  };
}

/// A new Workspace on a local shell, asked to start. It carries no
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
    restored: false,
  };
}
