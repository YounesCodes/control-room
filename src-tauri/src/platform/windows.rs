use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

use std::os::windows::process::CommandExt;
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

pub(super) const CLIENT_ID: &str = "windows";

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

fn path_entries() -> Vec<PathBuf> {
    env::var_os("PATH")
        .map(|paths| env::split_paths(&paths).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

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
}
