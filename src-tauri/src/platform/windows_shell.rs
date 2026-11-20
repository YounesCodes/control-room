use super::*;
use crate::models::{
    AdministratorTerminalStatus, LocalShellCatalog, LocalShellProfile,
    is_offered_wsl_distribution_name, wsl_distribution_from_profile_id, wsl_profile_id,
    wsl_profile_label,
};
use std::{
    env,
    path::{Path, PathBuf},
};
/// The Windows locations discovery is allowed to look at, captured once so
/// detection can be tested without depending on what the machine has installed.
#[derive(Debug, Clone, Default)]
pub struct ShellEnvironment {
    pub system_root: Option<PathBuf>,
    pub program_files: Vec<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    pub path_entries: Vec<PathBuf>,
    pub user_profile: Option<PathBuf>,
    pub wsl_distributions: Vec<String>,
}

/// One distribution under the current user's Lxss registry key. Reading the
/// registry, as Windows Terminal does, lists distributions without starting WSL.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WslRegistration {
    pub key: String,
    pub name: String,
    pub state: Option<u32>,
}

const WSL_INSTALLED_STATE: u32 = 1;
const WSL_TOOLING_DISTRIBUTION_PREFIXES: [&str; 2] = ["docker-desktop", "rancher-desktop"];

/// The distributions offered as local shells: installed, with a name a profile
/// id can carry, without container tooling distributions, default first.
pub fn offered_wsl_distributions(
    registrations: Vec<WslRegistration>,
    default_key: Option<&str>,
) -> Vec<String> {
    let mut offered = Vec::<(bool, String)>::new();
    for registration in registrations {
        let lowercase = registration.name.to_ascii_lowercase();
        if registration
            .state
            .is_some_and(|state| state != WSL_INSTALLED_STATE)
            || !is_offered_wsl_distribution_name(&registration.name)
            || WSL_TOOLING_DISTRIBUTION_PREFIXES
                .iter()
                .any(|prefix| lowercase.starts_with(prefix))
            || offered
                .iter()
                .any(|(_, name)| name.eq_ignore_ascii_case(&registration.name))
        {
            continue;
        }
        let is_default = default_key.is_some_and(|key| key.eq_ignore_ascii_case(&registration.key));
        offered.push((is_default, registration.name));
    }
    offered.sort_by_key(|(is_default, _)| !is_default);
    offered.into_iter().map(|(_, name)| name).collect()
}

impl ShellEnvironment {
    pub fn from_process_env() -> Self {
        let mut program_files = Vec::new();
        for variable in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Some(value) = env::var_os(variable).map(PathBuf::from)
                && !program_files.contains(&value)
            {
                program_files.push(value);
            }
        }
        Self {
            system_root: env::var_os("SystemRoot").map(PathBuf::from),
            program_files,
            local_app_data: env::var_os("LOCALAPPDATA").map(PathBuf::from),
            path_entries: env::var_os("PATH")
                .map(|paths| env::split_paths(&paths).collect())
                .unwrap_or_default(),
            user_profile: env::var_os("USERPROFILE").map(PathBuf::from),
            wsl_distributions: {
                let (registrations, default_key) = read_wsl_registrations();
                offered_wsl_distributions(registrations, default_key.as_deref())
            },
        }
    }
}

fn fixed_arguments(kind: LocalShellKind) -> &'static [&'static str] {
    match kind {
        LocalShellKind::PowerShell7 | LocalShellKind::WindowsPowerShell => &["-NoLogo"],
        LocalShellKind::CommandPrompt | LocalShellKind::Wsl => &[],
        LocalShellKind::GitBash => &["--login", "-i"],
        LocalShellKind::Zsh
        | LocalShellKind::Bash
        | LocalShellKind::Fish
        | LocalShellKind::Sh
        | LocalShellKind::LoginShell => &[],
    }
}

// The PowerShells and cmd use the Windows console API, not TERM.
fn terminal_type(kind: LocalShellKind) -> Option<&'static str> {
    match kind {
        LocalShellKind::GitBash => Some("xterm-256color"),
        _ => None,
    }
}

