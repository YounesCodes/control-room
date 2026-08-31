use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub id: String,
    pub display_name: String,
    pub destination: String,
    pub username: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub history_enabled: bool,
    pub created_at: String,
    pub updated_at: String,
    pub last_connected_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnectionInput {
    pub display_name: String,
    pub destination: String,
    pub username: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    #[serde(default)]
    pub history_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct HostCapabilities {
    pub connection_id: String,
    pub hostname: Option<String>,
    pub os_id: Option<String>,
    pub os_name: Option<String>,
    pub os_version: Option<String>,
    pub kernel: Option<String>,
    pub architecture: Option<String>,
    pub uptime: Option<String>,
    pub default_shell: Option<String>,
    pub systemd_available: bool,
    pub journald_available: bool,
    pub docker_available: bool,
    pub docker_accessible: bool,
    pub docker_version: Option<String>,
    pub running_service_count: Option<u32>,
    pub running_container_count: Option<u32>,
    pub total_container_count: Option<u32>,
    pub detected_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemdUnit {
    pub id: String,
    pub unit_type: String,
    pub description: String,
    pub load_state: String,
    pub active_state: String,
    pub sub_state: String,
    pub unit_file_state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub ports: String,
    pub created_at: String,
    pub compose_project: Option<String>,
    pub compose_service: Option<String>,
    pub compose_container_number: Option<u32>,
    pub compose_oneoff: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListeningSocket {
    pub id: String,
    pub protocol: String,
    pub address_family: String,
    pub local_address: String,
    pub port: u16,
    pub process_name: Option<String>,
    pub process_id: Option<u32>,
    pub systemd_unit: Option<String>,
    pub ownership: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub connection_id: String,
    pub session_id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub exit_code: Option<i32>,
    pub shell: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryInput {
    pub connection_id: String,
    pub session_id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub exit_code: Option<i32>,
    #[serde(default = "default_shell")]
    pub shell: String,
}

fn default_shell() -> String {
    "bash".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub terminal_font_family: String,
    pub terminal_font_size: u16,
    pub terminal_scrollback: u32,
    pub terminal_foreground: String,
    pub terminal_red: String,
    pub terminal_green: String,
    pub terminal_yellow: String,
    pub terminal_blue: String,
    pub terminal_magenta: String,
    pub terminal_cyan: String,
    pub default_log_tail: u16,
    pub global_history_enabled: bool,
}

pub const LOG_TAIL_OPTIONS: [u16; 5] = [50, 100, 200, 500, 1000];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsContract {
    pub current: AppSettings,
    pub defaults: AppSettings,
    pub log_tail_options: Vec<u16>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            terminal_font_family: "Cascadia Mono, Consolas, monospace".into(),
            terminal_font_size: 14,
            terminal_scrollback: 10_000,
            terminal_foreground: "#f2f2ee".into(),
            terminal_red: "#ff6f7d".into(),
            terminal_green: "#52cf91".into(),
            terminal_yellow: "#e8c56c".into(),
            terminal_blue: "#55aef2".into(),
            terminal_magenta: "#c793ff".into(),
            terminal_cyan: "#65d4d1".into(),
            default_log_tail: 200,
            global_history_enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStarted {
    pub session_id: String,
    pub connection_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStateEvent {
    pub session_id: String,
    pub state: String,
    pub category: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStarted {
    pub stream_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStateEvent {
    pub stream_id: String,
    pub state: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentInfo {
    pub ssh_path: Option<String>,
    pub ssh_config_path: String,
    pub ssh_agent_available: bool,
    pub platform_supported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct PersistedWorkspaceState {
    pub workspaces: Vec<PersistedWorkspace>,
    pub active_workspace_id: Option<String>,
    pub terminal_layout: Option<PersistedTerminalLayout>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedWorkspace {
    pub id: String,
    pub label: Option<String>,
    pub connection_id: String,
    pub view: String,
    pub history_paused: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PersistedTerminalLayout {
    Leaf {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
    },
    Split {
        direction: String,
        first: Box<PersistedTerminalLayout>,
        second: Box<PersistedTerminalLayout>,
    },
}
