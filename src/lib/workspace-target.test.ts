import { describe, expect, it } from "vitest";
import {
  createContainerWorkspace,
  createLocalWorkspace,
  createRemoteWorkspace,
  isContainerWorkspace,
  isLocalWorkspace,
  isRemoteWorkspace,
  terminalStateLabel,
  workspaceHostContext,
  workspaceTargetKey,
  workspaceTargetName,
} from "./workspace-target";
import { workspaceDisplayLabel } from "./workspace-lifecycle";
import type { LocalShellProfile, SavedConnection } from "../types";

const shell: LocalShellProfile = {
  id: "powershell-7",
  label: "PowerShell 7",
  kind: "powershell-7",
  elevated: false,
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
    for (const remoteOnly of [
      "connectionId",
      "connectionSnapshot",
      "historyPaused",
      "servicesCache",
      "portsCache",
      "containersCache",
      "containerDetailsCache",
      "logSource",
    ]) {
      expect(local).not.toHaveProperty(remoteOnly);
    }
  });

  it("keeps a remote Workspace on its Saved Connection snapshot", () => {
    const remote = createRemoteWorkspace(connection);

    expect(isRemoteWorkspace(remote)).toBe(true);
    expect(remote.connectionId).toBe(connection.id);
    expect(remote.connectionSnapshot).toEqual(connection);
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

  it("names a Container Terminal after its container and keeps its host as context", () => {
    const host = createRemoteWorkspace(connection);
    const web = createContainerWorkspace(connection, {
      id: "a".repeat(64),
      name: "web",
      image: "nginx:1.27",
    });
    const cache = createContainerWorkspace(connection, {
      id: "b".repeat(64),
      name: "cache",
      image: "redis:7",
    });

    expect(isContainerWorkspace(web)).toBe(true);
    expect(isContainerWorkspace(host)).toBe(false);
    expect(web.connectionId).toBe(connection.id);
    expect(web.view).toBe("terminal");
    expect(workspaceTargetName(web)).toBe("web");
    expect(workspaceHostContext(web)).toBe("prod-web");
    expect(workspaceHostContext(host)).toBeNull();
    expect(workspaceTargetKey(web)).toBe(`container:${connection.id}:${"a".repeat(64)}`);
    const all = [host, web, cache];
    expect(workspaceDisplayLabel(host, all)).toBe("prod-web");
    expect(workspaceDisplayLabel(web, all)).toBe("web");
    expect(workspaceDisplayLabel(cache, all)).toBe("cache");
  });

  it("marks an elevated local Workspace as Administrator", () => {
    const elevated = createLocalWorkspace({
      ...shell,
      id: "powershell-7-administrator",
      elevated: true,
    });

    expect(workspaceTargetName(elevated)).toBe("PowerShell 7 (Administrator)");
    expect(workspaceTargetKey(elevated)).toBe("local:powershell-7-administrator");
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
