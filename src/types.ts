export interface SavedConnection {
  id: string;
  displayName: string;
  destination: string;
  username: string | null;
  port: number | null;
  identityFile: string | null;
  historyEnabled: boolean;
  groupId: string | null;
  favorite: boolean;
  tags: ConnectionTag[];
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
  groupId: string | null;
  favorite: boolean;
  tagNames: string[];
}

export interface ConnectionGroup {
  id: string;
  name: string;
  position: number;
  collapsed: boolean;
}

export interface ConnectionTag {
  id: string;
  name: string;
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

export interface ListeningSocket {
  id: string;
  protocol: "tcp" | "udp";
  addressFamily: "ipv4" | "ipv6";
  localAddress: string;
  port: number;
  processName: string | null;
  processId: number | null;
  systemdUnit: string | null;
  ownership: "known" | "unavailable" | "ambiguous";
}

export interface FirewallRule {
  to: string;
  action: string;
  from: string;
  port: number | null;
  protocol: string | null;
  ipv6: boolean;
}

export interface FirewallStatus {
  available: boolean;
  active: boolean | null;
  defaultIncoming: string | null;
  rules: FirewallRule[];
  collectedAt: string;
}

export interface ConnectionRemote {
  address: string;
  count: number;
}

export interface ConnectionSummary {
  key: string;
  protocol: string;
  localPort: number;
  processName: string | null;
  processId: number | null;
  systemdUnit: string | null;
  established: number;
  remoteAddressCount: number;
  remotes: ConnectionRemote[];
}

export interface EstablishedConnections {
  groups: ConnectionSummary[];
  totalEstablished: number;
  truncated: boolean;
  collectedAt: string;
}

export interface DockerContainerDetails {
  id: string;
  name: string;
  imageReference: string;
  imageContentId: string;
  state: string;
  running: boolean;
  paused: boolean;
  restarting: boolean;
  oomKilled: boolean;
  dead: boolean;
  exitCode: number;
  startedAt: string | null;
  finishedAt: string | null;
  healthStatus: string | null;
  failingStreak: number | null;
  restartPolicy: string;
  restartMaximumRetryCount: number;
  publishedPorts: DockerPublishedPort[];
  networks: DockerNetworkAttachment[];
  mounts: DockerMount[];
  composeProject: string | null;
  composeService: string | null;
  composeContainerNumber: number | null;
  composeOneoff: boolean | null;
}

export interface DockerPublishedPort {
  containerPort: string;
  hostAddress: string;
  hostPort: number;
}

export interface DockerNetworkAttachment {
  name: string;
  ipv4Address: string | null;
  ipv4Gateway: string | null;
  ipv6Address: string | null;
  ipv6Gateway: string | null;
}

export interface DockerMount {
  mountType: string;
  name: string | null;
  destination: string;
  writable: boolean;
  propagation: string | null;
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
export type WorkspaceView =
  "overview" | "terminal" | "services" | "ports" | "docker" | "logs" | "history";

export interface CachedList<T> {
  items: T[];
  fetchedAt: number | null;
  loading: boolean;
  error: string | null;
}

export interface CachedValue<T> {
  value: T | null;
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
  portsCache: CachedList<ListeningSocket>;
  containersCache: CachedList<DockerContainer>;
  systemdSelectionId: string | null;
  containerSelectionId: string | null;
  containerDetailsCache: Record<string, CachedValue<DockerContainerDetails>>;
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
