export type SavedConnection = {
  id: string;
  displayName: string;
  destination: string;
  username: string | null;
  port: number | null;
  identityFile: string | null;
  historyEnabled: boolean;
  sudoEnabled: boolean;
  groupId: string | null;
  tags: Array<ConnectionTag>;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt: string | null;
};

export type SavedConnectionInput = {
  displayName: string;
  destination: string;
  username: string | null;
  port: number | null;
  identityFile: string | null;
  historyEnabled: boolean;
  sudoEnabled: boolean;
  groupId: string | null;
  tagNames: Array<string>;
};

export type ConnectionGroup = {
  id: string;
  name: string;
  position: number;
  collapsed: boolean;
};

export type ConnectionTag = {
  id: string;
  name: string;
  color: string;
};

export type HostCapabilities = {
  connectionId: string;
  hostname: string | null;
  osId: string | null;
  osName: string | null;
  osVersion: string | null;
  osFamily: string | null;
  kernel: string | null;
  architecture: string | null;
  uptime: string | null;
  defaultShell: string | null;
  systemdAvailable: boolean;
  journaldAvailable: boolean;
  launchdAvailable: boolean;
  unifiedLogAvailable: boolean;
  dockerAvailable: boolean;
  dockerAccessible: boolean;
  dockerAccessibleWithSudo: boolean;
  passwordlessSudo: boolean;
  dockerVersion: string | null;
  dockerContext: string | null;
  dockerEndpoint: string | null;
  dockerRemote: boolean;
  runningServiceCount: number | null;
  runningContainerCount: number | null;
  totalContainerCount: number | null;
  detectedAt: string;
};

export type RemoteShellProfile = {
  id: string;
  label: string;
};

export type RemoteShellCatalog = {
  platform: "linux" | "windows" | "macos";
  shells: Array<RemoteShellProfile>;
  windowsTerminalAvailable: boolean;
  wslError: string | null;
  capabilities: HostCapabilities | null;
  profileError: string | null;
};

export type HostResources = {
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
};

export type SystemdUnit = {
  id: string;
  unitType: string;
  description: string;
  loadState: string;
  activeState: string;
  subState: string;
  unitFileState: string | null;
};

export type SystemdReadSection = "properties" | "configuration" | "effectiveConfiguration" | "journal";

export type SystemdInspection = {
  id: string;
  properties: { [key in string]: string };
  text: string;
  warnings: Array<string>;
  truncated: boolean;
  collectedAt: string;
};

export type WindowsService = {
  id: string;
  displayName: string;
  description: string | null;
  state: string;
  startMode: string;
  processId: number | null;
};

export type DockerContainer = {
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
};

export type DockerContainerDetails = {
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
  publishedPorts: Array<DockerPublishedPort>;
  networks: Array<DockerNetworkAttachment>;
  mounts: Array<DockerMount>;
  composeProject: string | null;
  composeService: string | null;
  composeContainerNumber: number | null;
  composeOneoff: boolean | null;
};

export type DockerPublishedPort = {
  containerPort: string;
  hostAddress: string;
  hostPort: number;
};

export type DockerNetworkAttachment = {
  name: string;
  ipv4Address: string | null;
  ipv4Gateway: string | null;
  ipv6Address: string | null;
  ipv6Gateway: string | null;
};

export type DockerMount = {
  mountType: string;
  name: string | null;
  destination: string;
  writable: boolean;
  propagation: string | null;
};

export type ListeningSocket = {
  id: string;
  protocol: "tcp" | "udp";
  addressFamily: "ipv4" | "ipv6";
  localAddress: string;
  port: number;
  processName: string | null;
  processId: number | null;
  systemdUnit: string | null;
  ownership: "known" | "unavailable" | "ambiguous";
};

export type FirewallRule = {
  to: string;
  action: string;
  from: string;
  port: number | null;
  protocol: string | null;
  ipv6: boolean;
};

export type FirewallStatus = {
  backend: "ufw" | "firewalld" | "windows" | "macos" | null;
  available: boolean;
  active: boolean | null;
  defaultIncoming: string | null;
  rules: Array<FirewallRule>;
  packetFilter?: PacketFilterStatus;
  collectedAt: string;
};

export type PacketFilterStatus = {
  active: boolean | null;
  rules: Array<string>;
  error: string | null;
  permissionRequired: boolean;
};

export type ConnectionRemote = {
  address: string;
  count: number;
};

export type ConnectionSummary = {
  key: string;
  protocol: string;
  localPort: number;
  processName: string | null;
  processId: number | null;
  systemdUnit: string | null;
  established: number;
  remoteAddressCount: number;
  remotes: Array<ConnectionRemote>;
};

export type EstablishedConnections = {
  groups: Array<ConnectionSummary>;
  totalEstablished: number;
  truncated: boolean;
  collectedAt: string;
};

export type HistoryIntegrationStatus = "installed" | "not-installed" | "update-available";

export type HistoryEntry = {
  id: string;
  connectionId: string;
  sessionId: string;
  command: string;
  cwd: string | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  shell: string;
};

export type HistoryInput = {
  connectionId: string;
  sessionId: string;
  command: string;
  cwd: string | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  shell: string;
};

export type HeaderMetric = "cpu" | "ram" | "gpu" | "disk" | "diskIo" | "uptime";

