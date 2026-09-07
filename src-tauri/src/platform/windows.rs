use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

use std::os::windows::process::CommandExt;
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

use super::PlatformShell;
use crate::models::LocalShellKind;

pub(super) const CLIENT_ID: &str = "windows";

const SHELLS: [LocalShellKind; 4] = [
    LocalShellKind::PowerShell7,
    LocalShellKind::WindowsPowerShell,
    LocalShellKind::CommandPrompt,
    LocalShellKind::GitBash,
];

#[derive(Debug, Clone, Default)]
struct Environment {
    system_root: Option<PathBuf>,
    program_files: Vec<PathBuf>,
    local_app_data: Option<PathBuf>,
    path_entries: Vec<PathBuf>,
    user_profile: Option<PathBuf>,
}

impl Environment {
    fn from_process() -> Self {
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
            path_entries: path_entries(),
            user_profile: env::var_os("USERPROFILE").map(PathBuf::from),
        }
    }
}

pub(super) fn is_supported() -> bool {
    cfg!(target_arch = "x86_64")
}

pub(super) fn configure_background_command(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

pub(super) fn detect_ssh_path() -> Option<PathBuf> {
    detect_ssh_path_in(&path_entries(), &Path::is_file)
}

fn detect_ssh_path_in(path_entries: &[PathBuf], exists: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    std::iter::once(PathBuf::from(r"C:\Windows\System32\OpenSSH\ssh.exe"))
        .chain(path_entries.iter().map(|entry| entry.join("ssh.exe")))
        .find(|candidate| exists(candidate))
}

pub(super) fn detect_ssh_add_path(ssh_path: &Path) -> Option<PathBuf> {
    ssh_add_path_in(ssh_path, &Path::is_file)
}

fn ssh_add_path_in(ssh_path: &Path, exists: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    let candidate = ssh_path.with_file_name("ssh-add.exe");
    exists(&candidate).then_some(candidate)
}

pub(super) fn ssh_config_path() -> PathBuf {
    ssh_config_path_in(env::var_os("USERPROFILE").map(PathBuf::from))
}

fn ssh_config_path_in(home: Option<PathBuf>) -> PathBuf {
    home.unwrap_or_default().join(".ssh").join("config")
}

pub(super) fn ssh_not_found_message() -> String {
    "Windows OpenSSH client was not found. Install the OpenSSH Client optional feature.".into()
}

pub(super) fn installed_local_shells() -> Vec<PlatformShell> {
    let environment = Environment::from_process();
    SHELLS
        .into_iter()
        .filter_map(|kind| resolve(kind, &environment, &Path::is_file))
        .collect()
}

pub(super) fn resolve_local_shell(kind: LocalShellKind) -> Option<PlatformShell> {
    resolve(kind, &Environment::from_process(), &Path::is_file)
}

fn resolve(
    kind: LocalShellKind,
    environment: &Environment,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PlatformShell> {
    let program = candidate_programs(kind, environment)
        .into_iter()
        .find(|candidate| exists(candidate))?;
    Some(PlatformShell {
        kind,
        program,
        arguments: match kind {
            LocalShellKind::PowerShell7 | LocalShellKind::WindowsPowerShell => &["-NoLogo"],
            LocalShellKind::CommandPrompt => &[],
            LocalShellKind::GitBash => &["--login", "-i"],
            LocalShellKind::Zsh | LocalShellKind::Bash | LocalShellKind::Fish => return None,
        },
        working_directory: environment.user_profile.clone(),
    })
}

fn candidate_programs(kind: LocalShellKind, environment: &Environment) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    match kind {
        LocalShellKind::PowerShell7 => {
            candidates.extend(
                environment
                    .path_entries
                    .iter()
                    .map(|entry| entry.join("pwsh.exe")),
            );
            candidates.extend(
                environment
                    .program_files
                    .iter()
                    .map(|root| root.join("PowerShell").join("7").join("pwsh.exe")),
            );
            if let Some(local) = &environment.local_app_data {
                candidates.push(local.join("Microsoft").join("WindowsApps").join("pwsh.exe"));
            }
        }
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
            candidates.extend(
                environment
                    .program_files
                    .iter()
                    .map(|root| root.join("Git").join("bin").join("bash.exe")),
            );
            if let Some(local) = &environment.local_app_data {
                candidates.push(
                    local
                        .join("Programs")
                        .join("Git")
                        .join("bin")
                        .join("bash.exe"),
                );
            }
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
        LocalShellKind::Zsh | LocalShellKind::Bash | LocalShellKind::Fish => {}
    }
    candidates
}

fn path_entries() -> Vec<PathBuf> {
    env::var_os("PATH")
        .map(|paths| env::split_paths(&paths).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    fn environment() -> Environment {
        Environment {
            system_root: Some(PathBuf::from(r"C:\Windows")),
            program_files: vec![
                PathBuf::from(r"C:\Program Files"),
                PathBuf::from(r"C:\Program Files (x86)"),
            ],
            local_app_data: Some(PathBuf::from(r"C:\Users\dev\AppData\Local")),
            path_entries: vec![PathBuf::from(r"C:\Program Files\Git\cmd")],
            user_profile: Some(PathBuf::from(r"C:\Users\dev")),
        }
    }

    fn installed(paths: &[&str]) -> impl Fn(&Path) -> bool + use<> {
        let present: HashSet<String> = paths.iter().map(|path| path.to_lowercase()).collect();
        move |path: &Path| present.contains(&path.to_string_lossy().to_lowercase())
    }

    #[test]
    fn windows_ssh_prefers_the_system_client_then_path() {
        let entries = vec![PathBuf::from(r"C:\Tools\OpenSSH")];
        let system = installed(&[r"C:\Windows\System32\OpenSSH\ssh.exe"]);
        assert_eq!(
            detect_ssh_path_in(&entries, &system),
            Some(PathBuf::from(r"C:\Windows\System32\OpenSSH\ssh.exe"))
        );
        let fallback = installed(&[r"C:\Tools\OpenSSH\ssh.exe"]);
        assert_eq!(
            detect_ssh_path_in(&entries, &fallback),
            Some(PathBuf::from(r"C:\Tools\OpenSSH\ssh.exe"))
        );
    }

    #[test]
    fn windows_ssh_paths_use_the_user_profile_and_matching_agent() {
        assert_eq!(
            ssh_config_path_in(Some(PathBuf::from(r"C:\Users\dev"))),
            PathBuf::from(r"C:\Users\dev\.ssh\config")
        );
        let exists = installed(&[r"C:\Tools\OpenSSH\ssh-add.exe"]);
        assert_eq!(
            ssh_add_path_in(Path::new(r"C:\Tools\OpenSSH\ssh.exe"), &exists),
            Some(PathBuf::from(r"C:\Tools\OpenSSH\ssh-add.exe"))
        );
    }

    #[test]
    fn every_windows_shell_is_detected_without_offering_macos_shells() {
        let exists = installed(&[
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            r"C:\Windows\System32\cmd.exe",
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\bin\zsh.exe",
        ]);
        let discovered = SHELLS
            .into_iter()
            .filter_map(|kind| resolve(kind, &environment(), &exists))
            .map(|shell| shell.kind.id())
            .collect::<Vec<_>>();
        assert_eq!(
            discovered,
            [
                "powershell-7",
                "windows-powershell",
                "command-prompt",
                "git-bash"
            ]
        );
    }

    #[test]
    fn windows_shell_rules_keep_executables_and_arguments_backend_owned() {
        let exists = installed(&[
            r"C:\Users\dev\pwsh\pwsh.exe",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            r"C:\Windows\System32\cmd.exe",
            r"C:\Program Files\Git\bin\bash.exe",
        ]);
        let mut environment = environment();
        environment
            .path_entries
            .push(PathBuf::from(r"C:\Users\dev\pwsh"));

        let powershell = resolve(LocalShellKind::PowerShell7, &environment, &exists).unwrap();
        let git_bash = resolve(LocalShellKind::GitBash, &environment, &exists).unwrap();
        assert_eq!(
            powershell.program,
            PathBuf::from(r"C:\Users\dev\pwsh\pwsh.exe")
        );
        assert_eq!(powershell.arguments, ["-NoLogo"]);
        assert_eq!(git_bash.arguments, ["--login", "-i"]);
        assert!(!git_bash.program.to_string_lossy().contains("git-bash.exe"));
    }

    #[test]
    fn windows_powershell_and_git_bash_do_not_accept_unsafe_path_matches() {
        let mut environment = environment();
        environment.program_files.clear();
        environment.path_entries = vec![
            PathBuf::from(r"C:\shims"),
            PathBuf::from(r"C:\Windows\System32"),
        ];
        let exists = installed(&[r"C:\shims\powershell.exe", r"C:\Windows\System32\bash.exe"]);
        assert!(resolve(LocalShellKind::WindowsPowerShell, &environment, &exists).is_none());
        assert!(resolve(LocalShellKind::GitBash, &environment, &exists).is_none());
    }
}
