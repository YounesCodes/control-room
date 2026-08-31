import { describe, expect, it, vi } from "vitest";
import {
  buildActionRegistry,
  type ActionRegistryContext,
  type PaletteSelection,
} from "./action-registry";
import { emptyCachedList } from "./workspace-cache";
import type { DockerContainer, SavedConnection, SystemdUnit, Workspace } from "../types";

const connection: SavedConnection = {
  id: "connection-a",
  displayName: "Host A",
  destination: "host-a",
  username: "user",
  port: null,
  identityFile: null,
  historyEnabled: false,
  groupId: null,
  tags: [],
  createdAt: "",
  updatedAt: "",
  lastConnectedAt: null,
};

const unit: SystemdUnit = {
  id: "nginx.service",
  unitType: "service",
  description: "Web server",
  loadState: "loaded",
  activeState: "active",
  subState: "running",
  unitFileState: "enabled",
};

const container: DockerContainer = {
  id: "a".repeat(64),
  name: "web-1",
  image: "example/web:latest",
  state: "running",
  status: "Up",
  ports: "0.0.0.0:8080->80/tcp",
  createdAt: "now",
  composeProject: "site",
  composeService: "web",
  composeContainerNumber: 1,
  composeOneoff: false,
};

function workspace(patch: Partial<Workspace> = {}): Workspace {
  return {
    id: "workspace-a",
    label: null,
    connectionId: connection.id,
    connectionSnapshot: connection,
    sessionId: null,
    state: "connected",
    reason: null,
    view: "services",
    historyPaused: false,
    reconnectToken: 0,
    connectRequested: false,
    servicesCache: { items: [unit], fetchedAt: 1, loading: false, error: null },
    portsCache: emptyCachedList(),
    containersCache: { items: [container], fetchedAt: 1, loading: false, error: null },
    systemdSelectionId: null,
    containerSelectionId: null,
    containerDetailsCache: {},
    logSource: null,
    ...patch,
  };
}

function context(
  activeWorkspace: Workspace | null,
  selection: PaletteSelection | null,
): ActionRegistryContext {
  return {
    connections: [connection],
    workspaces: activeWorkspace ? [activeWorkspace] : [],
    activeWorkspace,
    activeView: activeWorkspace?.view ?? null,
    activeSavedConnection: activeWorkspace ? connection : null,
    selection,
    views: [],
    hostCapabilities: {},
    labelForWorkspace: () => "Host A",
  };
}

function handlers() {
  return {
    openConnection: vi.fn(),
    selectWorkspace: vi.fn(),
    setView: vi.fn(),
    newTerminal: vi.fn(),
    reconnect: vi.fn(),
    closeWorkspace: vi.fn(),
    focusTerminal: vi.fn(),
    addConnection: vi.fn(),
    openSettings: vi.fn(),
    openSelectionLogs: vi.fn(),
    copySelectionValue: vi.fn(),
    copyWorkspaceTarget: vi.fn(),
  };
}

describe("typed action registry", () => {
  it("shows only navigation and global actions without a Workspace or selection", () => {
    const actions = buildActionRegistry(context(null, null), handlers());
    expect(actions.map((action) => action.id)).toEqual([
      `connection.open:${connection.id}`,
      "app.add-connection",
      "app.open-settings",
    ]);
    expect(actions.every((action) => action.scope !== "selection")).toBe(true);
  });

  it("ranks valid service actions first and passes stable identity to handlers", () => {
    const active = workspace();
    const selection: PaletteSelection = {
      kind: "systemd-unit",
      workspaceId: active.id,
      connectionId: active.connectionId,
      item: unit,
    };
    const callbacks = handlers();
    const actions = buildActionRegistry(context(active, selection), callbacks);
    expect(actions.slice(0, 2).map((action) => action.id)).toEqual([
      "systemd.open-journal",
      "systemd.copy-name",
    ]);
    actions[0].run();
    expect(callbacks.openSelectionLogs).toHaveBeenCalledWith(selection);
  });

  it("drops selection actions when the selected identity is stale", () => {
    const active = workspace({
      servicesCache: { items: [], fetchedAt: 2, loading: false, error: null },
    });
    const selection: PaletteSelection = {
      kind: "systemd-unit",
      workspaceId: active.id,
      connectionId: active.connectionId,
      item: unit,
    };
    expect(
      buildActionRegistry(context(active, selection), handlers()).some(
        (action) => action.scope === "selection",
      ),
    ).toBe(false);
  });

  it("exposes container actions and explains unavailable Compose context", () => {
    const withoutCompose = { ...container, composeProject: null };
    const active = workspace({
      view: "docker",
      containersCache: { items: [withoutCompose], fetchedAt: 2, loading: false, error: null },
    });
    const selection: PaletteSelection = {
      kind: "docker-container",
      workspaceId: active.id,
      connectionId: active.connectionId,
      item: withoutCompose,
    };
    const actions = buildActionRegistry(context(active, selection), handlers());
    expect(actions.slice(0, 3).map((action) => action.id)).toEqual([
      "docker.open-logs",
      "docker.copy-id",
      "docker.copy-compose-project",
    ]);
    expect(actions[2].disabledReason).toBe("No validated Compose project label");
  });

  it("uses connection and view state for deterministic disabled reasons", () => {
    const active = workspace({ state: "connecting", view: "services" });
    const actions = buildActionRegistry(context(active, null), handlers());
    expect(actions.find((action) => action.id === "workspace.reconnect")?.disabledReason).toMatch(
      /already running/,
    );
    expect(
      actions.find((action) => action.id === "workspace.focus-terminal")?.disabledReason,
    ).toMatch(/Switch to Terminal/);
  });
});