export type HeaderMetrics = {
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
};

export type AppSettings = {
  automaticTerminalTitles: boolean;
  restoreTerminalsOnStartup: boolean;
  hostMetricsEnabled: boolean;
  hostMetrics: Array<HeaderMetric>;
  hostMetricsIntervalSeconds: number;
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
  hiddenLocalShells: Array<string>;
  localTerminalMode: boolean;
  defaultLocalShellId: string | null;
};

export type SettingsContract = {
  current: AppSettings;
  defaults: AppSettings;
  logTailOptions: Array<number>;
};

export type AppUpdateInfo = {
  currentVersion: string;
  version: string;
  notes: string | null;
  publishedAt: string | null;
};

export type PendingUpdateNotice = {
  version: string;
  notes: string | null;
  publishedAt: string | null;
};

export type UpdateFailureKind = "check" | "download" | "signature" | "install";

export type UpdateFailure = {
  kind: UpdateFailureKind;
  message: string;
};

export type UpdateProgress = { "event": "started", contentLength: number | null, } | { "event": "progress", downloaded: number, total: number | null, } | { "event": "finished" };

export type EnvironmentInfo = {
  platform: "windows" | "macos" | "linux" | "unsupported";
  sshPath: string | null;
  sshConfigPath: string;
  sshAgentAvailable: boolean;
  platformSupported: boolean;
  desktopOs: string;
  inAppUpdates: boolean;
};

export type LocalShellKind = "powershell-7" | "windows-powershell" | "command-prompt" | "git-bash" | "zsh" | "bash" | "fish" | "sh" | "login-shell" | "wsl";

export type LocalShellProfile = {
  id: string;
  label: string;
  kind: LocalShellKind;
  elevated: boolean;
};

export type AdministratorTerminalStatus = "available" | "disabled" | "unsupportedMode" | "unsupportedWindows" | "unsupportedPlatform";

export type LocalShellCatalog = {
  profiles: Array<LocalShellProfile>;
  administratorStatus: AdministratorTerminalStatus;
};

export type SessionStarted = {
  sessionId: string;
  connectionId: string;
};

export type LocalSessionStarted = {
  sessionId: string;
  shellId: string;
};

export type SessionState = "connected" | "disconnected" | "error";

export type SessionEndCategory = "authentication" | "host-resolution" | "connection-refused" | "connection-timeout" | "host-key" | "connection-lost" | "process" | "remote-exit" | "user-disconnect" | "local-exit" | "user-stop";

export type SessionStateEvent = {
  sessionId: string;
  state: SessionState;
  category: SessionEndCategory | null;
  reason: string | null;
};

export type StreamStarted = {
  streamId: string;
};

export type StreamState = "stopped" | "error";

export type StreamStateEvent = {
  streamId: string;
  state: StreamState;
  reason: string | null;
};

export type StreamNotice = "journal-restricted";

export type StreamNoticeEvent = {
  streamId: string;
  notice: StreamNotice;
};

export type ContainerTerminalTarget = {
  id: string;
  name: string;
  image: string;
};

export type PersistedWorkspace = {
  id: string;
  label: string | null;
  connectionId: string | null;
  localShellId: string | null;
  remoteShell?: RemoteShellProfile;
  container?: ContainerTerminalTarget;
  view: PersistedWorkspaceView;
  historyPaused: boolean;
};

export type PersistedWorkspaceState = {
  panelSizes: { [key in string]: number };
  workspaces: Array<PersistedWorkspace>;
  activeWorkspaceId: string | null;
  terminalGroups: Array<PersistedTerminalGroup>;
  terminalLayout: PersistedTerminalLayout | null;
};

export type PersistedTerminalGroup = {
  id: string;
  name: string;
  layout: PersistedTerminalLayout;
};

export type PersistedTerminalLayout = { "kind": "leaf", workspaceId: string, } | { "kind": "split", direction: "vertical" | "horizontal", ratio?: number, first: PersistedTerminalLayout, second: PersistedTerminalLayout, };

export type ScratchpadNote = {
  id: string;
  scope: ScratchpadScope;
  ownerId: string;
  connectionId: string | null;
  text: string;
  createdAt: string;
  updatedAt: string;
};

export type ScratchpadNoteInput = {
  scope: ScratchpadScope;
  ownerId: string;
  connectionId: string | null;
  text: string;
};

export type CatalogFont = {
  id: string;
  family: string;
  license: string;
  category: string;
  type: string;
  weights: Array<number>;
  styles: Array<string>;
  subsets: Array<string>;
};

export type FontCatalog = {
  fonts: Array<CatalogFont>;
  stale: boolean;
};

export type FontProgress = {
  stage: "downloadingRegular" | "downloadingBold" | "installing" | "ready";
  completed: number;
  total: number | null;
};

export type ScratchpadScope = "connection" | "global" | "local";

export type PersistedWorkspaceView = "terminal" | "files" | "services" | "ports" | "docker" | "logs" | "history" | "scratchpad";

export const MAX_SCRATCHPAD_CHARS = 16384;
export const MAX_HISTORY_COMMAND_BYTES = 1048576;
export const MAX_HISTORY_CWD_BYTES = 32767;
export const REMOTE_COMMAND_TIMEOUT_SECONDS = 20;
export const REMOTE_QUEUE_WAIT_SECONDS = 4;
