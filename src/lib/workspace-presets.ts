import type { TerminalLayout } from "./terminal-layout";
import { emptyCachedList } from "./workspace-cache";
import type {
  HostCapabilities,
  SavedConnection,
  Workspace,
  WorkspacePreset,
  WorkspacePresetInput,
  WorkspacePresetLayout,
  WorkspacePresetSelector,
  WorkspacePresetView,
  WorkspaceView,
} from "../types";

const viewLabels: Record<WorkspaceView, string> = {
  overview: "Overview",
  terminal: "Terminal",
  services: "Systemd",
  ports: "Ports",
  docker: "Docker",
  logs: "Logs",
  history: "History",
  scratchpad: "Scratchpad",
};

const supportedViews = new Set<WorkspaceView>(Object.keys(viewLabels) as WorkspaceView[]);

export function isSupportedWorkspacePresetView(view: string): view is WorkspaceView {
  return supportedViews.has(view as WorkspaceView);
}

function selectorForWorkspace(workspace: Workspace): WorkspacePresetSelector | null {
  if (workspace.view === "services" && workspace.systemdSelectionId) {
    return { kind: "systemdUnit", unit: workspace.systemdSelectionId };
  }
  if (workspace.view === "docker" && workspace.containerSelectionId) {
    return { kind: "dockerContainer", container: workspace.containerSelectionId };
  }
  if (workspace.view === "logs" && workspace.logSource) {
    return {
      kind: "logSource",
      sourceType: workspace.logSource.type,
      id: workspace.logSource.id,
    };
  }
  return null;
}

function captureLayout(
  layout: TerminalLayout | null,
  keysByWorkspace: Map<string, string>,
): WorkspacePresetLayout | null {
  if (!layout) return null;
  if (layout.kind === "leaf") {
    const viewKey = keysByWorkspace.get(layout.workspaceId);
    return viewKey ? { kind: "leaf", viewKey } : null;
  }
  const first = captureLayout(layout.first, keysByWorkspace);
  const second = captureLayout(layout.second, keysByWorkspace);
  if (!first) return second;
  if (!second) return first;
  return { kind: "split", direction: layout.direction, first, second };
}

export function captureWorkspacePreset(
  name: string,
  connectionId: string,
  workspaces: Workspace[],
  terminalLayout: TerminalLayout | null,
  createKey: () => string = () => crypto.randomUUID(),
): WorkspacePresetInput {
  const captured = workspaces.filter((workspace) => workspace.connectionId === connectionId);
  const keysByWorkspace = new Map(captured.map((workspace) => [workspace.id, createKey()]));
  return {
    name,
    views: captured.map((workspace) => ({
      key: keysByWorkspace.get(workspace.id)!,
      label: workspace.label,
      view: workspace.view,
      selector: selectorForWorkspace(workspace),
    })),
    layout: captureLayout(terminalLayout, keysByWorkspace),
  };
}

function applyLayout(
  layout: WorkspacePresetLayout | null,
  workspacesByKey: Map<string, Workspace>,
): TerminalLayout | null {
  if (!layout) return null;
  if (layout.kind === "leaf") {
    const workspace = workspacesByKey.get(layout.viewKey);
    return workspace ? { kind: "leaf", workspaceId: workspace.id } : null;
  }
  const first = applyLayout(layout.first, workspacesByKey);
  const second = applyLayout(layout.second, workspacesByKey);
  if (!first) return second;
  if (!second) return first;
  return { kind: "split", direction: layout.direction, first, second };
}