pub(super) fn configure_terminal_environment(command: &mut CommandBuilder, kind: LocalShellKind) {
    if let Some(terminal) = terminal_type(kind) {
        command.env("TERM", terminal);
    }
    // OpenTUI's alternate-screen cleanup can close the ConPTY pipes when OpenCode exits.
    if kind == LocalShellKind::GitBash && command.get_env("OTUI_USE_ALTERNATE_SCREEN").is_none() {
        command.env("OTUI_USE_ALTERNATE_SCREEN", "0");
    }
}

fn candidate_programs(kind: LocalShellKind, environment: &ShellEnvironment) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    match kind {
        LocalShellKind::PowerShell7 => {
            for entry in &environment.path_entries {
                candidates.push(entry.join("pwsh.exe"));
            }
            for root in &environment.program_files {
                candidates.push(root.join("PowerShell").join("7").join("pwsh.exe"));
            }
            if let Some(local) = &environment.local_app_data {
                candidates.push(local.join("Microsoft").join("WindowsApps").join("pwsh.exe"));
            }
        }
        // PATH can hold a powershell.exe shim.
        LocalShellKind::WindowsPowerShell => {
            if let Some(system_root) = &environment.system_root {
                candidates.push(
                    system_root
                        .join("System32")
                        .join("WindowsPowerShell")
                        .join("v1.0")
                        .join("powershell.exe"),
                );
            }
        }
        LocalShellKind::CommandPrompt => {
            if let Some(system_root) = &environment.system_root {
                candidates.push(system_root.join("System32").join("cmd.exe"));
            }
        }
        LocalShellKind::GitBash => {
            for root in &environment.program_files {
                candidates.push(root.join("Git").join("bin").join("bash.exe"));
            }
            if let Some(local) = &environment.local_app_data {
                candidates.push(
                    local
                        .join("Programs")
                        .join("Git")
                        .join("bin")
                        .join("bash.exe"),
                );
            }
            // System32\bash.exe is the WSL launcher.
            for entry in &environment.path_entries {
                if !entry.to_string_lossy().to_lowercase().contains("git") {
                    continue;
                }
                candidates.push(entry.join("bash.exe"));
                if let Some(parent) = entry.parent() {
                    candidates.push(parent.join("bin").join("bash.exe"));
                }
            }
        }
        LocalShellKind::Wsl => {
            if let Some(system_root) = &environment.system_root {
                candidates.push(system_root.join("System32").join("wsl.exe"));
            }
        }
        LocalShellKind::Zsh
        | LocalShellKind::Bash
        | LocalShellKind::Fish
        | LocalShellKind::Sh
        | LocalShellKind::LoginShell => {}
    }
    candidates
}

