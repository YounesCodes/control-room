#[cfg(not(windows))]
use crate::models::{AdministratorTerminalStatus, LocalShellCatalog};
use crate::models::{LocalShellKind, wsl_profile_id, wsl_profile_label};
use portable_pty::CommandBuilder;
#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
#[cfg(windows)]
#[path = "platform/windows_shell.rs"]
mod windows;
#[cfg(windows)]
pub use windows::{installed_shells, resolve_installed};
/// A validated local shell that is ready to spawn. Only this module builds one,
/// so a caller cannot substitute a program or an argument of its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedLocalShell {
    pub kind: LocalShellKind,
    program: PathBuf,
    arguments: &'static [&'static str],
    working_directory: Option<PathBuf>,
    administrator_launcher: Option<PathBuf>,
    wsl_distribution: Option<String>,
}

impl ResolvedLocalShell {
    pub fn label(&self) -> String {
        if let Some(distribution) = &self.wsl_distribution {
            return wsl_profile_label(distribution);
        }
        match (self.kind, self.is_elevated()) {
            (LocalShellKind::PowerShell7, true) => "PowerShell 7 (Administrator)",
            (LocalShellKind::WindowsPowerShell, true) => "Windows PowerShell (Administrator)",
            (LocalShellKind::CommandPrompt, true) => "Command Prompt (Administrator)",
            _ => self.kind.label(),
        }
        .into()
    }

    pub fn id(&self) -> String {
        if let Some(distribution) = &self.wsl_distribution {
            return wsl_profile_id(distribution);
        }
        if self.is_elevated() {
            self.kind
                .administrator_id()
                .expect("only administrator-capable shells can be elevated")
                .into()
        } else {
            self.kind.id().into()
        }
    }

    pub fn is_elevated(&self) -> bool {
        self.administrator_launcher.is_some()
    }

    /// The resolved executable, for tests that need to run a discovered shell
    /// outside the pty. Test-only on purpose: in a real build there is still no
    /// way for anything to read or choose the program, which is what keeps
    /// `command_for` the only way a local shell is started.
    #[cfg(test)]
    pub(crate) fn program(&self) -> &Path {
        &self.program
    }
}

/// Builds the pty command for a resolved shell. The local shell inherits the
/// user's normal environment, with Git Bash's terminal type and OpenTUI
/// compatibility default added by `configure_terminal_environment`.
pub fn command_for(shell: &ResolvedLocalShell) -> CommandBuilder {
    let mut command = if let Some(sudo) = &shell.administrator_launcher {
        let mut command = CommandBuilder::new(sudo);
        command.arg(&shell.program);
        command
    } else {
        CommandBuilder::new(&shell.program)
    };
    command.args(shell.arguments);
    if let Some(distribution) = &shell.wsl_distribution {
        command.args(["--distribution", distribution.as_str(), "--cd", "~"]);
    }
    #[cfg(windows)]
    windows::configure_terminal_environment(&mut command, shell.kind);
    if shell.kind.uses_terminal_type() {
        command.env("TERM", "xterm-256color");
    }
    if let Some(directory) = &shell.working_directory {
        command.cwd(directory);
    }
    command
}

#[cfg(not(windows))]
pub fn installed_shells() -> LocalShellCatalog {
    LocalShellCatalog {
        profiles: crate::platform::installed_local_shells(),
        administrator_status: AdministratorTerminalStatus::UnsupportedWindows,
    }
}
#[cfg(not(windows))]
pub fn resolve_installed(shell_id: &str) -> Result<ResolvedLocalShell, String> {
    let kind = LocalShellKind::from_id(shell_id).ok_or("Unknown local shell")?;
    let shell = crate::platform::resolve_local_shell(kind)
        .ok_or_else(|| format!("{} is not available on this machine.", kind.label()))?;
    Ok(ResolvedLocalShell {
        kind: shell.kind,
        program: shell.program,
        arguments: shell.arguments,
        working_directory: shell.working_directory,
        administrator_launcher: None,
        wsl_distribution: None,
    })
}
