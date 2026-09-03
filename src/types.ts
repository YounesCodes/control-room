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
  kernel: string | null;
  architecture: string | null;
  uptime: string | null;
  defaultShell: string | null;
  systemdAvailable: boolean;
  journaldAvailable: boolean;
  dockerAvailable: boolean;
  dockerAccessible: boolean;
  dockerAccessibleWithSudo: boolean;
  passwordlessSudo: boolean;
  dockerVersion: string | null;
  runningServiceCount: number | null;
  runningContainerCount: number | null;
  totalContainerCount: number | null;
  detectedAt: string;
}

/// One bounded sample of current load. Every field is nullable because a host
/// may expose part of /proc and not the rest, and a missing reading is shown as
/// missing rather than as zero, which would read as an idle host.
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

export interface BootDiagnostics {
  id: string;
  collectedAt: string;
  selectedBootId: string | null;
  boots: BootSection<BootRecord[]>;
  timing: BootSection<BootTiming>;
  slowUnits: BootSection<SlowBootUnit[]>;
  failedUnits: BootSection<SystemdUnit[]>;
  journal: BootSection<string[]>;
}

export interface BootSection<T> {
  collectedAt: string;
  data: T | null;
  error: string | null;
  permissionRequired: boolean;
}

export interface BootRecord {
  index: number;
  id: string;
  range: string;
  current: boolean;
}

export interface BootTiming {
  total: string | null;
  kernel: string | null;
  userspace: string | null;
  original: string;
}

export interface SlowBootUnit {
  unit: string;
  duration: string;
}

export interface HostIdentity {
  hostname: string | null;
  machineFingerprint: string | null;
  osId: string | null;
  osVersion: string | null;
  kernel: string | null;
  architecture: string | null;
}

export type BaselineSectionKind =
  "host" | "systemdUnits" | "containers" | "listeners" | "filesystems";

export type BaselineSectionStatus =
  "collected" | "partial" | "unsupported" | "unavailable" | "skipped";

export interface BaselineFact {
  name: string;
  value: string;
}

export interface BaselineEntry {
  identity: string;
  label: string;
  facts: BaselineFact[];
}

export interface BaselineSection {
  kind: BaselineSectionKind;
  status: BaselineSectionStatus;
  schemaVersion: number;
  collectedAt: string;
  message: string | null;
  entries: BaselineEntry[];
}

export interface BaselineTracePoint {
  baselineId: string;
  label: string | null;
  capturedAt: string;
  sectionStatus: BaselineSectionStatus;
  present: boolean;
  facts: BaselineFact[];
}

export interface BaselineTrace {
  kind: BaselineSectionKind;
  identity: string;
  label: string;
  points: BaselineTracePoint[];
}

export interface HostBaseline {
  id: string;
  connectionId: string;
  label: string | null;
  schemaVersion: number;
  capturedAt: string;
  pinned: boolean;
  identity: HostIdentity;
  sections: BaselineSection[];
}

export interface BaselineSectionSummary {
  kind: BaselineSectionKind;
  status: BaselineSectionStatus;
  entryCount: number;
}

export interface HostBaselineSummary {
  id: string;
  connectionId: string;
  label: string | null;
  schemaVersion: number;
  capturedAt: string;
  pinned: boolean;
  identity: HostIdentity;
  sections: BaselineSectionSummary[];
  changesSincePrevious: number | null;
}

export interface BaselineCaptureRequest {
  connectionId: string;
  captureId: string;
  label: string | null;
  sections: BaselineSectionKind[] | null;
}

export interface BaselineProgress {
  captureId: string;
  kind: BaselineSectionKind;
  status: BaselineSectionStatus;
  message: string | null;
  completed: number;
  total: number;
}

export interface BaselineFactChange {
  name: string;
  baseValue: string | null;
  targetValue: string | null;
}

export interface BaselineEntryChange {
  identity: string;
  label: string;
  changes: BaselineFactChange[];
}

export interface BaselineSectionDiff {
  kind: BaselineSectionKind;
  baseStatus: BaselineSectionStatus;
  targetStatus: BaselineSectionStatus;
  comparable: boolean;
  note: string | null;
  added: BaselineEntry[];
  removed: BaselineEntry[];
  changed: BaselineEntryChange[];
  unchangedCount: number;
}

export interface BaselineComparison {
  base: HostBaselineSummary;
  target: HostBaselineSummary;
  identityMatch: "same" | "different" | "unknown";
  schemaCompatible: boolean;
  targetIsLive: boolean;
  sections: BaselineSectionDiff[];
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
  globalSudoEnabled: boolean;
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
  | "overview"
  | "terminal"
  | "services"
  | "ports"
  | "docker"
  | "boot"
  | "logs"
  | "baselines"
  | "history"
  | "scratchpad";

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
  bootDiagnostics: BootDiagnostics | null;
  logSource: LogSourceSelection | null;
  baselineSelectionId: string | null;
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

export type ScratchpadScope = "connection" | "global";

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
    | "user-disconnect";
  reason: string | null;
}

export interface StreamStateEvent {
  streamId: string;
  state: "running" | "stopped" | "error";
  reason: string | null;
}
