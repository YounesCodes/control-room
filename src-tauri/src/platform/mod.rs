//! Native client-platform integration.
//!
//! Callers use one small contract. Windows and macOS own executable discovery,
//! home-directory conventions, local shell allowlists, and process flags here
//! rather than spreading target checks through session and remote code.

use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use crate::models::{LocalShellKind, LocalShellProfile};

#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod imp;
// The macOS implementation uses only portable Rust APIs. Compile and run its
// contract tests on Windows too, while macOS CI still verifies the real target.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
#[path = "unsupported.rs"]
mod imp;
#[cfg(target_os = "windows")]
#[path = "windows.rs"]
mod imp;
#[cfg(all(test, not(target_os = "macos")))]
#[allow(dead_code)]
#[path = "macos.rs"]
mod macos_contract;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlatformShell {
    pub kind: LocalShellKind,
    pub program: PathBuf,
    pub arguments: &'static [&'static str],
    pub working_directory: Option<PathBuf>,
}

pub(crate) fn client_id() -> &'static str {
    imp::CLIENT_ID
}

pub(crate) fn is_supported() -> bool {
    imp::is_supported()
}

pub(crate) fn detect_ssh_path() -> Option<PathBuf> {
    imp::detect_ssh_path()
}

pub(crate) fn detect_ssh_add_path(ssh_path: &Path) -> Option<PathBuf> {
    imp::detect_ssh_add_path(ssh_path)
}

pub(crate) fn ssh_config_path() -> PathBuf {
    imp::ssh_config_path()
}

pub(crate) fn ssh_not_found_message() -> String {
    imp::ssh_not_found_message()
}

pub(crate) fn installed_local_shells() -> Vec<LocalShellProfile> {
    imp::installed_local_shells()
        .into_iter()
        .map(|shell| LocalShellProfile {
            id: shell.kind.id().into(),
            label: shell.kind.label().into(),
            kind: shell.kind,
        })
        .collect()
}

pub(crate) fn resolve_local_shell(kind: LocalShellKind) -> Option<PlatformShell> {
    imp::resolve_local_shell(kind)
}

pub(crate) fn background_command<S: AsRef<OsStr>>(program: S) -> Command {
    let mut command = Command::new(program);
    imp::configure_background_command(&mut command);
    command
}

pub(crate) fn probe_ssh_agent(ssh_path: Option<&Path>) -> bool {
    let Some(ssh_path) = ssh_path else {
        return false;
    };
    let Some(ssh_add) = detect_ssh_add_path(ssh_path) else {
        return false;
    };
    let Ok(mut child) = background_command(ssh_add)
        .arg("-l")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    match wait_timeout::ChildExt::wait_timeout(&mut child, std::time::Duration::from_secs(2)) {
        Ok(Some(status)) => status.success(),
        Ok(None) | Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_ssh_path_cannot_probe_an_unrelated_path_entry() {
        assert!(!probe_ssh_agent(None));
    }

    #[test]
    fn client_platform_has_a_stable_identifier() {
        assert!(matches!(client_id(), "windows" | "macos" | "unsupported"));
    }
}
