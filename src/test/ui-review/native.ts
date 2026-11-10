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
const workspaceView = { systemd: "services", scratchpad: "terminal", logs: "logs" }[scenario] as
  "services" | "terminal" | "logs" | undefined;
const journalMessages = [
  "Started example-worker.service - Example queue worker.",
  "worker: connected to queue example at 10.0.0.12:5672",
  "worker: processing batch 4812 (128 jobs)",
  "worker: batch 4812 finished in 1.84s",
  "worker: warning: queue depth 1200 exceeds soft limit 1000",
  "worker: processing batch 4813 (128 jobs)",
  "worker: error: job 99172 failed: upstream returned 503 Service Unavailable",
  "worker: retrying job 99172 in 5s (attempt 2 of 5)",
  'worker: request payload={"id":99172,"tenant":"example","items":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20],"trace":"0f4c2a9e7b1d4c6a8e3f5b2d9c7a1e4f"} status=retry',
  "worker: batch 4813 finished in 2.07s",
  "worker: debug: heartbeat ok",
];
const journalOutput = Array.from({ length: 48 }, (_, index) => {
  const second = String(index % 60).padStart(2, "0");
  const micros = String(104233 + index * 7919).slice(0, 6);
  return `2026-11-01T09:58:${second}.${micros}+00:00 example-host worker[1234]: ${
    journalMessages[index % journalMessages.length]
  }
`;
}).join("");
const workspace: PersistedWorkspaceState = {
  workspaces: workspaceView
    ? [
        {
          id: "example-workspace",
          connectionId: host.id,
          localShellId: null,
          label: null,
          view: workspaceView,
          historyPaused: false,
        },
      ]
    : [],
  activeWorkspaceId: workspaceView ? "example-workspace" : null,
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
    case "get_scratchpad_note":
      result = {
        id: `example-${args.scope}-note`,
        scope: args.scope,
        ownerId: args.ownerId,
        connectionId: args.connectionId ?? null,
        text:
          args.scope === "global"
            ? "Shared reminder for every terminal"
            : "sudo journalctl -u worker.service -n 200\nsystemctl status backup.service",
        createdAt: "2026-11-01T10:00:00Z",
        updatedAt: "2026-11-01T10:00:00Z",
      };
      break;
    case "list_services":
      serviceReads++;
      if (state === "loading") return new Promise<T>(() => {});
      if (state === "error" || (state === "stale" && serviceReads > 1))
        throw new Error("Synthetic read failure. Try again.");
      result = state === "empty" ? [] : units;
      break;
    case "start_journal_stream":
      result = { streamId: "example-stream" };
      // A followed journal the account may not read prints nothing on stdout;
      // journalctl's hint arrives on stderr and becomes a stream notice.
      setTimeout(() => {
        if (state === "restricted")
          listeners
            .get("stream-notice")
            ?.forEach((callback) =>
              callback({ payload: { streamId: "example-stream", notice: "journal-restricted" } }),
            );
        else args.output.onmessage(new TextEncoder().encode(journalOutput).buffer);
      }, 20);
      break;
    case "stop_log_stream":
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
