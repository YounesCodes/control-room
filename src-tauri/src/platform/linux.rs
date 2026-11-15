use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

use crate::ssh::executable_file;

pub(super) const CLIENT_ID: &str = "linux";

pub(super) fn is_supported() -> bool {
    cfg!(target_arch = "x86_64")
}

/// An AppImage adds its own library and data paths to the environment. System
/// tools such as OpenSSH must run with the host's values instead.
pub(super) fn configure_background_command(command: &mut Command) {
    for (name, value) in crate::appimage::host_environment() {
        if let Some(value) = value {
            command.env(name, value);
        } else {
            command.env_remove(name);
        }
    }
}

pub(super) fn detect_ssh_path() -> Option<PathBuf> {
    let system = PathBuf::from("/usr/bin/ssh");
    if executable_file(&system) {
        return Some(system);
    }
    env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths)
            .map(|path| path.join("ssh"))
            .find(|path| executable_file(path))
    })
}

pub(super) fn detect_ssh_add_path(ssh_path: &Path) -> Option<PathBuf> {
    let candidate = ssh_path.with_file_name("ssh-add");
    candidate.is_file().then_some(candidate)
}

pub(super) fn ssh_config_path() -> PathBuf {
    env::home_dir()
        .unwrap_or_default()
        .join(".ssh")
        .join("config")
}

pub(super) fn ssh_not_found_message() -> String {
    "OpenSSH client was not found. Install the openssh-client package.".into()
}
