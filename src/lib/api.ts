import { Channel, invoke } from "@tauri-apps/api/core";
import { beginHostOperation } from "./host-processing";
import type { FileJob, RemoteFolder, TransferProgress } from "./file-transfers";
import type {
  AppSettings,
  FontCatalog,
  FontProgress,
  AppUpdateInfo,
  ConnectionGroup,
  ConnectionTag,
  DockerContainer,
  DockerContainerDetails,
  EnvironmentInfo,
  EstablishedConnections,
  FirewallStatus,
  HistoryEntry,
  HistoryInput,
  HistoryIntegrationStatus,
  HostCapabilities,
  HostResources,
  HeaderMetric,
  HeaderMetrics,
  ListeningSocket,
  LocalShellCatalog,
  RemoteShellCatalog,
  WindowsService,
  PersistedWorkspaceState,
  SavedConnection,
  SavedConnectionInput,
  ScratchpadNote,
  ScratchpadNoteInput,
  ScratchpadScope,
  SettingsContract,
  SystemdUnit,
  SystemdInspection,
  SystemdReadSection,
  PendingUpdateNotice,
  UpdateProgress,
  SessionStarted,
  LocalSessionStarted,
  StreamStarted,
} from "../types";

export const REMOTE_INSPECTION_TIMEOUT_MS = 30_000;
export const REMOTE_DISCOVERY_TIMEOUT_MS = 60_000;
const REMOTE_INSPECTION_TIMEOUT_SECONDS = REMOTE_INSPECTION_TIMEOUT_MS / 1000;
const REMOTE_INSPECTION_TIMEOUT_MESSAGE = `Remote inspection did not respond after ${REMOTE_INSPECTION_TIMEOUT_SECONDS} seconds`;

const terminalInputWrites = new Map<string, Promise<void>>();

function writeTerminalInput(sessionId: string, bytes: Uint8Array): Promise<void> {
  const data = Array.from(bytes);
  // Tauri does not preserve the order of concurrent invoke calls.
  const write = (terminalInputWrites.get(sessionId) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => invoke<void>("write_session", { sessionId, data }))
    .finally(() => {
      if (terminalInputWrites.get(sessionId) === write) terminalInputWrites.delete(sessionId);
    });
  terminalInputWrites.set(sessionId, write);
  return write;
}

