import {
  capabilities,
  connection,
  container,
  containerDetails,
  failedService,
  service,
  settings,
} from "../app-fixtures";
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

const host = {
  ...connection(),
  displayName: "Example host",
  // History needs capture on for its populated list.
  historyEnabled: scenario === "pages" && state === "history",
};
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
const workspaceView = {
  systemd: "services",
  scratchpad: "terminal",
  dialogs: "terminal",
  terminal: "terminal",
  ports: "ports",
  logs: "logs",
  pages: state,
}[scenario] as "services" | "terminal" | "ports" | "docker" | "logs" | "history" | undefined;
// Pages show the Docker, Logs, and History screens with ordinary readings.
const containers = [
  { ...container, name: "example-web", composeProject: "example", composeService: "web" },
  {
    ...container,
    id: "b".repeat(64),
    name: "example-worker",
    image: "example/worker:2.4",
    ports: "",
    composeProject: "example",
    composeService: "worker",
  },
  {
    ...container,
    id: "c".repeat(64),
    name: "example-cache",
    image: "redis:7",
    state: "exited",
    status: "Exited (0) 2 hours ago",
    ports: "",
  },
];
const historyEntries = [
  ["systemctl status worker.service", 0, "/srv/example"],
  ["journalctl -u worker.service -n 200", 0, "/srv/example"],
  ["docker compose up -d", 0, "/srv/example"],
  ["curl -fsS http://localhost:8080/health", 7, "/srv/example"],
  ["ls -la /var/log", 0, "/home/fixture"],
].map(([command, exitCode, cwd], index) => ({
  id: `history-${index}`,
  connectionId: "host-a",
  sessionId: "example-session",
  command: command as string,
  cwd: cwd as string,
  startedAt: `2026-11-01T09:${String(40 + index * 4).padStart(2, "0")}:00Z`,
  finishedAt: `2026-11-01T09:${String(40 + index * 4).padStart(2, "0")}:02Z`,
  exitCode: exitCode as number,
  shell: "bash",
}));
// An unreachable host fails each Ports read: two with the SSH timeout, two
// behind it in the busy remote queue.
const portsTimeout =
  "Connection timed out: ssh: connect to host 192.0.2.10 port 22: Connection timed out";
const portsQueueBusy = "Remote operation queue was busy for 4 seconds";
// Dialogs show organization that already exists, so their lists are populated.
const groups =
  scenario === "dialogs"
    ? [
        { id: "example-group-lab", name: "Homelab", position: 0, collapsed: false },
        { id: "example-group-cloud", name: "Cloud", position: 1, collapsed: false },
      ]
    : [];
const tags =
  scenario === "dialogs" && state !== "groups-no-tags"
    ? [
        { id: "example-tag-critical", name: "critical", color: "#c2410c" },
        { id: "example-tag-docker", name: "docker", color: "#2563eb" },
      ]
    : [];
const metricsSettings =
  (scenario === "dialogs" && state === "metrics") ||
  (scenario === "settings" && state === "monitoring")
    ? { ...settings, hostMetricsEnabled: true }
    : settings;
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
        sshPath: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
        sshConfigPath: "C:\\Users\\example\\.ssh\\config",
        sshAgentAvailable: false,
        platformSupported: true,
      };
      break;
    case "list_connections":
      // Dialog states also review how assigned tags sit in the sidebar row.
      result = [{ ...host, tags }];
      break;
    case "list_connection_groups":
      result = groups;
      break;
    case "test_connection":
      if (state === "connection-test-error")
        throw new Error("Permission denied (publickey,password)");
      result = { ...capabilities(host.id), dockerAvailable: false, passwordlessSudo: false };
      break;
    case "list_connection_tags":
      result = tags;
      break;
    case "list_containers":
      if (scenario === "pages") {
        result = containers;
        break;
      }
      throw new Error(portsTimeout);
    case "inspect_container":
      result = { ...containerDetails, id: args.container ?? containerDetails.id };
      break;
    case "start_docker_log_stream":
      result = { streamId: "example-stream" };
      setTimeout(() => {
        const lines = [
          "Nov 01 09:58:02 example worker[1234]: Starting worker.service",
          "Nov 01 09:58:03 example worker[1234]: Connected to queue example",
          "Nov 01 09:59:41 example worker[1234]: warning: retrying job 41",
          "Nov 01 09:59:44 example worker[1234]: job 41 finished",
          "Nov 01 10:00:00 example worker[1234]: Idle, waiting for jobs",
        ];
        args.output.onmessage(new TextEncoder().encode(lines.join("\n") + "\n").buffer);
      }, 0);
      break;
    case "stop_log_stream":
      break;
    case "get_history_integration_status":
      result = "installed";
      break;
    case "get_history":
      result = historyEntries;
      break;
    case "list_ports":
      throw new Error(portsTimeout);
    case "inspect_connections":
    case "inspect_firewall":
      throw new Error(portsQueueBusy);
    case "sample_header_metrics":
      // GPU stays unreported so the unavailable reading is reviewed too.
      result = {
        sampledAt: "2026-11-01T10:00:00Z",
        cpuPercent: 12,
        memoryTotalKib: 8074035,
        memoryAvailableKib: 5872025,
        gpuPercent: null,
        diskTotalKib: null,
        diskFreeKib: null,
        diskLabel: null,
        diskReadBytesPerSecond: 13 * 1024 * 1024,
        diskWriteBytesPerSecond: 2.3 * 1024 * 1024,
        uptimeSeconds: 324000,
      };
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
      result = {
        current: metricsSettings,
        defaults: settings,
        logTailOptions: [50, 100, 200, 500, 1000],
      };
      break;
    case "get_workspace_state":
      result = workspace;
      break;
    case "current_app_version":
      result = "0.0.0-example";
      break;
    case "pending_update_notice":
      result = null;
      break;
    case "check_for_update":
      if (state === "update-failed")
        throw new Error("Could not reach the update server: connection timed out");
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
            payload:
              state === "notice-ended"
                ? {
                    sessionId: "example-session",
                    state: "disconnected",
                    reason: "Connection to example.invalid closed by remote host.",
                  }
                : { sessionId: "example-session", state: "connected", reason: null },
          }),
        );
        // The terminal scenario prints a short service log so Find has
        // several matches to step through.
        const output =
          scenario === "terminal"
            ? [
                "example$ journalctl -u worker.service -n 6 --no-pager",
                "Nov 01 09:58:02 example worker[1234]: Starting worker.service",
                "Nov 01 09:58:03 example worker[1234]: Connected to queue example",
                "Nov 01 09:59:41 example worker[1234]: warning: retrying job 41",
                "Nov 01 09:59:44 example worker[1234]: job 41 finished",
                "Nov 01 10:00:00 example worker[1234]: Idle, waiting for jobs",
                "example$ ",
              ].join("\r\n")
            : "example$ ";
        args.output.onmessage(new TextEncoder().encode(output).buffer);
      }, 0);
      break;
    case "save_settings":
      if (state === "save-failed") throw new Error("Settings file is read-only");
      break;
    case "save_scratchpad_note":
      if (state === "save-error") throw new Error("Note storage is unavailable");
      result = { ...args.input, id: "example-note", createdAt: "", updatedAt: "" };
      break;
    case "save_workspace_state":
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
