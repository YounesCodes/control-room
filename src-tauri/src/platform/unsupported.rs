use std::{path::Path, process::Command};

use super::PlatformShell;
use crate::models::LocalShellKind;

pub(super) const CLIENT_ID: &str = "unsupported";

pub(super) fn is_supported() -> bool {
    false
}

pub(super) fn configure_background_command(_command: &mut Command) {}

pub(super) fn detect_ssh_path() -> Option<std::path::PathBuf> {
    None
}

pub(super) fn detect_ssh_add_path(_ssh_path: &Path) -> Option<std::path::PathBuf> {
    None
}

pub(super) fn ssh_config_path() -> std::path::PathBuf {
    std::path::PathBuf::new()
}

pub(super) fn ssh_not_found_message() -> String {
    "Control Room supports Windows and macOS clients.".into()
}

pub(super) fn installed_local_shells() -> Vec<PlatformShell> {
    Vec::new()
}

pub(super) fn resolve_local_shell(_kind: LocalShellKind) -> Option<PlatformShell> {
    None
}
