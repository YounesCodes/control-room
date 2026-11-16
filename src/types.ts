import type {
  AdministratorTerminalStatus,
  AppSettings,
  AppUpdateInfo,
  CatalogFont,
  ConnectionGroup,
  ConnectionRemote,
  ConnectionSummary,
  ConnectionTag,
  ContainerTerminalTarget,
  DockerContainer,
  DockerContainerDetails,
  DockerMount,
  DockerNetworkAttachment,
  DockerPublishedPort,
  EnvironmentInfo,
  EstablishedConnections,
  FirewallRule,
  FirewallStatus,
  FontCatalog,
  FontProgress,
  HeaderMetric,
  HeaderMetrics,
  HistoryEntry,
  HistoryInput,
  HistoryIntegrationStatus,
  HostCapabilities,
  HostResources,
  ListeningSocket,
  LocalSessionStarted,
  LocalShellCatalog,
  LocalShellKind,
  LocalShellProfile,
  PacketFilterStatus,
  PendingUpdateNotice,
  PersistedTerminalGroup,
  PersistedTerminalLayout,
  PersistedWorkspace,
  PersistedWorkspaceState,
  PersistedWorkspaceView,
  RemoteShellCatalog,
  RemoteShellProfile,
  SavedConnection,
  SavedConnectionInput,
  ScratchpadNote,
  ScratchpadNoteInput,
  ScratchpadScope,
  SessionEndCategory,
  SessionStarted,
  SessionState,
  SessionStateEvent,
  SettingsContract,
  StreamNotice,
  StreamNoticeEvent,
  StreamStarted,
  StreamState,
  StreamStateEvent,
  SystemdInspection,
  SystemdReadSection,
  SystemdUnit,
  UpdateFailure,
  UpdateFailureKind,
  UpdateProgress,
  WindowsService,
} from "./generated/ipc";

export type {
  AdministratorTerminalStatus,
  AppSettings,
  AppUpdateInfo,
  CatalogFont,
  ConnectionGroup,
  ConnectionRemote,
  ConnectionSummary,
  ConnectionTag,
  ContainerTerminalTarget,
  DockerContainer,
  DockerContainerDetails,
  DockerMount,
  DockerNetworkAttachment,
  DockerPublishedPort,
  EnvironmentInfo,
  EstablishedConnections,
  FirewallRule,
  FirewallStatus,
  FontCatalog,
  FontProgress,
  HeaderMetric,
  HeaderMetrics,
  HistoryEntry,
  HistoryInput,
  HistoryIntegrationStatus,
  HostCapabilities,
  HostResources,
  ListeningSocket,
  LocalSessionStarted,
  LocalShellCatalog,
  LocalShellKind,
  LocalShellProfile,
  PacketFilterStatus,
  PendingUpdateNotice,
  PersistedTerminalGroup,
  PersistedTerminalLayout,
  PersistedWorkspace,
  PersistedWorkspaceState,
  PersistedWorkspaceView,
  RemoteShellCatalog,
  RemoteShellProfile,
  SavedConnection,
  SavedConnectionInput,
  ScratchpadNote,
  ScratchpadNoteInput,
  ScratchpadScope,
  SessionEndCategory,
  SessionStarted,
  SessionState,
  SessionStateEvent,
  SettingsContract,
  StreamNotice,
  StreamNoticeEvent,
  StreamStarted,
  StreamState,
  StreamStateEvent,
  SystemdInspection,
  SystemdReadSection,
  SystemdUnit,
  UpdateFailure,
  UpdateFailureKind,
  UpdateProgress,
  WindowsService,
};

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

export type ConnectionState = "connecting" | SessionState;
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
