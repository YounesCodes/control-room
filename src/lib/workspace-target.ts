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

export function isContainerWorkspace(workspace: Workspace): workspace is ContainerWorkspace {
  return isRemoteWorkspace(workspace) && !!workspace.container;
}

export function workspaceTargetKey(workspace: Workspace): string {
  if (isContainerWorkspace(workspace))
    return `container:${workspace.connectionId}:${workspace.container.id}`;
  return isRemoteWorkspace(workspace)
    ? `connection:${workspace.connectionId}`
    : `local:${workspace.shell.id}`;
}

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

export function createContainerWorkspace(
  connection: SavedConnection,
  container: ContainerTerminalTarget,
): ContainerWorkspace {
  return {
    ...createRemoteWorkspace(connection),
    container: { id: container.id, name: container.name, image: container.image },
  };
}

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
