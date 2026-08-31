import { describe, expect, it } from "vitest";
import type { SavedConnection, Workspace, WorkspacePreset } from "../types";
import { emptyCachedList } from "./workspace-cache";
import {
  applyWorkspacePreset,
  captureWorkspacePreset,
  duplicateWorkspacePresetInput,
  workspacePresetViewStatus,
} from "./workspace-presets";

const connections: SavedConnection[] = ["host-a", "host-b"].map((id) => ({
  id,
  displayName: id,
  destination: id,
  username: "user",
  port: null,
  identityFile: null,
  historyEnabled: false,
  groupId: null,
  tags: [],
  createdAt: "",
  updatedAt: "",
  lastConnectedAt: null,
}));

function workspace(id: string, view: Workspace["view"]): Workspace {
  return {
    id,
    label: null,
    connectionId: connections[0].id,
    connectionSnapshot: connections[0],
    sessionId: "live-session",
    state: "connected",
    reason: null,
    view,
    historyPaused: false,
    reconnectToken: 2,
    connectRequested: true,
    servicesCache: emptyCachedList(),
    portsCache: emptyCachedList(),
    containersCache: emptyCachedList(),
    containerDetailsCache: {},
    systemdSelectionId: view === "services" ? "nginx.service" : null,
    containerSelectionId: null,
    logSource: null,
  };
}

describe("Workspace Presets", () => {
  it("round-trips view layout and exact selectors without live state", () => {
    const input = captureWorkspacePreset(
      "Web troubleshooting",
      connections[0].id,
      [workspace("terminal", "terminal"), workspace("service", "services")],
      {
        kind: "split",
        direction: "vertical",
        first: { kind: "leaf", workspaceId: "terminal" },
        second: { kind: "leaf", workspaceId: "service" },
      },
      (() => {
        const keys = [
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222",
        ];
        return () => keys.shift()!;
      })(),
    );
    expect(input.views[1].selector).toEqual({ kind: "systemdUnit", unit: "nginx.service" });
    expect(JSON.stringify(input)).not.toContain("live-session");
    expect(JSON.stringify(input)).not.toContain("connected");

    const preset: WorkspacePreset = {
      ...input,
      id: "preset",
      schemaVersion: 1,
      createdAt: "now",
      updatedAt: "now",
    };
    for (const connection of connections) {
      let next = 0;
      const applied = applyWorkspacePreset(preset, connection, () => `applied-${next++}`);
      expect(applied.workspaces).toHaveLength(2);
      expect(applied.workspaces.every((item) => item.connectionId === connection.id)).toBe(true);
      expect(applied.workspaces.every((item) => item.state === "disconnected")).toBe(true);
      expect(applied.workspaces.every((item) => !item.connectRequested && !item.sessionId)).toBe(
        true,
      );
      expect(applied.workspaces[1].systemdSelectionId).toBe("nginx.service");
      expect(applied.terminalLayout).toEqual({
        kind: "split",
        direction: "vertical",
        first: { kind: "leaf", workspaceId: "applied-0" },
        second: { kind: "leaf", workspaceId: "applied-1" },
      });
    }

    let duplicateKey = 0;
    const duplicate = duplicateWorkspacePresetInput(
      preset,
      "Web troubleshooting copy",
      () => `duplicate-${duplicateKey++}`,
    );
    expect(duplicate.views.map((view) => view.key)).toEqual(["duplicate-0", "duplicate-1"]);
    expect(duplicate.layout).toEqual({
      kind: "split",
      direction: "vertical",
      first: { kind: "leaf", viewKey: "duplicate-0" },
      second: { kind: "leaf", viewKey: "duplicate-1" },
    });

    const withUnsupported: WorkspacePreset = {
      ...preset,
      views: [
        {
          key: "removed",
          label: "Old plugin view",
          view: "removed-view",
          selector: null,
        },
        ...preset.views,
      ],
    };
    expect(workspacePresetViewStatus(withUnsupported.views[0], null)).toEqual({
      supported: false,
      detail: "View type is not supported by this app version",
    });
    let supportedId = 0;
    const partial = applyWorkspacePreset(
      withUnsupported,
      connections[0],
      () => `supported-${supportedId++}`,
    );
    expect(partial.workspaces).toHaveLength(2);
    expect(partial.workspaces.map((item) => item.id)).toEqual(["supported-0", "supported-1"]);
  });
});
