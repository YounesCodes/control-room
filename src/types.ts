export interface SavedConnection {
  id: string;
  displayName: string;
  destination: string;
  username: string | null;
  port: number | null;
  identityFile: string | null;
  historyEnabled: boolean;
  sudoEnabled: boolean;
  groupId: string | null;
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
  sudoEnabled: boolean;
  groupId: string | null;
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
  color: string;
}

export interface HostCapabilities {
  connectionId: string;
  hostname: string | null;
  osId: string | null;
  osName: string | null;
  osVersion: string | null;
  osFamily?: string | null;
  kernel: string | null;
  architecture: string | null;
  uptime: string | null;
  defaultShell: string | null;
  systemdAvailable: boolean;
  journaldAvailable: boolean;
  launchdAvailable?: boolean;
  unifiedLogAvailable?: boolean;
  dockerAvailable: boolean;
  dockerAccessible: boolean;
  dockerAccessibleWithSudo: boolean;
  passwordlessSudo: boolean;
  dockerVersion: string | null;
  dockerContext?: string | null;
  dockerEndpoint?: string | null;
  dockerRemote?: boolean;
  runningServiceCount: number | null;
  runningContainerCount: number | null;
  totalContainerCount: number | null;
  detectedAt: string;
}

export interface RemoteShellProfile {
  id: string;
  label: string;
}

export interface RemoteShellCatalog {
  platform: "linux" | "windows" | "macos";
  shells: RemoteShellProfile[];
  windowsTerminalAvailable: boolean;
  wslError: string | null;
  profileError?: string | null;
  capabilities?: HostCapabilities | null;
}

