export interface SavedConnection {
  id: string;
  displayName: string;
  destination: string;
  username: string | null;
  port: number | null;
  identityFile: string | null;
  historyEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt: string | null;
}

export interface SavedConnectionInput {
  displayName: string;
  destination: string;
  username: string;
  port: number | null;
  identityFile: string | null;
  historyEnabled: boolean;
}

export interface HostCapabilities {
  connectionId: string;
  hostname: string | null;
  osId: string | null;
  osName: string | null;
  osVersion: string | null;
  kernel: string | null;
  architecture: string | null;
  uptime: string | null;
  defaultShell: string | null;
  systemdAvailable: boolean;
  journaldAvailable: boolean;
  dockerAvailable: boolean;
  dockerAccessible: boolean;
  dockerVersion: string | null;
  runningServiceCount: number | null;
  runningContainerCount: number | null;
  totalContainerCount: number | null;
  detectedAt: string;
}

export interface SystemdUnit {
  id: string;
  unitType: string;
  description: string;
  loadState: string;
  activeState: string;
  subState: string;
  unitFileState: string | null;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  createdAt: string;
  composeProject: string | null;
  composeService: string | null;
  composeContainerNumber: number | null;
  composeOneoff: boolean | null;
}

export interface HistoryEntry {
  id: string;
  connectionId: string;
  sessionId: string;
  command: string;
  cwd: string | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  shell: string;
}

export interface HistoryInput {
  connectionId: string;
  sessionId: string;
  command: string;
  cwd: string | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  shell: string;
}

export interface AppSettings {
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalScrollback: number;
  terminalForeground: string;
  terminalRed: string;
  terminalGreen: string;
  terminalYellow: string;
  terminalBlue: string;
  terminalMagenta: string;
  terminalCyan: string;
  defaultLogTail: number;
  globalHistoryEnabled: boolean;
}

export interface SettingsContract {
  current: AppSettings;
  defaults: AppSettings;
  logTailOptions: number[];
}

export interface EnvironmentInfo {
  sshPath: string | null;
  sshConfigPath: string;
  sshAgentAvailable: boolean;
  platformSupported: boolean;
}

export type ConnectionState = "connecting" | "connected" | "disconnected" | "error";
export type WorkspaceView = "overview" | "terminal" | "services" | "docker" | "logs" | "history";

export interface CachedList<T> {
  items: T[];
  fetchedAt: number | null;
  loading: boolean;
  error: string | null;
}

export type LogSourceType = "systemd" | "docker";

export interface LogSourceSelection {
  type: LogSourceType;
  id: string;
}

export interface Workspace {
  id: string;
  label: string | null;
  connectionId: string;
  connectionSnapshot: SavedConnection;
  sessionId: string | null;
  state: ConnectionState;
  reason: string | null;
  view: WorkspaceView;
  historyPaused: boolean;
  reconnectToken: number;
  connectRequested: boolean;
  servicesCache: CachedList<SystemdUnit>;
  containersCache: CachedList<DockerContainer>;
  logSource: LogSourceSelection | null;
}

interface PersistedWorkspace {
  id: string;
  label: string | null;
  connectionId: string;
  view: WorkspaceView;
  historyPaused: boolean;
}

export interface PersistedWorkspaceState {
  workspaces: PersistedWorkspace[];
  activeWorkspaceId: string | null;
  terminalLayout: import("./lib/terminal-layout").TerminalLayout | null;
}

export interface SessionStateEvent {
  sessionId: string;
  state: ConnectionState;
  category?:
    | "authentication"
    | "host-resolution"
    | "connection-refused"
    | "connection-timeout"
    | "host-key"
    | "connection-lost"
    | "process"
    | "remote-exit"
    | "user-disconnect";
  reason: string | null;
}

export interface StreamStateEvent {
  streamId: string;
  state: "running" | "stopped" | "error";
  reason: string | null;
}
