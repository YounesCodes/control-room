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
    /// Whether Structured Operations on this host may run under sudo. The
    /// global setting turns this on for every connection; this flag turns it on
    /// for one. Neither stores a password.
    pub sudo_enabled: bool,
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
    pub sudo_enabled: bool,
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
    /// True when the daemon answered under sudo after refusing the connecting
    /// account. Kept separate from `docker_accessible` so the Overview can say
    /// which of the two happened instead of collapsing them into "no".
    pub docker_accessible_with_sudo: bool,
    /// True when this account can run sudo without being asked for a password.
    /// This is a fact about the host, not a permission: allowing sudo is a
    /// separate choice the user makes per connection or in Settings.
    pub passwordless_sudo: bool,
    pub docker_version: Option<String>,
    pub running_service_count: Option<u32>,
    pub running_container_count: Option<u32>,
    pub total_container_count: Option<u32>,
    pub detected_at: String,
}

/// One bounded sample of how loaded a Remote Host is at a moment in time.
///
/// This is deliberately a sample rather than a stream. Each field is `Option`
/// because a host may expose part of `/proc` and not the rest, and a missing
/// reading is reported as missing rather than as zero, which would read as an
/// idle host. Samples are never persisted: the pane holds a short window of
/// them in memory while it is open and drops them when it closes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostResources {
    pub sampled_at: String,
    /// Busy share of all cores across the sampling window, 0 to 100. `None`
    /// when `/proc/stat` did not return two comparable readings.
    pub cpu_percent: Option<f64>,
    pub core_count: Option<u32>,
    pub load1: Option<f64>,
    pub load5: Option<f64>,
    pub load15: Option<f64>,
    pub memory_total_kib: Option<u64>,
    /// What the kernel reports as available, not `free`. Used memory is total
    /// minus this, so cache and reclaimable slab are not counted as in use.
    pub memory_available_kib: Option<u64>,
    pub swap_total_kib: Option<u64>,
    pub swap_free_kib: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BootDiagnostics {
    pub id: String,
    pub collected_at: String,
    pub selected_boot_id: Option<String>,
    pub boots: BootSection<Vec<BootRecord>>,
    pub timing: BootSection<BootTiming>,
    pub slow_units: BootSection<Vec<SlowBootUnit>>,
    pub failed_units: BootSection<Vec<SystemdUnit>>,
    pub journal: BootSection<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BootSection<T> {
    pub collected_at: String,
    pub data: Option<T>,
    pub error: Option<String>,
    pub permission_required: bool,
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
pub struct BootRecord {
    pub index: i32,
    pub id: String,
    pub range: String,
    pub current: bool,
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
pub struct BootTiming {
    pub total: Option<String>,
    pub kernel: Option<String>,
    pub userspace: Option<String>,
    pub original: String,
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

/// One mounted filesystem from a bounded `df` baseline. Device paths are not
/// collected: the mount point, type, size, and use are enough to compare.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Filesystem {
    pub mount_point: String,
    pub filesystem_type: String,
    pub size_kib: u64,
    pub used_percent: u8,
}

/// Version of the normalized host state written into stored baselines. Bump it
/// whenever a section's identity or fact names change, so an older baseline is
/// reported as incomparable instead of silently mis-diffed.
pub const BASELINE_SCHEMA_VERSION: u32 = 1;

/// Stable evidence about which Remote Host a baseline came from. The machine
/// fingerprint is a truncated SHA-256 computed on the host, so the raw
/// `/etc/machine-id` never leaves it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct HostIdentity {
    pub hostname: Option<String>,
    pub machine_fingerprint: Option<String>,
    pub os_id: Option<String>,
    pub os_version: Option<String>,
    pub kernel: Option<String>,
    pub architecture: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BaselineFact {
    pub name: String,
    pub value: String,
}

/// One comparable object inside a section, keyed by a domain-aware identity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BaselineEntry {
    pub identity: String,
    pub label: String,
    pub facts: Vec<BaselineFact>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BaselineSection {
    /// `host`, `systemdUnits`, `containers`, `listeners`, or `filesystems`.
    pub kind: String,
    /// `collected`, `partial`, `unsupported`, `unavailable`, or `skipped`.
    /// These are distinct: an absent subsystem is not the same as one this
    /// account cannot read, and neither is one the user did not ask for.
    pub status: String,
    /// Version of this section's fact shape. Each section carries its own, so
    /// changing what one section records never makes the others incomparable.
    #[serde(default = "first_schema_version")]
    pub schema_version: u32,
    pub collected_at: String,
    pub message: Option<String>,
    pub entries: Vec<BaselineEntry>,
}

fn first_schema_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostBaseline {
    pub id: String,
    pub connection_id: String,
    pub label: Option<String>,
    pub schema_version: u32,
    pub captured_at: String,
    /// A pinned capture is kept past the per-connection retention limit, so a
    /// baseline the user named on purpose is never evicted by newer captures.
    #[serde(default)]
    pub pinned: bool,
    pub identity: HostIdentity,
    pub sections: Vec<BaselineSection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BaselineSectionSummary {
    pub kind: String,
    pub status: String,
    pub entry_count: u32,
}

/// One capture's value for a single tracked entry, for reading a unit, port, or
/// mount across the whole stored history instead of two captures at a time.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BaselineTracePoint {
    pub baseline_id: String,
    pub label: Option<String>,
    pub captured_at: String,
    /// The status of the section this entry belongs to in that capture.
    pub section_status: String,
    /// False when the capture read the section but the entry was not in it.
    pub present: bool,
    pub facts: Vec<BaselineFact>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BaselineTrace {
    pub kind: String,
    pub identity: String,
    pub label: String,
    pub points: Vec<BaselineTracePoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostBaselineSummary {
    pub id: String,
    pub connection_id: String,
    pub label: Option<String>,
    pub schema_version: u32,
    pub captured_at: String,
    pub pinned: bool,
    pub identity: HostIdentity,
    pub sections: Vec<BaselineSectionSummary>,
    /// Entries that differ from the next older capture of the same connection.
    /// None when there is no older capture, or when nothing could be compared.
    pub changes_since_previous: Option<u32>,
}

/// What the user asked one capture to do. Sections is None for every section,
/// or an explicit list when the user narrowed the capture.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaselineCaptureRequest {
    pub connection_id: String,
    pub capture_id: String,
    pub label: Option<String>,
    pub sections: Option<Vec<String>>,
}

/// Emitted once per section while a capture runs. Capture is always explicit.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaselineProgress {
    pub capture_id: String,
    pub kind: String,
    pub status: String,
    pub message: Option<String>,
    pub completed: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BaselineFactChange {
    pub name: String,
    pub base_value: Option<String>,
    pub target_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BaselineEntryChange {
    pub identity: String,
    pub label: String,
    pub changes: Vec<BaselineFactChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BaselineSectionDiff {
    pub kind: String,
    pub base_status: String,
    pub target_status: String,
    /// False when either side was unsupported, unavailable, or written by an
    /// incompatible schema. Such a section is never reported as unchanged.
    pub comparable: bool,
    pub note: Option<String>,
    pub added: Vec<BaselineEntry>,
    pub removed: Vec<BaselineEntry>,
    pub changed: Vec<BaselineEntryChange>,
    pub unchanged_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BaselineComparison {
    pub base: HostBaselineSummary,
    pub target: HostBaselineSummary,
    /// `same`, `different`, or `unknown`, from machine fingerprint evidence.
    pub identity_match: String,
    pub schema_compatible: bool,
    /// True when the target side was read from the host for this comparison and
    /// never saved, so the UI can name it as live rather than as a capture.
    pub target_is_live: bool,
    pub sections: Vec<BaselineSectionDiff>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SlowBootUnit {
    pub unit: String,
    pub duration: String,
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
    /// Pastes the clipboard on a right click in the terminal. Off by default,
    /// because a right click otherwise belongs to the webview menu.
    pub terminal_right_click_paste: bool,
    pub terminal_foreground: String,
    pub terminal_red: String,
    pub terminal_green: String,
    pub terminal_yellow: String,
    pub terminal_blue: String,
    pub terminal_magenta: String,
    pub terminal_cyan: String,
    pub default_log_tail: u16,
    pub global_history_enabled: bool,
    /// Allows sudo for Structured Operations on every Saved Connection. While
    /// this is on, the per-connection flag has nothing left to decide.
    pub global_sudo_enabled: bool,
    /// Checks GitHub Releases for a newer Control Room shortly after start and
    /// twice a day after that. This updates Control Room itself and has nothing
    /// to do with packages on a Remote Host, which Control Room never touches.
    /// Turning it off leaves the manual check in Settings working.
    pub automatic_update_checks: bool,
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
            terminal_right_click_paste: false,
            terminal_foreground: "#f2f2ee".into(),
            terminal_red: "#ff6f7d".into(),
            terminal_green: "#52cf91".into(),
            terminal_yellow: "#e8c56c".into(),
            terminal_blue: "#55aef2".into(),
            terminal_magenta: "#c793ff".into(),
            terminal_cyan: "#65d4d1".into(),
            default_log_tail: 200,
            global_history_enabled: true,
            global_sudo_enabled: false,
            automatic_update_checks: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStarted {
    pub session_id: String,
    pub connection_id: String,
}

/// One local Windows shell Control Room is allowed to run. The frontend names a
/// profile by `id` and never by executable path, so `LocalShellKind` is the
/// whole vocabulary of what may be started locally.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LocalShellKind {
    #[serde(rename = "powershell-7")]
    PowerShell7,
    #[serde(rename = "windows-powershell")]
    WindowsPowerShell,
    #[serde(rename = "command-prompt")]
    CommandPrompt,
    #[serde(rename = "git-bash")]
    GitBash,
}

impl LocalShellKind {
    pub const ALL: [LocalShellKind; 4] = [
        LocalShellKind::PowerShell7,
        LocalShellKind::WindowsPowerShell,
        LocalShellKind::CommandPrompt,
        LocalShellKind::GitBash,
    ];

    pub fn id(self) -> &'static str {
        match self {
            LocalShellKind::PowerShell7 => "powershell-7",
            LocalShellKind::WindowsPowerShell => "windows-powershell",
            LocalShellKind::CommandPrompt => "command-prompt",
            LocalShellKind::GitBash => "git-bash",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            LocalShellKind::PowerShell7 => "PowerShell 7",
            LocalShellKind::WindowsPowerShell => "Windows PowerShell",
            LocalShellKind::CommandPrompt => "Command Prompt",
            LocalShellKind::GitBash => "Git Bash",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.id() == id)
    }
}

/// A detected local shell, as offered to the frontend. `id` is the only part the
/// frontend may send back.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalShellProfile {
    pub id: String,
    pub label: String,
    pub kind: LocalShellKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSessionStarted {
    pub session_id: String,
    pub shell_id: String,
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

/// A restored Workspace tab. Exactly one target is set: `connection_id` for a
/// remote Workspace, `local_shell_id` for a local one. Payloads written before
/// Local Terminal existed carry only `connection_id`, which still deserializes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedWorkspace {
    pub id: String,
    pub label: Option<String>,
    #[serde(default)]
    pub connection_id: Option<String>,
    #[serde(default)]
    pub local_shell_id: Option<String>,
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
