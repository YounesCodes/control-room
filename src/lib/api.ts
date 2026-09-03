import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  ConnectionGroup,
  ConnectionTag,
  DockerContainer,
  DockerContainerDetails,
  EnvironmentInfo,
  EstablishedConnections,
  FirewallStatus,
  HistoryEntry,
  HistoryInput,
  HostCapabilities,
  HostBaseline,
  HostBaselineSummary,
  ListeningSocket,
  PersistedWorkspaceState,
  SavedConnection,
  SavedConnectionInput,
  ScratchpadNote,
  ScratchpadNoteInput,
  ScratchpadScope,
  SettingsContract,
  BaselineCaptureRequest,
  BaselineComparison,
  BaselineProgress,
  BaselineSectionKind,
  BaselineTrace,
  SystemdUnit,
} from "../types";

const REMOTE_INSPECTION_TIMEOUT_MS = 25_000;
const REMOTE_INSPECTION_TIMEOUT_MESSAGE = "Remote inspection did not respond after 25 seconds";

function invokeRemoteInspection<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(REMOTE_INSPECTION_TIMEOUT_MESSAGE)),
      REMOTE_INSPECTION_TIMEOUT_MS,
    );
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

export const api = {
  environment: () => invoke<EnvironmentInfo>("get_environment_info"),
  listConnections: () => invoke<SavedConnection[]>("list_connections"),
  createConnection: (input: SavedConnectionInput) =>
    invoke<SavedConnection>("create_connection", { input }),
  updateConnection: (id: string, input: SavedConnectionInput) =>
    invoke<SavedConnection>("update_connection", { id, input }),
  testConnection: (input: SavedConnectionInput) =>
    invokeRemoteInspection<HostCapabilities>("test_connection", { input }),
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
  startSession: (connectionId: string, cols: number, rows: number, output: Channel<ArrayBuffer>) =>
    invoke<{ sessionId: string; connectionId: string }>("start_session", {
      connectionId,
      cols,
      rows,
      output,
    }),
  writeSession: (sessionId: string, data: Uint8Array) =>
    invoke<void>("write_session", { sessionId, data: Array.from(data) }),
  resizeSession: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("resize_session", { sessionId, cols, rows }),
  acknowledgeSessionOutput: (sessionId: string, bytes: number) =>
    invoke<void>("acknowledge_session_output", { sessionId, bytes }),
  closeSession: (sessionId: string) => invoke<void>("close_session", { sessionId }),
  cachedCapabilities: (connectionId: string) =>
    invoke<HostCapabilities | null>("get_cached_capabilities", { connectionId }),
  refreshCapabilities: (connectionId: string) =>
    invokeRemoteInspection<HostCapabilities>("refresh_capabilities", { connectionId }),
  listServices: (connectionId: string) =>
    invokeRemoteInspection<SystemdUnit[]>("list_services", { connectionId }),
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
    invoke<{ streamId: string }>("start_journal_stream", {
      connectionId,
      service,
      lines,
      follow,
      sudoPassword,
      output,
    }),
  startDockerLogStream: (
    connectionId: string,
    container: string,
    lines: number,
    follow: boolean,
    sudoPassword: string | null,
    output: Channel<ArrayBuffer>,
  ) =>
    invoke<{ streamId: string }>("start_docker_log_stream", {
      connectionId,
      container,
      lines,
      follow,
      sudoPassword,
      output,
    }),
  stopLogStream: (streamId: string) => invoke<void>("stop_log_stream", { streamId }),
  captureHostBaseline: (request: BaselineCaptureRequest, progress: Channel<BaselineProgress>) =>
    invoke<HostBaselineSummary>("capture_host_baseline", { request, progress }),
  cancelHostBaseline: (captureId: string) => invoke<void>("cancel_host_baseline", { captureId }),
  listHostBaselines: (connectionId: string) =>
    invoke<HostBaselineSummary[]>("list_host_baselines", { connectionId }),
  getHostBaseline: (id: string) => invoke<HostBaseline>("get_host_baseline", { id }),
  renameHostBaseline: (id: string, label: string | null) =>
    invoke<HostBaselineSummary>("rename_host_baseline", { id, label }),
  setHostBaselinePinned: (id: string, pinned: boolean) =>
    invoke<HostBaselineSummary>("set_host_baseline_pinned", { id, pinned }),
  deleteHostBaseline: (id: string) => invoke<void>("delete_host_baseline", { id }),
  traceHostBaselineEntry: (connectionId: string, kind: BaselineSectionKind, identity: string) =>
    invoke<BaselineTrace>("trace_host_baseline_entry", { connectionId, kind, identity }),
  exportTextFile: (path: string, contents: string) =>
    invoke<void>("export_text_file", { path, contents }),
  compareHostBaselines: (baseId: string, targetId: string) =>
    invoke<BaselineComparison>("compare_host_baselines", { baseId, targetId }),
  compareHostBaselineWithLive: (
    baseId: string,
    captureId: string,
    progress: Channel<BaselineProgress>,
  ) =>
    invoke<BaselineComparison>("compare_host_baseline_with_live", {
      baseId,
      captureId,
      progress,
    }),
  history: (connectionId: string, search = "", limit = 500) =>
    invoke<HistoryEntry[]>("get_history", { connectionId, search, limit }),
  addHistory: (input: HistoryInput) => invoke<HistoryEntry>("add_history_entry", { input }),
  deleteHistory: (id: string) => invoke<void>("delete_history_entry", { id }),
  clearHistory: (connectionId: string) => invoke<void>("clear_history", { connectionId }),
  setConnectionHistoryEnabled: (connectionId: string, enabled: boolean) =>
    invoke<SavedConnection>("set_connection_history_enabled", { connectionId, enabled }),
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
    invoke<boolean>("get_history_integration_status", { connectionId }),
  installHistoryIntegration: (connectionId: string) =>
    invoke<SavedConnection>("install_history_integration", { connectionId }),
  uninstallHistoryIntegration: (connectionId: string) =>
    invoke<SavedConnection>("uninstall_history_integration", { connectionId }),
};

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred";
}
