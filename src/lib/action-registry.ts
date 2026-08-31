import type { ComponentType } from "react";
import { Copy, FileClock, Focus, Plus, RotateCcw, Settings, Terminal, X } from "lucide-react";
import { connectionTarget } from "./format";
import type {
  DockerContainer,
  HostCapabilities,
  SavedConnection,
  SystemdUnit,
  Workspace,
  WorkspaceView,
} from "../types";

export type ActionScope = "selection" | "workspace" | "navigation" | "global";
export type ActionIcon = ComponentType<{ size?: number; strokeWidth?: number }>;

export type PaletteSelection =
  | {
      kind: "systemd-unit";
      workspaceId: string;
      connectionId: string;
      item: SystemdUnit;
    }
  | {
      kind: "docker-container";
      workspaceId: string;
      connectionId: string;
      item: DockerContainer;
    };

export interface RegisteredAction {
  id: string;
  scope: ActionScope;
  group: string;
  label: string;
  sublabel?: string;
  osId?: string | null;
  icon?: ActionIcon;
  shortcut?: string;
  keywords?: string;
  disabledReason?: string;
  run: () => void;
}

export interface ActionRegistryContext {
  connections: SavedConnection[];
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  activeView: WorkspaceView | null;
  activeSavedConnection: SavedConnection | null;
  selection: PaletteSelection | null;
  views: { id: WorkspaceView; label: string; icon: ActionIcon }[];
  hostCapabilities: Record<string, HostCapabilities>;
  labelForWorkspace: (workspace: Workspace) => string;
}

export interface ActionRegistryHandlers {
  openConnection: (connection: SavedConnection) => void;
  selectWorkspace: (workspace: Workspace) => void;
  setView: (view: WorkspaceView) => void;
  newTerminal: () => void;
  reconnect: () => void;
  closeWorkspace: () => void;
  focusTerminal: () => void;
  addConnection: () => void;
  openSettings: () => void;
  openSelectionLogs: (selection: PaletteSelection) => void;
  copySelectionValue: (selection: PaletteSelection, value: "identity" | "compose-project") => void;
  copyWorkspaceTarget: (workspaceId: string) => void;
}

function currentSelection(context: ActionRegistryContext): PaletteSelection | null {
  const { activeWorkspace, selection } = context;
  if (
    !activeWorkspace ||
    !selection ||
    selection.workspaceId !== activeWorkspace.id ||
    selection.connectionId !== activeWorkspace.connectionId
  ) {
    return null;
  }
  const items =
    selection.kind === "systemd-unit"
      ? activeWorkspace.servicesCache.items
      : activeWorkspace.containersCache.items;
  return items.some((item) => item.id === selection.item.id) ? selection : null;
}

