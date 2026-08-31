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
    pub group_id: Option<String>,
    pub tags: Vec<ConnectionTag>,
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
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub tag_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionGroup {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub collapsed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTag {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveSshField {
    pub value: String,
    pub origin: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveSshConfiguration {
    pub connection_id: String,
    pub ssh_version: Option<String>,
    pub exit_status: Option<i32>,
    pub diagnostic: Option<String>,
    pub hostname: Option<EffectiveSshField>,
    pub user: Option<EffectiveSshField>,
    pub port: Option<EffectiveSshField>,
    pub address_family: Option<EffectiveSshField>,
    pub identity_files: Vec<EffectiveSshField>,
    pub identities_only: Option<EffectiveSshField>,
    pub proxy_jump: Option<EffectiveSshField>,
    pub proxy_command_configured: bool,
    pub canonicalize_hostname: Option<EffectiveSshField>,
    pub server_alive_interval: Option<EffectiveSshField>,
    pub server_alive_count_max: Option<EffectiveSshField>,
    pub tcp_keep_alive: Option<EffectiveSshField>,
    pub connect_timeout: Option<EffectiveSshField>,
    pub parse_limitations: Vec<String>,
    pub collected_at: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainerDetails {
    pub id: String,
    pub name: String,
    pub image_reference: String,
    pub image_content_id: String,
    pub state: String,
    pub running: bool,
    pub paused: bool,
    pub restarting: bool,
    pub oom_killed: bool,
    pub dead: bool,
    pub exit_code: i32,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub health_status: Option<String>,
    pub failing_streak: Option<u32>,
    pub restart_policy: String,
    pub restart_maximum_retry_count: u32,
    pub published_ports: Vec<DockerPublishedPort>,
    pub networks: Vec<DockerNetworkAttachment>,
    pub mounts: Vec<DockerMount>,
    pub compose_project: Option<String>,
    pub compose_service: Option<String>,
    pub compose_container_number: Option<u32>,
    pub compose_oneoff: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FirewallRule {
    pub to: String,
    pub action: String,
    pub from: String,
    pub port: Option<u16>,
    pub protocol: Option<String>,
    pub ipv6: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerPublishedPort {
    pub container_port: String,
    pub host_address: String,
    pub host_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FirewallStatus {
    /// Whether a supported firewall front-end (ufw) is installed.
    pub available: bool,
    /// `Some(true)` when the firewall reports itself active, `Some(false)` when
    /// inactive, `None` when availability could not be determined.
    pub active: Option<bool>,
    pub default_incoming: Option<String>,
    pub rules: Vec<FirewallRule>,
    pub collected_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerNetworkAttachment {
    pub name: String,
    pub ipv4_address: Option<String>,
    pub ipv4_gateway: Option<String>,
    pub ipv6_address: Option<String>,
    pub ipv6_gateway: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRemote {
    pub address: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSummary {
    pub key: String,
    pub protocol: String,
    pub local_port: u16,
    pub process_name: Option<String>,
    pub process_id: Option<u32>,
    pub systemd_unit: Option<String>,
    pub established: u32,
    pub remote_address_count: u32,
    /// A bounded sample of remote peers, most frequent first.
    pub remotes: Vec<ConnectionRemote>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EstablishedConnections {
    pub groups: Vec<ConnectionSummary>,
    pub total_established: u32,
    /// True when the bounded collection stopped before reading every row.
    pub truncated: bool,
    pub collected_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerMount {
    pub mount_type: String,
    pub name: Option<String>,
    pub destination: String,
    pub writable: bool,
    pub propagation: Option<String>,
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
#[serde(rename_all = "camelCase")]
pub struct ScratchpadNote {
    pub id: String,
    pub scope: String,
    pub owner_id: String,
    pub connection_id: Option<String>,
    pub text: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScratchpadNoteInput {
    pub scope: String,
    pub owner_id: String,
    pub connection_id: Option<String>,
    pub text: String,
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