function workspaceFromDescriptor(
  preset: WorkspacePreset,
  descriptor: WorkspacePresetView & { view: WorkspaceView },
  connection: SavedConnection,
  createId: () => string,
): Workspace {
  const selector = descriptor.selector;
  return {
    id: createId(),
    label: `${preset.name} · ${descriptor.label?.trim() || viewLabels[descriptor.view]}`,
    connectionId: connection.id,
    connectionSnapshot: { ...connection },
    sessionId: null,
    state: "disconnected",
    reason: "Created from a Workspace Preset. Connect when ready.",
    view: descriptor.view,
    historyPaused: false,
    reconnectToken: 0,
    connectRequested: false,
    servicesCache: emptyCachedList(),
    portsCache: emptyCachedList(),
    containersCache: emptyCachedList(),
    containerDetailsCache: {},
    systemdSelectionId: selector?.kind === "systemdUnit" ? selector.unit : null,
    containerSelectionId: selector?.kind === "dockerContainer" ? selector.container : null,
    logSource:
      selector?.kind === "logSource" ? { type: selector.sourceType, id: selector.id } : null,
  };
}

export function applyWorkspacePreset(
  preset: WorkspacePreset,
  connection: SavedConnection,
  createId: () => string = () => crypto.randomUUID(),
) {
  const applicableViews = preset.views.filter(
    (descriptor): descriptor is WorkspacePresetView & { view: WorkspaceView } =>
      isSupportedWorkspacePresetView(descriptor.view),
  );
  const workspaces = applicableViews.map((descriptor) =>
    workspaceFromDescriptor(preset, descriptor, connection, createId),
  );
  const workspacesByKey = new Map(
    applicableViews.map((descriptor, index) => [descriptor.key, workspaces[index]]),
  );
  return {
    workspaces,
    activeWorkspaceId: workspaces[0]?.id ?? null,
    terminalLayout: applyLayout(preset.layout, workspacesByKey),
  };
}

export function workspacePresetViewStatus(
  descriptor: WorkspacePresetView,
  capabilities: HostCapabilities | null,
) {
  if (!isSupportedWorkspacePresetView(descriptor.view)) {
    return { supported: false, detail: "View type is not supported by this app version" };
  }
  const needsSystemd =
    descriptor.view === "services" ||
    (descriptor.selector?.kind === "logSource" && descriptor.selector.sourceType === "systemd");
  const needsDocker =
    descriptor.view === "docker" ||
    (descriptor.selector?.kind === "logSource" && descriptor.selector.sourceType === "docker");
  if (capabilities && needsSystemd && !capabilities.systemdAvailable) {
    return { supported: false, detail: "systemd was not detected on this host" };
  }
  if (capabilities && needsDocker && !capabilities.dockerAvailable) {
    return { supported: false, detail: "Docker was not detected on this host" };
  }
  if (!capabilities && (needsSystemd || needsDocker)) {
    return { supported: null, detail: "Host support will be checked after connection" };
  }
  if (descriptor.selector) {
    return { supported: true, detail: "Exact target will be resolved after connection" };
  }
  return { supported: true, detail: "Available" };
}

export function workspacePresetViewLabel(view: string) {
  return isSupportedWorkspacePresetView(view) ? viewLabels[view] : view;
}

function remapPresetLayout(
  layout: WorkspacePresetLayout | null,
  keys: Map<string, string>,
): WorkspacePresetLayout | null {
  if (!layout) return null;
  if (layout.kind === "leaf") {
    const viewKey = keys.get(layout.viewKey);
    return viewKey ? { kind: "leaf", viewKey } : null;
  }
  const first = remapPresetLayout(layout.first, keys);
  const second = remapPresetLayout(layout.second, keys);
  if (!first) return second;
  if (!second) return first;
  return { kind: "split", direction: layout.direction, first, second };
}

export function duplicateWorkspacePresetInput(
  preset: WorkspacePreset,
  name: string,
  createKey: () => string = () => crypto.randomUUID(),
): WorkspacePresetInput {
  const keys = new Map(preset.views.map((view) => [view.key, createKey()]));
  return {
    name,
    views: preset.views.map((view) => ({ ...view, key: keys.get(view.key)! })),
    layout: remapPresetLayout(preset.layout, keys),
  };
}