function invokeRemoteRead<T>(
  command: string,
  args: Record<string, unknown>,
  timeoutMessage = REMOTE_INSPECTION_TIMEOUT_MESSAGE,
  timeoutMs = REMOTE_INSPECTION_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    void invoke<T>(command, args).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function invokeRemoteInspection<T>(
  command: string,
  args: Record<string, unknown>,
  timeoutMessage = REMOTE_INSPECTION_TIMEOUT_MESSAGE,
  timeoutMs = REMOTE_INSPECTION_TIMEOUT_MS,
): Promise<T> {
  const finish = beginHostOperation(args.connectionId);
  return invokeRemoteRead<T>(command, args, timeoutMessage, timeoutMs).finally(finish);
}

function invokeHostOperation<T>(
  command: string,
  args: Record<string, unknown>,
  connectionId: unknown,
) {
  const finish = beginHostOperation(connectionId);
  return invoke<T>(command, args).finally(finish);
}

export const api = {
  listTransferFolder: (connectionId: string, folder: string | null) =>
    invoke<RemoteFolder>("list_transfer_folder", { connectionId, folder }),
  chooseTransferPaths: (direction: FileJob["direction"]) =>
    invoke<string[]>("choose_transfer_paths", { direction }),
  cancelTransfer: (id: string) => invoke<void>("cancel_transfer", { id }),
  transferFile: (job: FileJob, progress: Channel<TransferProgress>) => {
    const { destination, username, port, identityFile } = job.connection;
    return invoke<"complete" | "exists">("transfer_file", {
      connectionId: job.connection.id,
      expectedTarget: [destination, username, port, identityFile],
      spec: {
        id: job.id,
        direction: job.direction,
        remotePath: job.remotePath,
        localPath: job.localPath,
        replace: job.replace,
        folder: job.folder,
      },
      progress,
    });
  },
  openDocumentation: () => invoke<void>("open_documentation"),
  openReleases: () => invoke<void>("open_releases"),
  readClipboard: () => invoke<string | null>("read_clipboard"),
  writeClipboard: (text: string) => invoke<void>("write_clipboard", { text }),
  windowCompositing: () => invoke<boolean>("window_compositing"),
  environment: () => invoke<EnvironmentInfo>("get_environment_info"),
  listConnections: () => invoke<SavedConnection[]>("list_connections"),
  createConnection: (input: SavedConnectionInput) =>
    invoke<SavedConnection>("create_connection", { input }),
  updateConnection: (id: string, input: SavedConnectionInput) =>
    invoke<SavedConnection>("update_connection", { id, input }),
  testConnection: (input: SavedConnectionInput) =>
    invokeRemoteInspection<HostCapabilities>(
      "test_connection",
      { input },
      "Remote discovery did not respond after 60 seconds",
      REMOTE_DISCOVERY_TIMEOUT_MS,
    ),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),
  listConnectionGroups: () => invoke<ConnectionGroup[]>("list_connection_groups"),
  listConnectionTags: () => invoke<ConnectionTag[]>("list_connection_tags"),
  createConnectionTag: (name: string, color: string) =>
    invoke<ConnectionTag>("create_connection_tag", { name, color }),
  renameConnectionTag: (id: string, name: string) =>
    invoke<ConnectionTag>("rename_connection_tag", { id, name }),
  deleteConnectionTag: (id: string) => invoke<void>("delete_connection_tag", { id }),
  setConnectionTagColor: (id: string, color: string) =>
    invoke<ConnectionTag>("set_connection_tag_color", { id, color }),
  createConnectionGroup: (name: string) =>
    invoke<ConnectionGroup>("create_connection_group", { name }),
  renameConnectionGroup: (id: string, name: string) =>
    invoke<ConnectionGroup>("rename_connection_group", { id, name }),
  deleteConnectionGroup: (id: string) => invoke<void>("delete_connection_group", { id }),
  setConnectionGroupCollapsed: (id: string, collapsed: boolean) =>
    invoke<void>("set_connection_group_collapsed", { id, collapsed }),
  moveConnectionGroup: (id: string, direction: "up" | "down") =>
    invoke<ConnectionGroup[]>("move_connection_group", { id, direction }),
  discoverRemoteShells: (connectionId: string, refresh = false) =>
    invokeRemoteInspection<RemoteShellCatalog>(
      "discover_remote_shells",
      { connectionId, refresh },
      "Remote shell detection did not respond after 60 seconds",
      REMOTE_DISCOVERY_TIMEOUT_MS,
    ),
  startSession: (
    connectionId: string,
    cols: number,
    rows: number,
    output: Channel<ArrayBuffer>,
    remoteShellId: string | null = null,
    containerId: string | null = null,
  ) =>
    invoke<SessionStarted>("start_session", {
      connectionId,
      remoteShellId,
      containerId,
      cols,
      rows,
      output,
    }),
  listLocalShells: () => invoke<LocalShellCatalog>("list_local_shells"),
  startLocalSession: (shellId: string, cols: number, rows: number, output: Channel<ArrayBuffer>) =>
    invoke<LocalSessionStarted>("start_local_session", {
      shellId,
      cols,
      rows,
      output,
    }),
  writeSession: writeTerminalInput,
  resizeSession: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("resize_session", { sessionId, cols, rows }),
  acknowledgeSessionOutput: (sessionId: string, bytes: number) =>
    invoke<void>("acknowledge_session_output", { sessionId, bytes }),
  closeSession: (sessionId: string) => invoke<void>("close_session", { sessionId }),
  cachedCapabilities: (connectionId: string) =>
    invoke<HostCapabilities | null>("get_cached_capabilities", { connectionId }),
  refreshCapabilities: (connectionId: string) =>
    invokeRemoteInspection<HostCapabilities>(
      "refresh_capabilities",
      { connectionId },
      "Remote discovery did not respond after 60 seconds",
      REMOTE_DISCOVERY_TIMEOUT_MS,
    ),
  sampleHeaderMetrics: (connectionId: string | null, metrics: HeaderMetric[]) =>
    invokeRemoteRead<HeaderMetrics>(
      "sample_header_metrics",
      { connectionId, metrics },
      `Host metrics did not respond after ${REMOTE_INSPECTION_TIMEOUT_SECONDS} seconds`,
    ),
  sampleHostResources: (connectionId: string) =>
    invokeRemoteInspection<HostResources>("sample_host_resources", { connectionId }),
  inspectSystemdUnit: (connectionId: string, unit: string, section: SystemdReadSection) =>
    invokeRemoteInspection<SystemdInspection>("inspect_systemd_unit", {
      connectionId,
      unit,
      section,
    }),
  listServices: (connectionId: string) =>
    invokeRemoteInspection<SystemdUnit[]>("list_services", { connectionId }),
  listWindowsServices: (connectionId: string) =>
    invokeRemoteInspection<WindowsService[]>("list_windows_services", { connectionId }),
  listContainers: (connectionId: string, sudoPassword: string | null = null) =>
    invokeRemoteInspection<DockerContainer[]>("list_containers", { connectionId, sudoPassword }),
  listPorts: (connectionId: string, sudoPassword: string | null = null) =>
    invokeRemoteInspection<ListeningSocket[]>("list_ports", { connectionId, sudoPassword }),
  inspectFirewall: (connectionId: string, sudoPassword: string | null = null) =>
    invokeRemoteInspection<FirewallStatus>("inspect_firewall", { connectionId, sudoPassword }),
  inspectConnections: (connectionId: string) =>
    invokeRemoteInspection<EstablishedConnections>("inspect_connections", { connectionId }),
  inspectContainer: (
    connectionId: string,
    containerId: string,
    sudoPassword: string | null = null,
  ) =>
    invokeRemoteInspection<DockerContainerDetails>("inspect_container", {
      connectionId,
      containerId,
      sudoPassword,
    }),
  startJournalStream: (
    connectionId: string,
    service: string,
    lines: number,
    follow: boolean,
    sudoPassword: string | null,
    output: Channel<ArrayBuffer>,
  ) =>
    invokeHostOperation<StreamStarted>(
      "start_journal_stream",
      {
        connectionId,
        service,
        lines,
        follow,
        sudoPassword,
        output,
      },
      connectionId,
    ),
  startDockerLogStream: (
    connectionId: string,
    container: string,
    lines: number,
    follow: boolean,
    sudoPassword: string | null,
    output: Channel<ArrayBuffer>,
  ) =>
    invokeHostOperation<StreamStarted>(
      "start_docker_log_stream",
      {
        connectionId,
        container,
        lines,
        follow,
        sudoPassword,
        output,
      },
      connectionId,
    ),
  stopLogStream: (streamId: string) => invoke<void>("stop_log_stream", { streamId }),
  history: (connectionId: string, search = "", limit = 500) =>
    invoke<HistoryEntry[]>("get_history", { connectionId, search, limit }),
  addHistory: (input: HistoryInput) => invoke<HistoryEntry>("add_history_entry", { input }),
  deleteHistory: (id: string) => invoke<void>("delete_history_entry", { id }),
  clearHistory: (connectionId: string) => invoke<void>("clear_history", { connectionId }),
  setConnectionHistoryEnabled: (connectionId: string, enabled: boolean) =>
    invoke<SavedConnection>("set_connection_history_enabled", { connectionId, enabled }),
  currentAppVersion: () => invoke<string>("current_app_version"),
  checkForUpdate: () => invoke<AppUpdateInfo | null>("check_for_update"),
  downloadUpdate: (progress: Channel<UpdateProgress>) =>
    invoke<void>("download_update", { progress }),
  installUpdate: () => invoke<void>("install_update"),
  pendingUpdateNotice: () => invoke<PendingUpdateNotice | null>("pending_update_notice"),
  dismissUpdateNotice: () => invoke<void>("dismiss_update_notice"),
  listCatalogFonts: () => invoke<FontCatalog>("list_catalog_fonts"),
  previewCatalogFont: (id: string) => invoke<ArrayBuffer>("preview_catalog_font", { id }),
  installCatalogFont: (id: string, progress: Channel<FontProgress>) =>
    invoke<string>("install_catalog_font", { id, progress }),
  settingsContract: () => invoke<SettingsContract>("get_settings_contract"),
  saveSettings: (settings: AppSettings) => invoke<void>("save_settings", { settings }),
  workspaceState: () => invoke<PersistedWorkspaceState>("get_workspace_state"),
  saveWorkspaceState: (state: PersistedWorkspaceState) =>
    invoke<void>("save_workspace_state", { state }),
  scratchpadNote: (scope: ScratchpadScope, ownerId: string, connectionId: string | null) =>
    invoke<ScratchpadNote | null>("get_scratchpad_note", { scope, ownerId, connectionId }),
  saveScratchpadNote: (input: ScratchpadNoteInput) =>
    invoke<ScratchpadNote>("save_scratchpad_note", { input }),
  deleteScratchpadNote: (scope: ScratchpadScope, ownerId: string, connectionId: string | null) =>
    invoke<void>("delete_scratchpad_note", { scope, ownerId, connectionId }),
  historyIntegrationStatus: (connectionId: string) =>
    invoke<HistoryIntegrationStatus>("get_history_integration_status", { connectionId }),
  installHistoryIntegration: (connectionId: string, enableCapture = true) =>
    invoke<SavedConnection>("install_history_integration", { connectionId, enableCapture }),
  uninstallHistoryIntegration: (connectionId: string) =>
    invoke<SavedConnection>("uninstall_history_integration", { connectionId }),
};

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred";
}
