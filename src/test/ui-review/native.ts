import {
  capabilities,
  connection,
  container,
  containerDetails,
  failedService,
  service,
  settings,
  socket,
} from "../app-fixtures";
import { systemdInspection } from "../systemd-fixtures";
import type { PersistedWorkspaceState } from "../../types";
import registry from "./scenarios.json";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "settings";
const state = params.get("state") ?? "populated";
const linux = scenario === "settings" && state.startsWith("linux-");
const loading = scenario === "loading" ? state : null;
const pending = <T>() => new Promise<T>(() => {});
const windowsHost = loading === "windows-services" || loading === "shell-picker";
const firstMacConnection = scenario === "dialogs" && state === "mac-shell-picker";
const newHostTerminal = loading === "new-host-terminal";
if (
  !Object.hasOwn(registry.scenarios, scenario) ||
  !registry.scenarios[scenario as keyof typeof registry.scenarios].states.includes(state)
)
  throw new Error("Unknown UI review scenario/state");

const host = {
  ...connection(),
  displayName: "Example host",
  groupId: scenario === "sidebar" ? "example-group-lab" : null,
  historyEnabled: (scenario === "pages" && state === "history") || loading === "history",
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
  files: "files",
  systemd: "services",
  sidebar: "services",
  scratchpad: "terminal",
  splits: "terminal",
  tabs: "terminal",
  dialogs: firstMacConnection ? undefined : "terminal",
  metrics: "terminal",
  terminal: "terminal",
  ports: "ports",
  logs: "logs",
  pages:
    state === "container-terminal" ? "docker" : state === "history-restart" ? "history" : state,
  loading: {
    "systemd-inspector": "services",
    "windows-services": "services",
    history: "history",
    logs: "logs",
    docker: "docker",
    "docker-inspector": "docker",
    ports: "ports",
    "ports-discovering": "ports",
  }[state],
}[scenario] as
  "files" | "services" | "terminal" | "ports" | "docker" | "logs" | "history" | undefined;
