import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  DockerContainer,
  EnvironmentInfo,
  HistoryEntry,
  HistoryInput,
  HostCapabilities,
  SavedConnection,
  SavedConnectionInput,
  SystemdService,
} from "../types";

export const api = {
  environment: () => invoke<EnvironmentInfo>("get_environment_info"),
  listConnections: () => invoke<SavedConnection[]>("list_connections"),
  createConnection: (input: SavedConnectionInput) =>
    invoke<SavedConnection>("create_connection", { input }),
  updateConnection: (id: string, input: SavedConnectionInput) =>
    invoke<SavedConnection>("update_connection", { id, input }),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),
  startSession: (
    connection: SavedConnection,
    cols: number,
    rows: number,
    output: Channel<ArrayBuffer>,
  ) =>
    invoke<{ sessionId: string; connectionId: string }>("start_session", {
      connection,
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
    invoke<HostCapabilities>("refresh_capabilities", { connectionId }),
  listServices: (connectionId: string) =>
    invoke<SystemdService[]>("list_services", { connectionId }),
  getService: (connectionId: string, serviceName: string) =>
    invoke<SystemdService>("get_service", { connectionId, serviceName }),
  listContainers: (connectionId: string, sudoPassword: string | null = null) =>
    invoke<DockerContainer[]>("list_containers", { connectionId, sudoPassword }),
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
  history: (connectionId: string, search = "", limit = 500) =>
    invoke<HistoryEntry[]>("get_history", { connectionId, search, limit }),
  addHistory: (input: HistoryInput) => invoke<HistoryEntry>("add_history_entry", { input }),
  deleteHistory: (id: string) => invoke<void>("delete_history_entry", { id }),
  clearHistory: (connectionId: string) => invoke<void>("clear_history", { connectionId }),
  setConnectionHistoryEnabled: (connectionId: string, enabled: boolean) =>
    invoke<SavedConnection>("set_connection_history_enabled", { connectionId, enabled }),
  settings: () => invoke<AppSettings>("get_settings"),
  saveSettings: (settings: AppSettings) => invoke<void>("save_settings", { settings }),
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
