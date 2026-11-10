use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

use super::PlatformShell;
use crate::models::LocalShellKind;

pub(super) const CLIENT_ID: &str = "macos";

const SHELLS: [LocalShellKind; 3] = [
    LocalShellKind::Zsh,
    LocalShellKind::Bash,
    LocalShellKind::Fish,
];

#[derive(Debug, Clone, Default)]
struct Environment {
    home: Option<PathBuf>,
    path_entries: Vec<PathBuf>,
}

impl Environment {
    fn from_process() -> Self {
        Self {
            home: env::var_os("HOME").map(PathBuf::from),
            path_entries: path_entries(),
        }
    }
}

pub(super) fn is_supported() -> bool {
    cfg!(any(target_arch = "aarch64", target_arch = "x86_64"))
}

pub(super) fn configure_background_command(_command: &mut Command) {}

pub(super) fn detect_ssh_path() -> Option<PathBuf> {
    detect_ssh_path_in(&path_entries(), &Path::is_file)
}

fn detect_ssh_path_in(path_entries: &[PathBuf], exists: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    std::iter::once(PathBuf::from("/usr/bin/ssh"))
        .chain(path_entries.iter().map(|entry| entry.join("ssh")))
        .find(|candidate| exists(candidate))
}

pub(super) fn detect_ssh_add_path(ssh_path: &Path) -> Option<PathBuf> {
    ssh_add_path_in(ssh_path, &path_entries(), &Path::is_file)
}

fn ssh_add_path_in(
    ssh_path: &Path,
    path_entries: &[PathBuf],
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    std::iter::once(ssh_path.with_file_name("ssh-add"))
        .chain(std::iter::once(PathBuf::from("/usr/bin/ssh-add")))
        .chain(path_entries.iter().map(|entry| entry.join("ssh-add")))
        .find(|candidate| exists(candidate))
}

pub(super) fn ssh_config_path() -> PathBuf {
    ssh_config_path_in(env::var_os("HOME").map(PathBuf::from))
}

fn ssh_config_path_in(home: Option<PathBuf>) -> PathBuf {
    home.unwrap_or_default().join(".ssh").join("config")
}

pub(super) fn ssh_not_found_message() -> String {
    "The macOS OpenSSH client was not found at /usr/bin/ssh or on PATH.".into()
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
            LocalShellKind::Zsh => &["-l"],
            LocalShellKind::Bash => &["--login", "-i"],
            LocalShellKind::Fish => &["--login"],
            LocalShellKind::PowerShell7
            | LocalShellKind::WindowsPowerShell
            | LocalShellKind::CommandPrompt
            | LocalShellKind::GitBash => return None,
        },
        working_directory: environment.home.clone(),
    })
}

fn candidate_programs(kind: LocalShellKind, environment: &Environment) -> Vec<PathBuf> {
    let (names, executable_name): (&[&str], &str) = match kind {
        LocalShellKind::Zsh => (&["/bin/zsh", "/usr/bin/zsh"], "zsh"),
        LocalShellKind::Bash => (&["/bin/bash", "/usr/bin/bash"], "bash"),
        LocalShellKind::Fish => (&["/opt/homebrew/bin/fish", "/usr/local/bin/fish"], "fish"),
        LocalShellKind::PowerShell7
        | LocalShellKind::WindowsPowerShell
        | LocalShellKind::CommandPrompt
        | LocalShellKind::GitBash => return Vec::new(),
    };
    names
        .iter()
        .map(PathBuf::from)
        .chain(
            environment
                .path_entries
                .iter()
                .map(|entry| entry.join(executable_name)),
        )
        .collect()
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
            home: Some(PathBuf::from("/Users/dev")),
            path_entries: vec![PathBuf::from("/custom/bin")],
        }
    }

    fn installed(paths: &[&str]) -> impl Fn(&Path) -> bool + use<> {
        let present: HashSet<PathBuf> = paths.iter().map(PathBuf::from).collect();
        move |path: &Path| present.contains(path)
    }

    #[test]
    fn macos_ssh_prefers_usr_bin_then_path() {
        let entries = vec![PathBuf::from("/custom/bin")];
        assert_eq!(
            detect_ssh_path_in(&entries, &installed(&["/usr/bin/ssh"])),
            Some(PathBuf::from("/usr/bin/ssh"))
        );
        assert_eq!(
            detect_ssh_path_in(&entries, &installed(&["/custom/bin/ssh"])),
            Some(PathBuf::from("/custom/bin/ssh"))
        );
    }

    #[test]
    fn macos_agent_probe_uses_the_matching_ssh_add_then_system_fallback() {
        let entries = vec![PathBuf::from("/custom/bin")];
        assert_eq!(
            ssh_add_path_in(
                Path::new("/custom/bin/ssh"),
                &entries,
                &installed(&["/custom/bin/ssh-add", "/usr/bin/ssh-add"]),
            ),
            Some(PathBuf::from("/custom/bin/ssh-add"))
        );
        assert_eq!(
            ssh_add_path_in(
                Path::new("/custom/bin/ssh"),
                &entries,
                &installed(&["/usr/bin/ssh-add"]),
            ),
            Some(PathBuf::from("/usr/bin/ssh-add"))
        );
    }

    #[test]
    fn macos_ssh_config_uses_home() {
        assert_eq!(
            ssh_config_path_in(Some(PathBuf::from("/Users/dev"))),
            PathBuf::from("/Users/dev/.ssh/config")
        );
    }

    #[test]
    fn macos_shell_discovery_offers_only_installed_allowlisted_shells() {
        let exists = installed(&["/bin/zsh", "/custom/bin/fish"]);
        let discovered = SHELLS
            .into_iter()
            .filter_map(|kind| resolve(kind, &environment(), &exists))
            .map(|shell| shell.kind.id())
            .collect::<Vec<_>>();
        assert_eq!(discovered, ["zsh", "fish"]);
    }

    #[test]
    fn macos_shells_have_fixed_programs_arguments_and_home() {
        let exists = installed(&["/bin/zsh", "/bin/bash", "/opt/homebrew/bin/fish"]);
        let zsh = resolve(LocalShellKind::Zsh, &environment(), &exists).unwrap();
        let bash = resolve(LocalShellKind::Bash, &environment(), &exists).unwrap();
        let fish = resolve(LocalShellKind::Fish, &environment(), &exists).unwrap();
        assert_eq!(zsh.arguments, ["-l"]);
        assert_eq!(bash.arguments, ["--login", "-i"]);
        assert_eq!(fish.arguments, ["--login"]);
        assert_eq!(zsh.working_directory, Some(PathBuf::from("/Users/dev")));
    }
}
