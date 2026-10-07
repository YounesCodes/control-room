import type {
  AppSettings,
  BaselineComparison,
  BootDiagnostics,
  DockerContainer,
  DockerContainerDetails,
  HostBaseline,
  HostBaselineSummary,
  HostCapabilities,
  HostResources,
  ListeningSocket,
  SavedConnection,
  SystemdUnit,
} from "../types";

export const settings: AppSettings = {
  terminalFontFamily: "Consolas",
  terminalFontSize: 14,
  terminalScrollback: 10000,
  terminalForeground: "#f2f2ee",
  terminalRed: "#ff6f7d",
  terminalGreen: "#52cf91",
  terminalYellow: "#e8c56c",
  terminalBlue: "#55aef2",
  terminalMagenta: "#c793ff",
  terminalCyan: "#65d4d1",
  defaultLogTail: 200,
  globalHistoryEnabled: true,
  globalSudoEnabled: false,
  automaticUpdateChecks: false,
  hiddenLocalShells: [],
};
export function connection(id = "host-a"): SavedConnection {
  return {
    id,
    displayName: id === "host-a" ? "Fixture Alpha" : "Fixture Beta",
    destination: "example.invalid",
    username: "fixture",
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
}
export function capabilities(id = "host-a"): HostCapabilities {
  return {
    connectionId: id,
    hostname: id,
    osId: "ubuntu",
    osName: "Ubuntu",
    osVersion: "24.04",
    kernel: "6.8",
    architecture: "x86_64",
    uptime: "up 1 day",
    defaultShell: "/bin/bash",
    systemdAvailable: true,
    journaldAvailable: true,
    dockerAvailable: true,
    dockerAccessible: true,
    dockerAccessibleWithSudo: false,
    passwordlessSudo: false,
    dockerVersion: "29.0",
    runningServiceCount: 1,
    runningContainerCount: 1,
    totalContainerCount: 1,
    detectedAt: new Date().toISOString(),
  };
}
export function resources(): HostResources {
  return {
    sampledAt: new Date().toISOString(),
    cpuPercent: 12,
    coreCount: 4,
    load1: 0.1,
    load5: 0.2,
    load15: 0.3,
    memoryTotalKib: 4096,
    memoryAvailableKib: 2048,
    swapTotalKib: 0,
    swapFreeKib: 0,
  };
}
export const service: SystemdUnit = {
  id: "fixture.service",
  unitType: "service",
  description: "Fixture service",
  loadState: "loaded",
  activeState: "active",
  subState: "running",
  unitFileState: "enabled",
};
export const failedService: SystemdUnit = {
  ...service,
  id: "failed.service",
  activeState: "failed",
  subState: "failed",
};
export const container: DockerContainer = {
  id: "a".repeat(64),
  name: "fixture-web",
  image: "fixture:latest",
  state: "running",
  status: "Up",
  ports: "0.0.0.0:443->443/tcp",
  createdAt: "today",
  composeProject: null,
  composeService: null,
  composeContainerNumber: null,
  composeOneoff: null,
};
export const containerDetails: DockerContainerDetails = {
  id: container.id,
  name: container.name,
  imageReference: container.image,
  imageContentId: "sha256:fixture",
  state: "running",
  running: true,
  paused: false,
  restarting: false,
  oomKilled: false,
  dead: false,
  exitCode: 0,
  startedAt: null,
  finishedAt: null,
  healthStatus: null,
  failingStreak: null,
  restartPolicy: "no",
  restartMaximumRetryCount: 0,
  publishedPorts: [],
  networks: [],
  mounts: [],
  composeProject: null,
  composeService: null,
  composeContainerNumber: null,
  composeOneoff: null,
};
export const socket: ListeningSocket = {
  id: "fixture-socket",
  protocol: "tcp",
  addressFamily: "ipv4",
  localAddress: "0.0.0.0",
  port: 443,
  processName: "fixture",
  processId: 42,
  systemdUnit: service.id,
  ownership: "known",
};
export function boot(): BootDiagnostics {
  const collectedAt = new Date().toISOString();
  return {
    id: "boot-fixture",
    collectedAt,
    selectedBootId: "a".repeat(32),
    boots: {
      collectedAt,
      error: null,
      permissionRequired: false,
      data: [
        { id: "a".repeat(32), index: 0, range: "Current boot", current: true },
        { id: "b".repeat(32), index: -1, range: "Previous boot", current: false },
      ],
    },
    timing: {
      collectedAt,
      error: null,
      permissionRequired: false,
      data: { total: "8s", kernel: "3s", userspace: "5s", original: "8s total" },
    },
    slowUnits: {
      collectedAt,
      error: null,
      permissionRequired: false,
      data: [{ unit: service.id, duration: "2s" }],
    },
    failedUnits: { collectedAt, error: null, permissionRequired: false, data: [failedService] },
    journal: {
      collectedAt,
      error: null,
      permissionRequired: false,
      data: ["warning: fixture boot evidence"],
    },
  };
}
export function baseline(id: string, label = id): HostBaseline {
  return {
    id,
    connectionId: "host-a",
    label,
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    pinned: false,
    identity: {
      hostname: "host-a",
      machineFingerprint: "fixture",
      osId: "ubuntu",
      osVersion: "24.04",
      kernel: "6.8",
      architecture: "x86_64",
    },
    sections: [
      {
        kind: "host",
        status: "collected",
        schemaVersion: 1,
        collectedAt: new Date().toISOString(),
        message: null,
        entries: [{ identity: "host", label: "host-a", facts: [{ name: "kernel", value: "6.8" }] }],
      },
    ],
  };
}
export function summary(value: HostBaseline): HostBaselineSummary {
  return {
    ...value,
    changesSincePrevious: null,
    sections: value.sections.map((section) => ({
      kind: section.kind,
      status: section.status,
      entryCount: section.entries.length,
    })),
  };
}
export function comparison(
  base: HostBaseline,
  target: HostBaseline,
  live = false,
): BaselineComparison {
  return {
    base: summary(base),
    target: summary(target),
    identityMatch: "same",
    schemaCompatible: true,
    targetIsLive: live,
    sections: [
      {
        kind: "host",
        baseStatus: "collected",
        targetStatus: "collected",
        comparable: true,
        note: null,
        added: [],
        removed: [],
        changed: [],
        unchangedCount: 1,
      },
    ],
  };
}
