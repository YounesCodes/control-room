//! Discover Linux shells locally. The frontend can only select a profile ID.

#[cfg(test)]
use std::path::Path;
use std::{env, path::PathBuf};

use portable_pty::CommandBuilder;

use crate::{
    models::{AdministratorTerminalStatus, LocalShellCatalog, LocalShellKind, LocalShellProfile},
    ssh::executable_file,
};

pub struct ResolvedLocalShell {
    kind: LocalShellKind,
    program: PathBuf,
    home: Option<PathBuf>,
}

impl ResolvedLocalShell {
    #[cfg(test)]
    pub(crate) fn program(&self) -> &Path {
        &self.program
    }

    pub fn label(&self) -> &'static str {
        self.kind.label()
    }

    pub fn id(&self) -> &'static str {
        self.kind.id()
    }
}

const SHELLS: [(LocalShellKind, &str); 4] = [
    (LocalShellKind::Bash, "bash"),
    (LocalShellKind::Zsh, "zsh"),
    (LocalShellKind::Fish, "fish"),
    (LocalShellKind::Sh, "sh"),
];

fn discover(
    login: Option<PathBuf>,
    search: &[PathBuf],
    home: Option<PathBuf>,
) -> Vec<ResolvedLocalShell> {
    let mut shells = Vec::new();
    if let Some(program) = login.filter(|path| executable_file(path)) {
        let kind = SHELLS
            .iter()
            .find_map(|(kind, name)| (program.file_name()? == *name).then_some(*kind))
            .unwrap_or(LocalShellKind::LoginShell);
        shells.push(ResolvedLocalShell {
            kind,
            program,
            home: home.clone(),
        });
    }

    for (kind, name) in SHELLS {
        if shells.iter().any(|shell| shell.kind == kind) {
            continue;
        }
        if let Some(program) = search
            .iter()
            .map(|dir| dir.join(name))
            .find(|path| executable_file(path))
        {
            shells.push(ResolvedLocalShell {
                kind,
                program,
                home: home.clone(),
            });
        }
    }
    shells
}

fn installed() -> Vec<ResolvedLocalShell> {
    let mut search = vec![PathBuf::from("/usr/bin"), PathBuf::from("/bin")];
    if let Some(path) = env::var_os("PATH") {
        search.extend(env::split_paths(&path));
    }
    discover(
        env::var_os("SHELL").map(PathBuf::from),
        &search,
        env::home_dir().filter(|path| path.is_absolute() && path.is_dir()),
    )
}

pub fn installed_shells() -> LocalShellCatalog {
    LocalShellCatalog {
        profiles: installed()
            .into_iter()
            .map(|shell| LocalShellProfile {
                id: shell.id().into(),
                label: shell.label().into(),
                kind: shell.kind,
                elevated: false,
            })
            .collect(),
        administrator_status: AdministratorTerminalStatus::UnsupportedPlatform,
    }
}

pub fn resolve_installed(id: &str) -> Result<ResolvedLocalShell, String> {
    installed()
        .into_iter()
        .find(|shell| shell.id() == id)
        .ok_or_else(|| "This local shell is unavailable.".into())
}

pub fn command_for(shell: &ResolvedLocalShell) -> CommandBuilder {
    let mut command = CommandBuilder::new(&shell.program);
    if shell.kind != LocalShellKind::LoginShell {
        command.arg("-l");
    }
    command.arg("-i");
    command.env("TERM", "xterm-256color");
    if let Some(home) = &shell.home {
        command.cwd(home);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    fn file(dir: &Path, name: &str, mode: u32) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, "").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    #[test]
    fn discovery_prioritizes_the_login_shell_and_skips_nonexecutables() {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path();
        let search = [home.to_owned()];
        file(home, "bash", 0o755);
        let zsh = file(home, "zsh", 0o755);
        file(home, "fish", 0o644);
        fs::create_dir(home.join("sh")).unwrap();

        let shells = discover(Some(zsh), &search, Some(home.to_owned()));
        assert_eq!(
            shells
                .iter()
                .map(ResolvedLocalShell::id)
                .collect::<Vec<_>>(),
            ["zsh", "bash"]
        );
        let command = command_for(&shells[0]);
        assert_eq!(command.get_argv()[1..], ["-l", "-i"]);
        assert_eq!(command.get_env("TERM").unwrap(), "xterm-256color");
        assert_eq!(command.get_cwd().unwrap(), home.as_os_str());
    }

    #[test]
    fn login_shell_accepts_an_executable_path_from_the_environment_only() {
        let directory = tempfile::tempdir().unwrap();
        let path = file(directory.path(), "custom shell", 0o755);
        let shells = discover(Some(path.clone()), &[], None);
        assert_eq!(shells[0].id(), "login-shell");
        assert_eq!(command_for(&shells[0]).get_argv()[0], path.as_os_str());
        assert!(discover(Some(PathBuf::from("custom shell")), &[], None).is_empty());
        assert!(resolve_installed("/bin/sh -c command").is_err());
        assert!(resolve_installed("powershell-7-administrator").is_err());
    }
}
