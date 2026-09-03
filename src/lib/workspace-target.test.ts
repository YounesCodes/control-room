import { describe, expect, it } from "vitest";
import {
  createLocalWorkspace,
  createRemoteWorkspace,
  isLocalWorkspace,
  isRemoteWorkspace,
  terminalStateLabel,
  workspaceTargetKey,
  workspaceTargetName,
} from "./workspace-target";
import type { LocalShellProfile, SavedConnection } from "../types";

const shell: LocalShellProfile = {
  id: "powershell-7",
  label: "PowerShell 7",
  kind: "powershell-7",
};

const connection: SavedConnection = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "prod-web",
  destination: "prod-web",
  username: "deploy",
  port: null,
  identityFile: null,
  historyEnabled: true,
  sudoEnabled: false,
  groupId: null,
  tags: [],
  createdAt: "",
  updatedAt: "",
  lastConnectedAt: null,
};

describe("Workspace targets", () => {
  it("gives a local Workspace a terminal and nothing remote", () => {
    const local = createLocalWorkspace(shell);

    expect(isLocalWorkspace(local)).toBe(true);
    expect(isRemoteWorkspace(local)).toBe(false);
    expect(local.view).toBe("terminal");
    expect(local.connectRequested).toBe(true);
    expect(local.sessionId).toBeNull();
    expect(local.shell).toEqual(shell);
    // No Saved Connection, no inspection caches, no History state exist to
    // reach from a local Workspace.
    for (const remoteOnly of [
      "connectionId",
      "connectionSnapshot",
      "historyPaused",
      "servicesCache",
      "portsCache",
      "containersCache",
      "containerDetailsCache",
      "bootDiagnostics",
      "logSource",
      "baselineSelectionId",
    ]) {
      expect(local).not.toHaveProperty(remoteOnly);
    }
  });

  it("keeps a remote Workspace on its Saved Connection snapshot", () => {
    const remote = createRemoteWorkspace(connection);

    expect(isRemoteWorkspace(remote)).toBe(true);
    expect(remote.connectionId).toBe(connection.id);
    expect(remote.connectionSnapshot).toEqual(connection);
    // The snapshot is a copy, so editing the connection later cannot mutate an
    // open Workspace behind React's back.
    expect(remote.connectionSnapshot).not.toBe(connection);
  });

  it("identifies what each Workspace is attached to", () => {
    const local = createLocalWorkspace(shell);
    const remote = createRemoteWorkspace(connection);

    expect(workspaceTargetKey(local)).toBe("local:powershell-7");
    expect(workspaceTargetKey(createLocalWorkspace(shell))).toBe(workspaceTargetKey(local));
    expect(workspaceTargetKey(remote)).toBe(`connection:${connection.id}`);
    expect(workspaceTargetKey(remote)).not.toBe(workspaceTargetKey(local));
    expect(workspaceTargetName(local)).toBe("PowerShell 7");
    expect(workspaceTargetName(remote)).toBe("prod-web");
  });

  it("says a local shell runs and a remote session connects", () => {
    const local = createLocalWorkspace(shell);
    const remote = createRemoteWorkspace(connection);
    const label = (workspace: typeof local | typeof remote, state: typeof local.state) =>
      terminalStateLabel({ ...workspace, state });

    expect(label(local, "connecting")).toBe("starting");
    expect(label(local, "connected")).toBe("running");
    expect(label(local, "disconnected")).toBe("stopped");
    expect(label(local, "error")).toBe("error");
    expect(label(remote, "connecting")).toBe("connecting");
    expect(label(remote, "connected")).toBe("connected");
    expect(label(remote, "disconnected")).toBe("disconnected");
  });
});