export interface HostResources {
  sampledAt: string;
  cpuPercent: number | null;
  coreCount: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  memoryTotalKib: number | null;
  memoryAvailableKib: number | null;
  swapTotalKib: number | null;
  swapFreeKib: number | null;
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

export type SystemdReadSection =
  "properties" | "configuration" | "effectiveConfiguration" | "journal";

export interface SystemdInspection {
  id: string;
  properties: Record<string, string>;
  text: string;
  warnings: string[];
  truncated: boolean;
  collectedAt: string;
}

export interface SystemdExplorerState {
  mode: "inventory" | "graph";
  rootId: string | null;
  expanded: string[];
  search: string;
  dependencySearch?: string;
  state: string;
  unitType: string;
  sort: "priority" | "name" | "state" | "type";
  scope?: "focused" | "all";
  relationshipGroup: "dependencies" | "ordering" | "activation";
  visibleLimit?: number;
}

export interface WindowsService {
  id: string;
  displayName: string;
  description: string | null;
  state: string;
  startMode: string;
  processId: number | null;
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
  backend?: "ufw" | "firewalld" | "windows" | "macos" | null;
  available: boolean;
  active: boolean | null;
  defaultIncoming: string | null;
  rules: FirewallRule[];
  packetFilter?: {
    active: boolean | null;
    rules: string[];
    error: string | null;
    permissionRequired: boolean;
  } | null;
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

export type HistoryIntegrationStatus = "installed" | "not-installed" | "update-available";

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

export type HeaderMetric = "cpu" | "ram" | "gpu" | "disk" | "diskIo" | "uptime";

export interface HeaderMetrics {
  sampledAt: string;
  cpuPercent: number | null;
  memoryTotalKib: number | null;
  memoryAvailableKib: number | null;
  gpuPercent: number | null;
  diskTotalKib: number | null;
  diskFreeKib: number | null;
  diskLabel: string | null;
  diskReadBytesPerSecond: number | null;
  diskWriteBytesPerSecond: number | null;
  uptimeSeconds: number | null;
}

export interface AppSettings {
  automaticTerminalTitles?: boolean;
  hostMetricsEnabled?: boolean;
  hostMetrics?: HeaderMetric[];
  hostMetricsIntervalSeconds?: number;
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
  globalSudoEnabled: boolean;
  automaticUpdateChecks: boolean;
  hiddenLocalShells: string[];
  localTerminalMode: boolean;
  defaultLocalShellId: string | null;
}

export interface AppUpdateInfo {
  currentVersion: string;
  version: string;
  notes: string | null;
  publishedAt: string | null;
}

export interface PendingUpdateNotice {
  version: string;
  notes: string | null;
  publishedAt: string | null;
}

export type UpdateFailureKind = "check" | "download" | "signature" | "install";

export interface UpdateFailure {
  kind: UpdateFailureKind;
  message: string;
}

export type UpdateProgress =
  | { event: "started"; contentLength: number | null }
  | { event: "progress"; downloaded: number; total: number | null }
  | { event: "finished" };

export interface SettingsContract {
  current: AppSettings;
  defaults: AppSettings;
  logTailOptions: number[];
}

export interface EnvironmentInfo {
  platform: "windows" | "macos" | "linux" | "unsupported";
  sshPath: string | null;
  sshConfigPath: string;
  sshAgentAvailable: boolean;
  platformSupported: boolean;
  desktopOs?: string;
  inAppUpdates?: boolean;
}

export type LocalShellKind =
  | "powershell-7"
  | "windows-powershell"
  | "command-prompt"
  | "git-bash"
  | "bash"
  | "zsh"
  | "fish"
  | "sh"
  | "login-shell";

export interface LocalShellProfile {
  id: string;
  label: string;
  kind: LocalShellKind;
  elevated: boolean;
}

export type AdministratorTerminalStatus =
  "available" | "disabled" | "unsupportedMode" | "unsupportedWindows" | "unsupportedPlatform";

export interface LocalShellCatalog {
  profiles: LocalShellProfile[];
  administratorStatus: AdministratorTerminalStatus;
}

export type ConnectionState = "connecting" | "connected" | "disconnected" | "error";
export type WorkspaceView = "terminal" | "services" | "ports" | "docker" | "logs" | "history";

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

interface WorkspaceBase {
  id: string;
  label: string | null;
  sessionId: string | null;
  state: ConnectionState;
  reason: string | null;
  view: WorkspaceView;
  reconnectToken: number;
  connectRequested: boolean;
  restored?: boolean;
}

export interface ContainerTerminalTarget {
  id: string;
  name: string;
  image: string;
}

export interface RemoteWorkspace extends WorkspaceBase {
  kind: "remote";
  connectionId: string;
  connectionSnapshot: SavedConnection;
  remoteShell?: RemoteShellProfile | null;
  container?: ContainerTerminalTarget | null;
  historyPaused: boolean;
  servicesCache: CachedList<SystemdUnit>;
  portsCache: CachedList<ListeningSocket>;
  containersCache: CachedList<DockerContainer>;
  systemdSelectionId: string | null;
  systemdExplorer?: SystemdExplorerState;
  containerSelectionId: string | null;
  containerDetailsCache: Record<string, CachedValue<DockerContainerDetails>>;
  logSource: LogSourceSelection | null;
}

export interface LocalWorkspace extends WorkspaceBase {
  kind: "local";
  shell: LocalShellProfile;
}

export type Workspace = RemoteWorkspace | LocalWorkspace;

export type WorkspacePatch = Partial<Omit<WorkspaceBase, "id">>;

interface PersistedWorkspace {
  id: string;
  label: string | null;
  connectionId: string | null;
  localShellId: string | null;
  remoteShell?: RemoteShellProfile | null;
  container?: ContainerTerminalTarget | null;
  view: WorkspaceView | "scratchpad";
  historyPaused: boolean;
}

export interface PersistedWorkspaceState {
  panelSizes?: import("./lib/panel-layout").PanelSizes;
  workspaces: PersistedWorkspace[];
  activeWorkspaceId: string | null;
  terminalGroups?: import("./lib/terminal-groups").TerminalGroup[];
  terminalLayout?: import("./lib/terminal-layout").TerminalLayout | null;
}

export type ScratchpadScope = "connection" | "global" | "local";

export interface ScratchpadNote {
  id: string;
  scope: ScratchpadScope;
  ownerId: string;
  connectionId: string | null;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScratchpadNoteInput {
  scope: ScratchpadScope;
  ownerId: string;
  connectionId: string | null;
  text: string;
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
    | "user-disconnect"
    | "local-exit"
    | "user-stop";
  reason: string | null;
}

export interface StreamStateEvent {
  streamId: string;
  state: "running" | "stopped" | "error";
  reason: string | null;
}

export interface StreamNoticeEvent {
  streamId: string;
  notice: "journal-restricted";
}

export interface CatalogFont {
  id: string;
  family: string;
  license: string;
}

export interface FontCatalog {
  fonts: CatalogFont[];
  stale: boolean;
}

export interface FontProgress {
  stage: "downloadingRegular" | "downloadingBold" | "installing" | "ready";
  completed: number;
  total: number | null;
}
