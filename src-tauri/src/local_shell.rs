//! Allowlisted local shell resolution and PTY command construction.
//!
//! React can send one stable profile id. The native platform module resolves
//! that id to a fixed executable and fixed arguments. No frontend call accepts
//! a program path, script, or argument list.

use std::path::PathBuf;

use portable_pty::CommandBuilder;

use crate::{
    models::{LocalShellKind, LocalShellProfile},
    platform::{self, PlatformShell},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedLocalShell {
    pub kind: LocalShellKind,
    program: PathBuf,
    arguments: &'static [&'static str],
    working_directory: Option<PathBuf>,
}

impl From<PlatformShell> for ResolvedLocalShell {
    fn from(shell: PlatformShell) -> Self {
        Self {
            kind: shell.kind,
            program: shell.program,
            arguments: shell.arguments,
            working_directory: shell.working_directory,
        }
    }
}

impl ResolvedLocalShell {
    pub fn label(&self) -> &'static str {
        self.kind.label()
    }

    /// The resolved executable, for tests that need to run a discovered shell
    /// outside the pty. Test-only on purpose: in a real build there is still no
    /// way for anything to read or choose the program, which is what keeps
    /// `command_for` the only way a local shell is started.
    #[cfg(test)]
    pub(crate) fn program(&self) -> &std::path::Path {
        &self.program
    }
}

pub fn installed_shells() -> Vec<LocalShellProfile> {
    platform::installed_local_shells()
}

pub fn resolve_installed(shell_id: &str) -> Result<ResolvedLocalShell, String> {
    let kind = LocalShellKind::from_id(shell_id).ok_or("Unknown local shell")?;
    platform::resolve_local_shell(kind)
        .map(ResolvedLocalShell::from)
        .ok_or_else(|| format!("{} is not available on this machine.", kind.label()))
}

pub fn command_for(shell: &ResolvedLocalShell) -> CommandBuilder {
    let mut command = CommandBuilder::new(&shell.program);
    command.args(shell.arguments);
    if shell.kind.uses_terminal_type() {
        command.env("TERM", "xterm-256color");
    }
    if let Some(directory) = &shell.working_directory {
        command.cwd(directory);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_profile_ids_resolve() {
        assert_eq!(
            LocalShellKind::from_id("powershell-7"),
            Some(LocalShellKind::PowerShell7)
        );
        assert_eq!(LocalShellKind::from_id("zsh"), Some(LocalShellKind::Zsh));
        assert_eq!(LocalShellKind::from_id("wt.exe"), None);
        assert_eq!(LocalShellKind::from_id("cmd.exe /c calc"), None);
        assert_eq!(LocalShellKind::from_id("/bin/sh"), None);
        assert_eq!(LocalShellKind::from_id(""), None);
        assert_eq!(
            resolve_installed("../../evil").unwrap_err(),
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
        let shell = resolve_installed("command-prompt").unwrap();
        assert!(shell.program.ends_with("cmd.exe"));
        assert!(
            installed_shells()
                .iter()
                .any(|profile| profile.id == "command-prompt")
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn the_system_zsh_resolves_on_this_machine() {
        let shell = resolve_installed("zsh").unwrap();
        assert!(shell.program.ends_with("zsh"));
        assert!(installed_shells().iter().any(|profile| profile.id == "zsh"));
    }
}
