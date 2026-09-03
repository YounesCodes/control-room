//! Local Windows shell discovery and command construction.
//!
//! Rust owns which executables may run and with which arguments. React can name
//! a Local Shell Profile id and nothing else, so there is no path, argument, or
//! command string anywhere in this module's public input. A profile that is not
//! installed is never offered and never resolves.

use std::{
    env,
    path::{Path, PathBuf},
};

use portable_pty::CommandBuilder;

use crate::models::{LocalShellKind, LocalShellProfile};

/// A validated local shell that is ready to spawn. Only this module builds one,
/// so a caller cannot substitute a program or an argument of its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedLocalShell {
    pub kind: LocalShellKind,
    program: PathBuf,
    arguments: &'static [&'static str],
    working_directory: Option<PathBuf>,
}

impl ResolvedLocalShell {
    pub fn label(&self) -> &'static str {
        self.kind.label()
    }
}

/// The Windows locations discovery is allowed to look at, captured once so
/// detection can be tested without depending on what the machine has installed.
#[derive(Debug, Clone, Default)]
pub struct ShellEnvironment {
    pub system_root: Option<PathBuf>,
    pub program_files: Vec<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    pub path_entries: Vec<PathBuf>,
    pub user_profile: Option<PathBuf>,
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
        }
    }
}

/// The fixed arguments each shell is started with. They are constants, never
/// user input: a startup argument is not something the frontend may choose.
fn fixed_arguments(kind: LocalShellKind) -> &'static [&'static str] {
    match kind {
        // Both PowerShells are interactive by default; the banner is the only
        // thing worth suppressing, since Control Room already names the shell.
        LocalShellKind::PowerShell7 | LocalShellKind::WindowsPowerShell => &["-NoLogo"],
        LocalShellKind::CommandPrompt => &[],
        // Git Bash is `bash.exe` itself, as a login shell so the user's profile
        // scripts run, and interactive so it behaves like a terminal shell.
        LocalShellKind::GitBash => &["--login", "-i"],
    }
}

/// `TERM` is set only where the shell reads it. The PowerShells and the command
/// processor use the Windows console API instead, and inventing a value for them
/// would describe an environment they do not have.
fn terminal_type(kind: LocalShellKind) -> Option<&'static str> {
    match kind {
        LocalShellKind::GitBash => Some("xterm-256color"),
        _ => None,
    }
}

/// Every place a shell may legitimately live, most specific first. Nothing here
/// depends on a listing or a registry read, so the same input always produces
/// the same candidates.
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
        // The built-in shell has one canonical path. Searching PATH for
        // `powershell.exe` could pick up a shim and report it as the Windows
        // PowerShell that ships with the OS.
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
            // A Git install that is only on PATH is found through its own
            // directory. `bash.exe` is never taken from PATH directly, because
            // `System32\bash.exe` is the WSL launcher, which is out of scope.
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
        // A local shell starts where the user's own shell would, not in the
        // directory Control Room happens to be installed in.
        working_directory: environment
            .user_profile
            .as_ref()
            .filter(|profile| exists(profile) || profile.is_dir())
            .cloned(),
    })
}

/// The profiles that are actually available. An uninstalled shell is left out
/// rather than offered and then failing on launch.
pub fn discover(
    environment: &ShellEnvironment,
    exists: &dyn Fn(&Path) -> bool,
) -> Vec<LocalShellProfile> {
    LocalShellKind::ALL
        .iter()
        .filter(|kind| resolve(**kind, environment, exists).is_some())
        .map(|kind| LocalShellProfile {
            id: kind.id().into(),
            label: kind.label().into(),
            kind: *kind,
        })
        .collect()
}

pub fn installed_shells() -> Vec<LocalShellProfile> {
    discover(&ShellEnvironment::from_process_env(), &|path| {
        path.is_file()
    })
}

/// Validates a Local Shell Profile id from the frontend and resolves it against
/// the machine as it is right now. An unknown id and a shell that disappeared
/// after discovery are both refused here.
pub fn resolve_installed(shell_id: &str) -> Result<ResolvedLocalShell, String> {
    let kind = LocalShellKind::from_id(shell_id).ok_or("Unknown local shell")?;
    resolve(kind, &ShellEnvironment::from_process_env(), &|path| {
        path.is_file()
    })
    .ok_or_else(|| format!("{} is no longer available.", kind.label()))
}

/// Builds the pty command for a resolved shell. The local shell inherits the
/// user's normal Windows environment; only `TERM` is added, and only for a shell
/// that reads it.
pub fn command_for(shell: &ResolvedLocalShell) -> CommandBuilder {
    let mut command = CommandBuilder::new(&shell.program);
    command.args(shell.arguments);
    if let Some(terminal) = terminal_type(shell.kind) {
        command.env("TERM", terminal);
    }
    if let Some(directory) = &shell.working_directory {
        command.cwd(directory);
    }
    command
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
        }
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
        // System32\bash.exe starts WSL, which this feature does not cover.
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
    fn local_shells_start_in_the_user_profile_with_term_only_where_it_is_read() {
        let exists = installed(&[
            r"C:\Windows\System32\cmd.exe",
            r"C:\Program Files\Git\bin\bash.exe",
        ]);
        let prompt =
            command_for(&resolve(LocalShellKind::CommandPrompt, &environment(), &exists).unwrap());
        let bash = command_for(&resolve(LocalShellKind::GitBash, &environment(), &exists).unwrap());
        // Only the variables Control Room sets itself; the rest of the user's
        // Windows environment is inherited untouched.
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
        assert_eq!(
            overrides(&bash),
            vec![("TERM".to_string(), "xterm-256color".to_string())]
        );
        // No Windows Terminal variable is invented for a shell Control Room
        // hosts itself.
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
            resolve_installed("../../evil.exe").unwrap_err(),
            "Unknown local shell"
        );
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
        // cmd.exe ships with every supported Windows install, so this is the one
        // resolution that can be asserted against the real environment.
        let shell = resolve_installed("command-prompt").unwrap();
        assert!(shell.program.ends_with("cmd.exe"));
        assert!(
            installed_shells()
                .iter()
                .any(|profile| profile.id == "command-prompt")
        );
    }
}
