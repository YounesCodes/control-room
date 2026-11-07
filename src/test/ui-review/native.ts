import { capabilities, connection, failedService, service, settings } from "../app-fixtures";
import { systemdInspection } from "../systemd-fixtures";
import type { PersistedWorkspaceState } from "../../types";
import registry from "./scenarios.json";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "settings";
const state = params.get("state") ?? "populated";
if (
  !Object.hasOwn(registry.scenarios, scenario) ||
  !registry.scenarios[scenario as keyof typeof registry.scenarios].states.includes(state)
)
  throw new Error("Unknown UI review scenario/state");

const host = { ...connection(), displayName: "Example host", historyEnabled: false };
const units = [
  { ...service, id: "worker.service", description: "Example queue worker" },
  { ...failedService, id: "backup.service", description: "Example backup" },
  ...Array.from({ length: state === "overflow" ? 80 : 6 }, (_, index) => ({
    ...service,
    id: `example-${String(index + 1).padStart(2, "0")}.service`,
    description: "Synthetic service",
  })),
];
if (state === "overflow") {
  units[0].id = `example-${"long-unit-name-".repeat(12)}worker.service`;
  units[0].description = "Synthetic long description. ".repeat(15);
}
const workspace: PersistedWorkspaceState = {
  workspaces:
    scenario === "systemd"
      ? [
          {
            id: "example-workspace",
            connectionId: host.id,
            localShellId: null,
            label: null,
            view: "services",
            historyPaused: false,
          },
        ]
      : [],
  activeWorkspaceId: scenario === "systemd" ? "example-workspace" : null,
  terminalGroups: [],
  terminalLayout: null,
};
const listeners = new Map<string, Set<(event: { payload: any }) => void>>();
let serviceReads = 0;

export class Channel<T> {
  onmessage: ((message: T) => void) | null = null;
}

export async function listen<T>(name: string, callback: (event: { payload: T }) => void) {
  const handlers = listeners.get(name) ?? new Set();
  handlers.add(callback);
  listeners.set(name, handlers);
  return () => {
    handlers.delete(callback);
  };
}

// These substitutes cannot open windows, dialogs, SSH, processes, or a database.
export const getCurrentWindow = () => ({
  close: async () => undefined,
  minimize: async () => undefined,
  toggleMaximize: async () => undefined,
});
export const open = async () => null;
export const save = async () => null;

export async function invoke<T>(command: string, args: Record<string, any> = {}): Promise<T> {
  let result: unknown;
  switch (command) {
    case "get_environment_info":
      result = {
        sshPath: "example-ssh",
        sshConfigPath: "example-config",
        sshAgentAvailable: false,
        platformSupported: true,
      };
      break;
    case "list_connections":
      result = [host];
      break;
    case "list_connection_groups":
    case "list_connection_tags":
      result = [];
      break;
    case "list_local_shells":
      result = {
        profiles: [
          { id: "powershell-7", kind: "powershell-7", label: "PowerShell 7", elevated: false },
        ],
        administratorStatus: "disabled",
      };
      break;
    case "get_settings_contract":
      result = { current: settings, defaults: settings, logTailOptions: [50, 100, 200, 500, 1000] };
      break;
    case "get_workspace_state":
      result = workspace;
      break;
    case "current_app_version":
      result = "0.0.0-example";
      break;
    case "pending_update_notice":
    case "check_for_update":
      result = null;
      break;
    case "get_cached_capabilities":
    case "refresh_capabilities":
      result = capabilities(host.id);
      break;
    case "start_session":
      result = { sessionId: "example-session", connectionId: host.id };
      setTimeout(() => {
        listeners.get("session-state-changed")?.forEach((callback) =>
          callback({
            payload: { sessionId: "example-session", state: "connected", reason: null },
          }),
        );
        args.output.onmessage(new TextEncoder().encode("example$ ").buffer);
      }, 0);
      break;
    case "save_workspace_state":
    case "save_settings":
    case "resize_session":
    case "acknowledge_session_output":
    case "close_session":
    case "write_session":
      break;
    case "list_services":
      serviceReads++;
      if (state === "loading") return new Promise<T>(() => {});
      if (state === "error" || (state === "stale" && serviceReads > 1))
        throw new Error("Synthetic read failure. Try again.");
      result = state === "empty" ? [] : units;
      break;
    case "inspect_systemd_unit": {
      const unit = units.find((unit) => unit.id === args.unit);
      result = systemdInspection(
        args.unit,
        args.section === "properties"
          ? {
              Id: args.unit,
              Description: unit?.description ?? "Synthetic service",
              ActiveState: unit?.activeState ?? "active",
              SubState: unit?.subState ?? "running",
              LoadState: "loaded",
              UnitFileState: "enabled",
              MainPID: "1234",
              MemoryCurrent: "104857600",
              TasksCurrent: "8",
              NRestarts: "0",
              Restart: "on-failure",
              ExecStart: "/usr/bin/example-worker --queue example",
            }
          : {},
        "[Service]\nExecStart=/usr/bin/example-worker\nRestart=on-failure\n",
      );
      break;
    }
    default: {
      const error = new Error(`Missing UI review native fixture for ${command}`);
      // App may catch a rejected read; an incomplete fixture must still fail capture.
      queueMicrotask(() => {
        throw error;
      });
      throw error;
    }
  }
  return result as T;
}