/// Resolves one profile to the first candidate that exists, or `None` when the
/// shell is not installed.
pub fn resolve(
    kind: LocalShellKind,
    environment: &ShellEnvironment,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<ResolvedLocalShell> {
    let program = candidate_programs(kind, environment)
        .into_iter()
        .find(|candidate| exists(candidate))?;
    Some(ResolvedLocalShell {
        kind,
        program,
        arguments: fixed_arguments(kind),
        working_directory: environment
            .user_profile
            .as_ref()
            .filter(|profile| exists(profile) || profile.is_dir())
            .cloned(),
        administrator_launcher: None,
        wsl_distribution: None,
    })
}

/// Resolves a WSL profile only for a distribution that is installed right now.
pub fn resolve_wsl(
    distribution: &str,
    environment: &ShellEnvironment,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<ResolvedLocalShell> {
    let installed = environment
        .wsl_distributions
        .iter()
        .find(|name| name.eq_ignore_ascii_case(distribution))?;
    let mut shell = resolve(LocalShellKind::Wsl, environment, exists)?;
    shell.wsl_distribution = Some(installed.clone());
    Some(shell)
}

/// The profiles that are actually available. An uninstalled shell is left out
/// rather than offered and then failing on launch.
pub fn discover(
    environment: &ShellEnvironment,
    exists: &dyn Fn(&Path) -> bool,
) -> Vec<LocalShellProfile> {
    let mut profiles = LocalShellKind::ALL
        .iter()
        .filter(|kind| resolve(**kind, environment, exists).is_some())
        .map(|kind| LocalShellProfile {
            id: kind.id().into(),
            label: kind.label().into(),
            kind: *kind,
            elevated: false,
        })
        .collect::<Vec<_>>();
    if resolve(LocalShellKind::Wsl, environment, exists).is_some() {
        profiles.extend(environment.wsl_distributions.iter().map(|distribution| {
            LocalShellProfile {
                id: wsl_profile_id(distribution),
                label: wsl_profile_label(distribution),
                kind: LocalShellKind::Wsl,
                elevated: false,
            }
        }));
    }
    profiles
}

pub fn installed_shells() -> LocalShellCatalog {
    let environment = ShellEnvironment::from_process_env();
    let exists = |path: &Path| path.is_file();
    let status = administrator_terminal_status(&environment, &exists);
    catalog(&environment, &exists, status)
}

pub fn catalog(
    environment: &ShellEnvironment,
    exists: &dyn Fn(&Path) -> bool,
    administrator_status: AdministratorTerminalStatus,
) -> LocalShellCatalog {
    let mut profiles = discover(environment, exists);
    if administrator_status == AdministratorTerminalStatus::Available {
        let elevated = profiles
            .iter()
            .filter_map(|profile| {
                profile.kind.administrator_id().map(|id| LocalShellProfile {
                    id: id.into(),
                    label: profile.label.clone(),
                    kind: profile.kind,
                    elevated: true,
                })
            })
            .collect::<Vec<_>>();
        profiles.extend(elevated);
    }
    LocalShellCatalog {
        profiles,
        administrator_status,
    }
}

/// Validates a Local Shell Profile id from the frontend and resolves it against
/// the machine as it is right now. An unknown id and a shell that disappeared
/// after discovery are both refused here.
pub fn resolve_installed(shell_id: &str) -> Result<ResolvedLocalShell, String> {
    let (kind, elevated) =
        LocalShellKind::from_profile_id(shell_id).ok_or("Unknown local shell")?;
    let environment = ShellEnvironment::from_process_env();
    let exists = |path: &Path| path.is_file();
    if let Some(distribution) = wsl_distribution_from_profile_id(shell_id) {
        return resolve_wsl(distribution, &environment, &exists).ok_or_else(|| {
            format!(
                "{} is no longer available.",
                wsl_profile_label(distribution)
            )
        });
    }
    let mut shell = resolve(kind, &environment, &exists)
        .ok_or_else(|| format!("{} is no longer available.", kind.label()))?;
    if elevated {
        if administrator_terminal_status(&environment, &exists)
            != AdministratorTerminalStatus::Available
        {
            return Err(
                "Administrator terminals require Sudo for Windows in inline mode. Enable it in Windows Settings, then reopen the Local terminal menu."
                    .into(),
            );
        }
        shell.administrator_launcher = environment
            .system_root
            .as_ref()
            .map(|root| root.join("System32").join("sudo.exe"));
    }
    Ok(shell)
}

fn effective_sudo_mode(user_mode: Option<u32>, policy_mode: Option<u32>) -> Option<u32> {
    match (user_mode, policy_mode) {
        (Some(user), Some(policy)) => Some(user.min(policy)),
        (user, None) => user,
        (None, _) => None,
    }
}

fn administrator_terminal_status(
    environment: &ShellEnvironment,
    exists: &dyn Fn(&Path) -> bool,
) -> AdministratorTerminalStatus {
    let Some(system_root) = &environment.system_root else {
        return AdministratorTerminalStatus::UnsupportedWindows;
    };
    if !exists(&system_root.join("System32").join("sudo.exe")) {
        return AdministratorTerminalStatus::UnsupportedWindows;
    }
    match effective_sudo_mode(read_sudo_mode(false), read_sudo_mode(true)) {
        Some(3) => AdministratorTerminalStatus::Available,
        Some(1 | 2) => AdministratorTerminalStatus::UnsupportedMode,
        _ => AdministratorTerminalStatus::Disabled,
    }
}

#[cfg(windows)]
fn read_sudo_mode(policy: bool) -> Option<u32> {
    use std::{ffi::c_void, ptr};
    use windows_sys::Win32::System::Registry::{
        HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RegGetValueW,
    };

    let key = if policy {
        "SOFTWARE\\Policies\\Microsoft\\Windows\\Sudo\0"
    } else {
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Sudo\0"
    };
    let key = key.encode_utf16().collect::<Vec<_>>();
    let value = "Enabled\0".encode_utf16().collect::<Vec<_>>();
    let mut mode = 0_u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let result = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            ptr::null_mut(),
            (&mut mode as *mut u32).cast::<c_void>(),
            &mut size,
        )
    };
    (result == 0 && size == std::mem::size_of::<u32>() as u32).then_some(mode)
}