export function buildActionRegistry(
  context: ActionRegistryContext,
  handlers: ActionRegistryHandlers,
): RegisteredAction[] {
  const actions: RegisteredAction[] = [];
  const selection = currentSelection(context);
  const workspace = context.activeWorkspace;

  if (selection?.kind === "systemd-unit") {
    const capabilities = context.hostCapabilities[selection.connectionId];
    actions.push(
      {
        id: "systemd.open-journal",
        scope: "selection",
        group: "Selected unit",
        label: "Open journal",
        sublabel: selection.item.id,
        icon: FileClock,
        disabledReason:
          capabilities && !capabilities.journaldAvailable
            ? "journald was not detected for this connection"
            : undefined,
        run: () => handlers.openSelectionLogs(selection),
      },
      {
        id: "systemd.copy-name",
        scope: "selection",
        group: "Selected unit",
        label: "Copy unit name",
        sublabel: selection.item.id,
        icon: Copy,
        run: () => handlers.copySelectionValue(selection, "identity"),
      },
    );
  }

  if (selection?.kind === "docker-container") {
    actions.push(
      {
        id: "docker.open-logs",
        scope: "selection",
        group: "Selected container",
        label: "Open container logs",
        sublabel: selection.item.name,
        icon: FileClock,
        run: () => handlers.openSelectionLogs(selection),
      },
      {
        id: "docker.copy-id",
        scope: "selection",
        group: "Selected container",
        label: "Copy full container ID",
        sublabel: selection.item.name,
        icon: Copy,
        run: () => handlers.copySelectionValue(selection, "identity"),
      },
      {
        id: "docker.copy-compose-project",
        scope: "selection",
        group: "Selected container",
        label: "Copy Compose project",
        sublabel: selection.item.composeProject ?? undefined,
        icon: Copy,
        disabledReason: selection.item.composeProject
          ? undefined
          : "No validated Compose project label",
        run: () => handlers.copySelectionValue(selection, "compose-project"),
      },
    );
  }

  for (const candidate of context.workspaces) {
    if (candidate.id === workspace?.id) continue;
    actions.push({
      id: `workspace.select:${candidate.id}`,
      scope: "navigation",
      group: "Open terminals",
      label: context.labelForWorkspace(candidate),
      sublabel: connectionTarget(candidate.connectionSnapshot),
      osId: context.hostCapabilities[candidate.connectionId]?.osId,
      keywords: candidate.connectionSnapshot.destination,
      run: () => handlers.selectWorkspace(candidate),
    });
  }

  if (workspace) {
    for (const view of context.views) {
      if (view.id === context.activeView) continue;
      actions.push({
        id: `view.open:${view.id}`,
        scope: "navigation",
        group: "Go to",
        label: view.label,
        icon: view.icon,
        run: () => handlers.setView(view.id),
      });
    }
  }

  for (const connection of context.connections) {
    actions.push({
      id: `connection.open:${connection.id}`,
      scope: "navigation",
      group: "Open connection",
      label: connection.displayName,
      sublabel: connectionTarget(connection),
      osId: context.hostCapabilities[connection.id]?.osId,
      keywords: connection.destination,
      run: () => handlers.openConnection(connection),
    });
  }

  if (workspace) {
    actions.push(
      {
        id: "workspace.new-terminal",
        scope: "workspace",
        group: "Workspace",
        label: "New terminal",
        sublabel: "Another session for this connection",
        icon: Terminal,
        disabledReason: context.activeSavedConnection
          ? undefined
          : "The Saved Connection no longer exists",
        run: handlers.newTerminal,
      },
      {
        id: "workspace.reconnect",
        scope: "workspace",
        group: "Workspace",
        label: "Reconnect terminal",
        shortcut: "Ctrl+Shift+R",
        icon: RotateCcw,
        disabledReason:
          workspace.state === "connecting" ? "A connection attempt is already running" : undefined,
        run: handlers.reconnect,
      },
      {
        id: "workspace.focus-terminal",
        scope: "workspace",
        group: "Workspace",
        label: "Focus terminal",
        icon: Focus,
        disabledReason:
          context.activeView === "terminal"
            ? undefined
            : "Switch to Terminal before entering focus mode",
        run: handlers.focusTerminal,
      },
      {
        id: "workspace.copy-target",
        scope: "workspace",
        group: "Workspace",
        label: "Copy SSH target",
        sublabel: connectionTarget(workspace.connectionSnapshot),
        icon: Copy,
        run: () => handlers.copyWorkspaceTarget(workspace.id),
      },
      {
        id: "workspace.close",
        scope: "workspace",
        group: "Workspace",
        label: "Close workspace",
        shortcut: "Ctrl+Shift+W",
        icon: X,
        run: handlers.closeWorkspace,
      },
    );
  }

  actions.push(
    {
      id: "app.add-connection",
      scope: "global",
      group: "Actions",
      label: "Add connection",
      icon: Plus,
      run: handlers.addConnection,
    },
    {
      id: "app.open-settings",
      scope: "global",
      group: "Actions",
      label: "Open settings",
      icon: Settings,
      run: handlers.openSettings,
    },
  );

  return actions;
}