const containers = [
  {
    ...container,
    name: "example-web",
    image: "nginx:1.27",
    composeProject: "example",
    composeService: "web",
  },
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
const portsTimeout =
  "Connection timed out: ssh: connect to host 192.0.2.10 port 22: Connection timed out";
const portsQueueBusy = "Remote operation queue was busy for 4 seconds";
const groups =
  scenario === "dialogs" || scenario === "sidebar"
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
const sidebarHosts = Array.from(
  { length: scenario !== "sidebar" ? 0 : state === "short" ? 2 : 22 },
  (_, index) => ({
    ...connection(`example-host-${index + 1}`),
    displayName: `example-${String(index + 1).padStart(2, "0")}`,
    destination: `10.0.${index < 8 ? 1 : 2}.${index + 10}`,
    groupId: index < 8 ? "example-group-lab" : "example-group-cloud",
  }),
);
const metricsSettings =
  (scenario === "dialogs" && state === "metrics") ||
  scenario === "metrics" ||
  (scenario === "settings" && state === "monitoring")
    ? { ...settings, hostMetricsEnabled: true }
    : settings;
const metricsStart = Date.parse("2026-11-01T10:00:00Z");
function trendSample() {
  const now = Date.now();
  const seconds = (now - metricsStart) / 1000;
  const age = 600 - seconds;
  if (scenario === "metrics" && state === "reading") return pending<never>();
  if (scenario === "metrics" && (state === "unavailable" || (state === "stale" && age < 30)))
    throw new Error("Connection timed out: ssh: connect to host 192.0.2.10 port 22");
  const wave = (period: number, phase = 0) => Math.sin((seconds / period) * Math.PI * 2 + phase);
  const burst = Math.max(0, wave(95, 1.2)) ** 6;
  return Promise.resolve({
    sampledAt: new Date(now).toISOString(),
    cpuPercent: Math.round((18 + 9 * wave(70) + 4 * wave(13, 0.7) + 26 * burst) * 10) / 10,
    memoryTotalKib: 32_190_000,
    memoryAvailableKib: Math.round(16_100_000 - 1_400_000 * (seconds / 600) - 300_000 * wave(180)),
    gpuPercent:
      state !== "short-history" && age > 70 && age < 95
        ? null
        : Math.round((6 + 4 * wave(40, 2) + 38 * burst) * 10) / 10,
    diskTotalKib: null,
    diskFreeKib: null,
    diskLabel: null,
    diskReadBytesPerSecond: Math.round((0.4 + 12.6 * burst) * 1024 * 1024),
    diskWriteBytesPerSecond: Math.round(
      (180 + 120 * Math.max(0, wave(25))) * 1024 + 2.1 * burst * 1024 * 1024,
    ),
    uptimeSeconds: 259_200 + Math.round(seconds),
  });
}
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
const containerTerminals =
  scenario === "pages" && state === "container-terminal"
    ? containers.slice(0, 2).map(({ id, name, image }) => ({
        id: `example-container-${name}`,
        connectionId: host.id,
        localShellId: null,
        container: { id, name, image },
        label: null,
        view: "terminal" as const,
        historyPaused: false,
      }))
    : [];
const splitPanes =
  scenario === "splits" && state !== "focus"
    ? ["worker", "logs", "db"].slice(0, state === "two-pane" ? 2 : 3)
    : [];
const splitTerminals = splitPanes.slice(1).map((label) => ({
  id: `example-${label}`,
  connectionId: host.id,
  localShellId: null,
  label,
  view: "terminal" as const,
  historyPaused: false,
}));
const leaf = (workspaceId: string) => ({ kind: "leaf" as const, workspaceId });
const workspace: PersistedWorkspaceState = {
  panelSizes: {},
  workspaces: workspaceView
    ? [
        {
          id: "example-workspace",
          connectionId: host.id,
          localShellId: null,
          label: splitPanes[0] ?? null,
          view: workspaceView,
          historyPaused: false,
        },
        ...containerTerminals,
        ...splitTerminals,
      ]
    : [],
  activeWorkspaceId: containerTerminals[0]?.id ?? (workspaceView ? "example-workspace" : null),
  terminalGroups: splitPanes.length
    ? [
        {
          id: "example-group",
          name: "Group 1",
          layout: {
            kind: "split",
            direction: "vertical",
            first: leaf("example-workspace"),
            second:
              splitPanes.length > 2
                ? {
                    kind: "split",
                    direction: "horizontal",
                    first: leaf("example-logs"),
                    second: leaf("example-db"),
                  }
                : leaf("example-logs"),
          },
        },
      ]
    : [],
  terminalLayout: null,
};
const splitOutputs = [
  [
    "example$ journalctl -u worker.service -f",
    "Nov 01 09:59:41 example worker[1234]: warning: retrying job 41",
    "Nov 01 10:00:00 example worker[1234]: Idle, waiting for jobs",
    "^C",
    "example$ ",
  ],
  [
    "example$ tail -n 2 /var/log/nginx/access.log",
    '10.0.0.7 - - "GET /health HTTP/1.1" 200 2',
    "example$ ",
  ],
  ["example$ psql -c 'select count(*) from jobs'", " count", "-------", "  4812", "example$ "],
];
const stagingHost = { ...connection("host-b"), displayName: "Staging host" };
const tabShells = [
  { id: "git-bash", kind: "git-bash" as const, label: "Git Bash", elevated: false },
  {
    id: "windows-powershell",
    kind: "windows-powershell" as const,
    label: "Windows PowerShell",
    elevated: false,
  },
  {
    id: "command-prompt",
    kind: "command-prompt" as const,
    label: "Command Prompt",
    elevated: false,
  },
  { id: "wsl:Ubuntu-24.04", kind: "wsl" as const, label: "WSL: Ubuntu-24.04", elevated: false },
  { id: "wsl:Debian", kind: "wsl" as const, label: "WSL: Debian", elevated: false },
];
if (scenario === "tabs") {
  const terminal = (id: string, target: { connectionId?: string; localShellId?: string }) => ({
    id,
    connectionId: target.connectionId ?? null,
    localShellId: target.localShellId ?? null,
    label: null,
    view: "terminal" as const,
    historyPaused: false,
  });
  workspace.workspaces = [
    terminal("tab-git-bash", { localShellId: "git-bash" }),
    terminal("tab-host-a", { connectionId: host.id }),
    terminal("tab-powershell", { localShellId: "windows-powershell" }),
    terminal("tab-git-bash-2", { localShellId: "git-bash" }),
    terminal("tab-command-prompt", { localShellId: "command-prompt" }),
    terminal("tab-host-b", { connectionId: stagingHost.id }),
    terminal("tab-powershell-2", { localShellId: "windows-powershell" }),
    terminal("tab-host-a-2", { connectionId: host.id }),
    terminal("tab-command-prompt-2", { localShellId: "command-prompt" }),
    terminal("tab-wsl", { localShellId: "wsl:Ubuntu-24.04" }),
    terminal("tab-host-a-3", { connectionId: host.id }),
  ];
  workspace.activeWorkspaceId = "tab-host-a-3";
}
let sessionStarts = 0;
const localShellStarts = new Map<string, number>();
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
    case "choose_transfer_paths":
      result = args.direction === "upload" ? ["/example/release.tar.gz"] : ["/example/downloads"];
      break;
    case "list_transfer_folder":
      if (state === "loading") return pending();
      if (state === "error" && args.folder) throw new Error("Permission denied on the host");
      result = {
        path: args.folder ?? "/home/fixture",
        entries:
          state === "empty"
            ? []
            : [
                { name: "backups", kind: "folder", size: null },
                { name: "projects", kind: "folder", size: null },
                { name: "reports", kind: "folder", size: null },
                { name: "deploy.log", kind: "file", size: 162408 },
                { name: "release.tar.gz", kind: "file", size: 78643200 },
                { name: ".profile", kind: "file", size: 768 },
              ],
      };
      break;
    case "transfer_file":
      if (state === "transfer-error") throw "Permission denied on the host";
      if (state === "folder-download") {
        args.progress.onmessage({ bytes: 28311552, total: null, bytesPerSecond: 5242880 });
        return pending();
      }
      if (state === "in-progress") {
        args.progress.onmessage({ bytes: 28311552, total: 78643200, bytesPerSecond: 5242880 });
        return pending();
      }
      result = state === "overwrite-prompt" && !args.spec.replace ? "exists" : "complete";
      break;
    case "get_environment_info":
      if (loading === "ssh-diagnostics") return pending();
      result = {
        sshPath: linux ? "/usr/bin/ssh" : "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
        sshConfigPath: linux ? "/home/example/.ssh/config" : "C:\\Users\\example\\.ssh\\config",
        sshAgentAvailable: false,
        platformSupported: true,
        ...(linux && { desktopOs: "linux", inAppUpdates: false }),
      };
      break;
    case "list_connections":
      result = scenario === "tabs" ? [host, stagingHost] : [{ ...host, tags }, ...sidebarHosts];
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
      if (loading === "docker" || loading?.startsWith("ports")) return pending();
      if (scenario === "pages" || loading) {
        result = containers;
        break;
      }
      throw new Error(portsTimeout);
    case "inspect_container":
      if (loading === "docker-inspector") return pending();
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
      result = state === "history-restart" ? "not-installed" : "installed";
      break;
    case "install_history_integration":
      result = { ...host, tags, historyEnabled: args.enableCapture };
      break;
    case "get_history":
      if (loading === "history") return pending();
      result = historyEntries;
      break;
    case "list_ports":
      if (loading === "ports") return pending();
      if (loading === "ports-discovering") {
        result = [
          socket,
          { ...socket, id: "tcp:0.0.0.0:22:0", port: 22, processName: "sshd", processId: 812 },
        ];
        break;
      }
      throw new Error(portsTimeout);
    case "inspect_connections":
    case "inspect_firewall":
      if (loading) return pending();
      throw new Error(portsQueueBusy);
    case "sample_header_metrics":
      if (scenario === "metrics") return (await trendSample()) as T;
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
      if (scenario === "tabs") {
        result = { profiles: tabShells, administratorStatus: "disabled" };
        break;
      }
      result = {
        profiles: linux
          ? [{ id: "bash", kind: "bash", label: "Bash", elevated: false }]
          : [{ id: "powershell-7", kind: "powershell-7", label: "PowerShell 7", elevated: false }],
        administratorStatus: linux ? "unsupportedPlatform" : "disabled",
      };
      break;
    case "get_settings_contract": {
      const desktop = (value: typeof settings) =>
        linux ? { ...value, terminalFontFamily: "monospace" } : value;
      result = {
        current: desktop(metricsSettings),
        defaults: desktop(settings),
        logTailOptions: [50, 100, 200, 500, 1000],
      };
      break;
    }
    case "get_workspace_state":
      result = workspace;
      break;
    case "window_compositing":
      result = false;
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
      result =
        state === "update-available"
          ? {
              currentVersion: "0.0.0-example",
              version: "0.0.1-example",
              notes: null,
              publishedAt: null,
            }
          : null;
      break;
    case "get_cached_capabilities":
    case "refresh_capabilities":
      if (firstMacConnection || newHostTerminal) {
        if (command === "refresh_capabilities") return pending();
        result = null;
        break;
      }
      result = windowsHost
        ? { ...capabilities(host.id), osId: "windows", osName: "Windows Server 2022" }
        : capabilities(scenario === "tabs" ? args.connectionId : host.id);
      break;
    case "discover_remote_shells":
      if (!firstMacConnection) {
        if (loading) return pending();
        throw new Error(`Missing UI review native fixture for ${command}`);
      }
      result = {
        platform: "macos",
        shells: [
          { id: "macos:zsh", label: "zsh" },
          { id: "macos:bash", label: "Bash" },
        ],
        windowsTerminalAvailable: false,
        wslError: null,
        capabilities: null,
        profileError: null,
      };
      break;
    case "list_windows_services":
    case "list_catalog_fonts":
      if (loading) return pending();
      throw new Error(`Missing UI review native fixture for ${command}`);
    case "start_local_session": {
      const sessionId = `example-local-${sessionStarts++}`;
      const shellStarts = (localShellStarts.get(args.shellId) ?? 0) + 1;
      localShellStarts.set(args.shellId, shellStarts);
      result = { sessionId, shellId: args.shellId };
      setTimeout(() => {
        const output =
          args.shellId === "git-bash" && shellStarts > 1
            ? "example$ npm run build\r\n\x1b]633;E;npm run build\x07\x1b]133;C\x07> vite build"
            : args.shellId === "command-prompt" && shellStarts === 1
              ? "C:\\example> ping -t 192.0.2.10\r\nRequest timed out.\x07"
              : "example$ ";
        args.output.onmessage(new TextEncoder().encode(output).buffer);
      }, 0);
      break;
    }
    case "start_session": {
      const start = sessionStarts++;
      const sessionId = args.containerId
        ? `example-container-${args.containerId.slice(0, 12)}`
        : start
          ? `example-session-${start + 1}`
          : "example-session";
      result = { sessionId, connectionId: host.id };
      if (newHostTerminal) break;
      setTimeout(() => {
        listeners.get("session-state-changed")?.forEach((callback) =>
          callback({
            payload:
              state === "notice-ended" || args.connectionId === stagingHost.id
                ? {
                    sessionId,
                    state: "disconnected",
                    reason: "SSH session ended.",
                  }
                : { sessionId, state: "connected", reason: null },
          }),
        );
        const output =
          state === "running-command"
            ? [
                "\x1b]0;C:\\Windows\\System32\\OpenSSH\\ssh.exe\x07example$ htop -d 5",
                "\x1b]633;E;htop -d 5\x07\x1b]133;C\x07  PID USER      PRI  NI  VIRT   RES S CPU% MEM%",
                " 1234 example    20   0  412M 38.2M S  2.1  0.9 worker",
              ].join("\r\n")
            : scenario === "splits"
              ? splitOutputs[start % splitOutputs.length].join("\r\n")
              : scenario === "terminal"
                ? [
                    "example$ journalctl -u worker.service -n 6 --no-pager",
                    "Nov 01 09:58:02 example worker[1234]: Starting worker.service",
                    "Nov 01 09:58:03 example worker[1234]: Connected to queue example",
                    "Nov 01 09:59:41 example worker[1234]: warning: retrying job 41",
                    "Nov 01 09:59:44 example worker[1234]: job 41 finished",
                    "Nov 01 10:00:00 example worker[1234]: Idle, waiting for jobs",
                    "example$ ",
                  ].join("\r\n")
                : args.containerId
                  ? `root@${args.containerId.slice(0, 12)}:/# `
                  : "example$ ";
        args.output.onmessage(new TextEncoder().encode(output).buffer);
      }, 0);
      break;
    }
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
      if (state === "loading" || loading === "logs") return pending();
      if (state === "error" || (state === "stale" && serviceReads > 1))
        throw new Error("Synthetic read failure. Try again.");
      result = state === "empty" ? [] : units;
      break;
    case "start_journal_stream":
      result = { streamId: "example-stream" };
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
      if (loading === "systemd-inspector") return pending();
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
      queueMicrotask(() => {
        throw error;
      });
      throw error;
    }
  }
  return result as T;
}