#[cfg(not(windows))]
fn read_sudo_mode(_policy: bool) -> Option<u32> {
    None
}

#[cfg(windows)]
fn read_wsl_registrations() -> (Vec<WslRegistration>, Option<String>) {
    use std::ptr;
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_READ, RegCloseKey, RegEnumKeyExW, RegOpenKeyExW,
    };

    let path = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Lxss");
    let mut lxss: HKEY = ptr::null_mut();
    if unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, KEY_READ, &mut lxss) } != 0 {
        return (Vec::new(), None);
    }
    let default_key = read_registry_string(lxss, None, "DefaultDistribution");
    let mut registrations = Vec::new();
    for index in 0.. {
        let mut name = [0_u16; 256];
        let mut length = name.len() as u32;
        let result = unsafe {
            RegEnumKeyExW(
                lxss,
                index,
                name.as_mut_ptr(),
                &mut length,
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        if result != 0 {
            break;
        }
        let key = String::from_utf16_lossy(&name[..length as usize]);
        let Some(distribution) = read_registry_string(lxss, Some(&key), "DistributionName") else {
            continue;
        };
        registrations.push(WslRegistration {
            state: read_registry_dword(lxss, Some(&key), "State"),
            key,
            name: distribution,
        });
    }
    unsafe { RegCloseKey(lxss) };
    (registrations, default_key)
}

#[cfg(not(windows))]
fn read_wsl_registrations() -> (Vec<WslRegistration>, Option<String>) {
    (Vec::new(), None)
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn read_registry_string(
    key: windows_sys::Win32::System::Registry::HKEY,
    subkey: Option<&str>,
    value: &str,
) -> Option<String> {
    use std::{ffi::c_void, ptr};
    use windows_sys::Win32::System::Registry::{RRF_RT_REG_SZ, RegGetValueW};

    let subkey = subkey.map(wide);
    let subkey = subkey
        .as_ref()
        .map_or(ptr::null(), |subkey| subkey.as_ptr());
    let value = wide(value);
    let mut buffer = [0_u16; 512];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    let result = unsafe {
        RegGetValueW(
            key,
            subkey,
            value.as_ptr(),
            RRF_RT_REG_SZ,
            ptr::null_mut(),
            buffer.as_mut_ptr().cast::<c_void>(),
            &mut size,
        )
    };
    if result != 0 {
        return None;
    }
    let text = &buffer[..(size as usize / 2).min(buffer.len())];
    let end = text
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(text.len());
    Some(String::from_utf16_lossy(&text[..end]))
}

#[cfg(windows)]
fn read_registry_dword(
    key: windows_sys::Win32::System::Registry::HKEY,
    subkey: Option<&str>,
    value: &str,
) -> Option<u32> {
    use std::{ffi::c_void, ptr};
    use windows_sys::Win32::System::Registry::{RRF_RT_REG_DWORD, RegGetValueW};

    let subkey = subkey.map(wide);
    let subkey = subkey
        .as_ref()
        .map_or(ptr::null(), |subkey| subkey.as_ptr());
    let value = wide(value);
    let mut data = 0_u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let result = unsafe {
        RegGetValueW(
            key,
            subkey,
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            ptr::null_mut(),
            (&mut data as *mut u32).cast::<c_void>(),
            &mut size,
        )
    };
    (result == 0).then_some(data)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    fn environment() -> ShellEnvironment {
        ShellEnvironment {
            system_root: Some(PathBuf::from(r"C:\Windows")),
            program_files: vec![
                PathBuf::from(r"C:\Program Files"),
                PathBuf::from(r"C:\Program Files (x86)"),
            ],
            local_app_data: Some(PathBuf::from(r"C:\Users\dev\AppData\Local")),
            path_entries: vec![PathBuf::from(r"C:\Program Files\Git\cmd")],
            user_profile: Some(PathBuf::from(r"C:\Users\dev")),
            wsl_distributions: Vec::new(),
        }
    }

    fn registration(key: &str, name: &str, state: Option<u32>) -> WslRegistration {
        WslRegistration {
            key: key.into(),
            name: name.into(),
            state,
        }
    }

    fn with_distributions(names: &[&str]) -> ShellEnvironment {
        ShellEnvironment {
            wsl_distributions: names.iter().map(|name| name.to_string()).collect(),
            ..environment()
        }
    }

    #[test]
    fn installed_distributions_are_offered_with_the_default_first() {
        let offered = offered_wsl_distributions(
            vec![
                registration("{a}", "Debian", Some(1)),
                registration("{b}", "Ubuntu-24.04", Some(1)),
                registration("{c}", "Installing", Some(3)),
                registration("{d}", "docker-desktop", Some(1)),
                registration("{e}", "Docker-Desktop-Data", Some(1)),
                registration("{f}", "rancher-desktop", Some(1)),
                registration("{g}", "Has Space", Some(1)),
                registration("{h}", "debian", Some(1)),
                registration("{i}", "OracleLinux_9_1", None),
            ],
            Some("{B}"),
        );

        assert_eq!(offered, vec!["Ubuntu-24.04", "Debian", "OracleLinux_9_1"]);
    }

    #[test]
    fn each_installed_distribution_is_its_own_local_shell() {
        let exists = installed(&[
            r"C:\Windows\System32\cmd.exe",
            r"C:\Windows\System32\wsl.exe",
        ]);

        let discovered = discover(&with_distributions(&["Ubuntu", "Debian"]), &exists);

        assert_eq!(
            discovered
                .iter()
                .map(|profile| (profile.id.as_str(), profile.label.as_str(), profile.kind))
                .collect::<Vec<_>>(),
            vec![
                (
                    "command-prompt",
                    "Command Prompt",
                    LocalShellKind::CommandPrompt
                ),
                ("wsl:Ubuntu", "WSL: Ubuntu", LocalShellKind::Wsl),
                ("wsl:Debian", "WSL: Debian", LocalShellKind::Wsl),
            ]
        );
    }

    #[test]
    fn wsl_is_not_offered_without_a_distribution_or_its_launcher() {
        let launcher = installed(&[r"C:\Windows\System32\wsl.exe"]);
        let no_launcher = installed(&[]);

        assert!(discover(&with_distributions(&[]), &launcher).is_empty());
        assert!(discover(&with_distributions(&["Ubuntu"]), &no_launcher).is_empty());
        assert!(resolve_wsl("Ubuntu", &with_distributions(&["Ubuntu"]), &no_launcher).is_none());
    }

    #[test]
    fn a_wsl_shell_starts_its_distribution_in_the_linux_home() {
        let exists = installed(&[r"C:\Windows\System32\wsl.exe"]);

        let shell = resolve_wsl("ubuntu", &with_distributions(&["Ubuntu"]), &exists).unwrap();
        let argv = command_for(&shell)
            .get_argv()
            .iter()
            .map(|argument| argument.to_string_lossy().to_string())
            .collect::<Vec<_>>();

        assert_eq!(
            argv,
            vec![
                r"C:\Windows\System32\wsl.exe",
                "--distribution",
                "Ubuntu",
                "--cd",
                "~"
            ]
        );
        assert_eq!(shell.id(), "wsl:Ubuntu");
        assert_eq!(shell.label(), "WSL: Ubuntu");
        assert!(!shell.is_elevated());
    }

    #[test]
    fn a_distribution_that_is_not_installed_does_not_resolve() {
        let exists = installed(&[r"C:\Windows\System32\wsl.exe"]);

        assert!(resolve_wsl("Debian", &with_distributions(&["Ubuntu"]), &exists).is_none());
    }

    #[test]
    fn wsl_profile_ids_cannot_carry_arguments_or_paths() {
        assert_eq!(
            LocalShellKind::from_profile_id("wsl:Ubuntu-24.04"),
            Some((LocalShellKind::Wsl, false))
        );
        for id in [
            "wsl",
            "wsl:",
            "wsl:Ubuntu --exec calc.exe",
            "wsl:..\\..\\evil",
            "wsl:Ubuntu\"",
            "wsl:Ubuntu-administrator ",
            "wsl-administrator",
        ] {
            assert_eq!(LocalShellKind::from_profile_id(id), None, "{id}");
            assert!(resolve_installed(id).is_err(), "{id}");
        }
        assert_eq!(LocalShellKind::from_id("wsl"), None);
        assert_eq!(LocalShellKind::Wsl.administrator_id(), None);
    }

    fn installed(paths: &[&str]) -> impl Fn(&Path) -> bool + use<> {
        let present: HashSet<String> = paths
            .iter()
            .map(|path| path.to_lowercase())
            .chain(std::iter::once(r"c:\users\dev".to_string()))
            .collect();
        move |path: &Path| present.contains(&path.to_string_lossy().to_lowercase())
    }

    #[test]
    fn every_supported_shell_is_detected_at_its_standard_location() {
        let exists = installed(&[
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            r"C:\Windows\System32\cmd.exe",
            r"C:\Program Files\Git\bin\bash.exe",
        ]);

        let discovered = discover(&environment(), &exists);

        assert_eq!(
            discovered
                .iter()
                .map(|profile| (profile.id.as_str(), profile.label.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("powershell-7", "PowerShell 7"),
                ("windows-powershell", "Windows PowerShell"),
                ("command-prompt", "Command Prompt"),
                ("git-bash", "Git Bash"),
            ]
        );
    }

    #[test]
    fn shells_that_are_not_installed_are_not_offered() {
        let exists = installed(&[r"C:\Windows\System32\cmd.exe"]);

        let discovered = discover(&environment(), &exists);

        assert_eq!(
            discovered
                .iter()
                .map(|profile| profile.id.as_str())
                .collect::<Vec<_>>(),
            vec!["command-prompt"]
        );
        assert!(resolve(LocalShellKind::GitBash, &environment(), &exists).is_none());
        assert!(resolve(LocalShellKind::PowerShell7, &environment(), &exists).is_none());
    }

    #[test]
    fn administrator_profiles_are_separate_and_limited_to_requested_shells() {
        let exists = installed(&[
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            r"C:\Windows\System32\cmd.exe",
            r"C:\Program Files\Git\bin\bash.exe",
        ]);

        let available = catalog(
            &environment(),
            &exists,
            AdministratorTerminalStatus::Available,
        );
        let administrator_ids = available
            .profiles
            .iter()
            .filter(|profile| profile.elevated)
            .map(|profile| profile.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            administrator_ids,
            vec![
                "powershell-7-administrator",
                "windows-powershell-administrator",
                "command-prompt-administrator",
            ]
        );
        assert_eq!(
            available.administrator_status,
            AdministratorTerminalStatus::Available
        );

        let disabled = catalog(
            &environment(),
            &exists,
            AdministratorTerminalStatus::Disabled,
        );
        assert!(disabled.profiles.iter().all(|profile| !profile.elevated));
    }

    #[test]
    fn powershell_7_is_found_on_path_and_is_not_the_built_in_shell() {
        let mut environment = environment();
        environment
            .path_entries
            .push(PathBuf::from(r"C:\Users\dev\pwsh"));
        let exists = installed(&[
            r"C:\Users\dev\pwsh\pwsh.exe",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        ]);

        let seven = resolve(LocalShellKind::PowerShell7, &environment, &exists).unwrap();
        let built_in = resolve(LocalShellKind::WindowsPowerShell, &environment, &exists).unwrap();

        assert_eq!(seven.program, PathBuf::from(r"C:\Users\dev\pwsh\pwsh.exe"));
        assert_eq!(
            built_in.program,
            PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
        );
        assert_ne!(seven.program, built_in.program);
    }

    #[test]
    fn windows_powershell_is_not_taken_from_path() {
        let mut environment = environment();
        environment.path_entries.push(PathBuf::from(r"C:\shims"));
        let exists = installed(&[r"C:\shims\powershell.exe"]);

        assert!(resolve(LocalShellKind::WindowsPowerShell, &environment, &exists).is_none());
    }

    #[test]
    fn git_bash_runs_bash_rather_than_a_terminal_wrapper() {
        let exists = installed(&[
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files\Git\git-bash.exe",
            r"C:\Program Files\Git\usr\bin\mintty.exe",
        ]);

        let shell = resolve(LocalShellKind::GitBash, &environment(), &exists).unwrap();
        let command = command_for(&shell);
        let argv = command.get_argv().join(std::ffi::OsStr::new(" "));

        assert_eq!(
            shell.program,
            PathBuf::from(r"C:\Program Files\Git\bin\bash.exe")
        );
        let rendered = argv.to_string_lossy().to_lowercase();
        assert!(!rendered.contains("git-bash"));
        assert!(!rendered.contains("mintty"));
        assert!(!rendered.contains("wt.exe"));
    }

    #[test]
    fn git_bash_is_found_through_a_git_directory_on_path() {
        let exists = installed(&[r"C:\Program Files\Git\bin\bash.exe"]);
        let environment = ShellEnvironment {
            program_files: Vec::new(),
            path_entries: vec![PathBuf::from(r"C:\Program Files\Git\cmd")],
            ..environment()
        };

        let shell = resolve(LocalShellKind::GitBash, &environment, &exists).unwrap();

        assert_eq!(
            shell.program,
            PathBuf::from(r"C:\Program Files\Git\bin\bash.exe")
        );
    }

    #[test]
    fn bash_is_never_taken_from_the_wsl_launcher_on_path() {
        let exists = installed(&[r"C:\Windows\System32\bash.exe"]);
        let environment = ShellEnvironment {
            program_files: Vec::new(),
            path_entries: vec![PathBuf::from(r"C:\Windows\System32")],
            ..environment()
        };

        assert!(resolve(LocalShellKind::GitBash, &environment, &exists).is_none());
    }

    #[test]
    fn each_shell_carries_its_own_fixed_arguments() {
        let exists = installed(&[
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            r"C:\Windows\System32\cmd.exe",
            r"C:\Program Files\Git\bin\bash.exe",
        ]);
        let arguments = |kind| {
            let shell = resolve(kind, &environment(), &exists).unwrap();
            command_for(&shell)
                .get_argv()
                .iter()
                .skip(1)
                .map(|argument| argument.to_string_lossy().to_string())
                .collect::<Vec<_>>()
        };

        assert_eq!(arguments(LocalShellKind::PowerShell7), vec!["-NoLogo"]);
        assert_eq!(
            arguments(LocalShellKind::WindowsPowerShell),
            vec!["-NoLogo"]
        );
        assert!(arguments(LocalShellKind::CommandPrompt).is_empty());
        assert_eq!(arguments(LocalShellKind::GitBash), vec!["--login", "-i"]);
    }

    #[test]
    fn an_administrator_shell_uses_only_system_sudo_and_the_resolved_shell() {
        let exists = installed(&[r"C:\Windows\System32\cmd.exe"]);
        let mut shell = resolve(LocalShellKind::CommandPrompt, &environment(), &exists).unwrap();
        shell.administrator_launcher = Some(PathBuf::from(r"C:\Windows\System32\sudo.exe"));

        let argv = command_for(&shell)
            .get_argv()
            .iter()
            .map(|argument| argument.to_string_lossy().to_string())
            .collect::<Vec<_>>();

        assert_eq!(
            argv,
            vec![
                r"C:\Windows\System32\sudo.exe",
                r"C:\Windows\System32\cmd.exe"
            ]
        );
        assert_eq!(shell.id(), "command-prompt-administrator");
        assert_eq!(shell.label(), "Command Prompt (Administrator)");
    }

    #[test]
    fn policy_can_only_restrict_the_users_sudo_mode() {
        assert_eq!(effective_sudo_mode(Some(3), None), Some(3));
        assert_eq!(effective_sudo_mode(Some(3), Some(1)), Some(1));
        assert_eq!(effective_sudo_mode(Some(2), Some(3)), Some(2));
        assert_eq!(effective_sudo_mode(None, Some(3)), None);
    }

    #[test]
    fn local_shells_start_in_the_user_profile_with_term_only_where_it_is_read() {
        let exists = installed(&[
            r"C:\Windows\System32\cmd.exe",
            r"C:\Program Files\Git\bin\bash.exe",
        ]);
        let prompt =
            command_for(&resolve(LocalShellKind::CommandPrompt, &environment(), &exists).unwrap());
        let bash = command_for(&resolve(LocalShellKind::GitBash, &environment(), &exists).unwrap());
        let overrides = |command: &CommandBuilder| {
            command
                .iter_extra_env_as_str()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect::<Vec<_>>()
        };

        assert_eq!(
            prompt.get_cwd().map(PathBuf::from),
            Some(PathBuf::from(r"C:\Users\dev"))
        );
        assert!(overrides(&prompt).is_empty());
        let mut expected = vec![("TERM".to_string(), "xterm-256color".to_string())];
        if env::var_os("OTUI_USE_ALTERNATE_SCREEN").is_none() {
            expected.insert(0, ("OTUI_USE_ALTERNATE_SCREEN".into(), "0".into()));
        }
        assert_eq!(overrides(&bash), expected);
        assert!(
            !overrides(&bash)
                .iter()
                .any(|(key, _)| key.starts_with("WT_"))
        );
    }

    #[test]
    fn only_known_profile_ids_resolve() {
        assert_eq!(
            LocalShellKind::from_id("powershell-7"),
            Some(LocalShellKind::PowerShell7)
        );
        assert_eq!(LocalShellKind::from_id("wt.exe"), None);
        assert_eq!(LocalShellKind::from_id("cmd.exe /c calc"), None);
        assert_eq!(
            LocalShellKind::from_id(r"C:\Windows\System32\cmd.exe"),
            None
        );
        assert_eq!(LocalShellKind::from_id(""), None);
        assert_eq!(
            LocalShellKind::from_profile_id("windows-powershell-administrator"),
            Some((LocalShellKind::WindowsPowerShell, true))
        );
        assert_eq!(
            LocalShellKind::from_profile_id("git-bash-administrator"),
            None
        );
        assert_eq!(
            resolve_installed("../../evil.exe").unwrap_err(),
            "Unknown local shell"
        );
    }

    #[test]
    fn git_bash_defaults_opentui_to_the_main_screen() {
        let mut command = CommandBuilder::new("bash.exe");
        command.env_clear();
        configure_terminal_environment(&mut command, LocalShellKind::GitBash);
        assert_eq!(
            command.get_env("OTUI_USE_ALTERNATE_SCREEN"),
            Some(std::ffi::OsStr::new("0"))
        );
    }

    #[test]
    fn an_explicit_opentui_screen_preference_is_preserved() {
        let mut command = CommandBuilder::new("bash.exe");
        command.env("OTUI_USE_ALTERNATE_SCREEN", "1");
        configure_terminal_environment(&mut command, LocalShellKind::GitBash);
        assert_eq!(
            command.get_env("OTUI_USE_ALTERNATE_SCREEN"),
            Some(std::ffi::OsStr::new("1"))
        );
    }

    #[test]
    fn other_shells_do_not_receive_the_git_bash_opentui_workaround() {
        for kind in [
            LocalShellKind::PowerShell7,
            LocalShellKind::WindowsPowerShell,
            LocalShellKind::CommandPrompt,
        ] {
            let mut command = CommandBuilder::new("shell.exe");
            command.env_clear();
            configure_terminal_environment(&mut command, kind);
            assert!(command.get_env("OTUI_USE_ALTERNATE_SCREEN").is_none());
        }
    }

    #[test]
    fn profile_ids_match_their_serialized_form() {
        for kind in LocalShellKind::ALL {
            let serialized = serde_json::to_string(&kind).unwrap();
            assert_eq!(serialized, format!("\"{}\"", kind.id()));
            assert_eq!(LocalShellKind::from_id(kind.id()), Some(kind));
        }
    }

    #[test]
    #[cfg(windows)]
    fn the_command_processor_resolves_on_this_machine() {
        let shell = resolve_installed("command-prompt").unwrap();
        assert!(shell.program.ends_with("cmd.exe"));
        assert!(
            installed_shells()
                .profiles
                .iter()
                .any(|profile| profile.id == "command-prompt")
        );
    }
}
