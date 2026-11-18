use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::OnceLock,
};

use parking_lot::Mutex;

use crate::models::SavedConnection;

pub const CONNECTION_TEST_ID: &str = "connection-test";
const CONTROL_PERSIST_SECONDS: u32 = 60;
const MACOS_SUN_PATH_BYTES: usize = 104;
const OPENSSH_TEMPORARY_SOCKET_SUFFIX_BYTES: usize = 17;
const MAX_CONTROL_PATH_BYTES: usize =
    MACOS_SUN_PATH_BYTES - OPENSSH_TEMPORARY_SOCKET_SUFFIX_BYTES - 1;
const SOCKET_DIRECTORY_NAME: &str = "control-room-ssh";
#[cfg_attr(not(unix), allow(dead_code))]
const CONTROL_COMMAND_HOST: &str = "control-room";

type Masters = Mutex<HashMap<String, HashSet<PathBuf>>>;

fn masters() -> &'static Masters {
    static MASTERS: OnceLock<Masters> = OnceLock::new();
    MASTERS.get_or_init(Default::default)
}

pub fn inspection_arguments(connection: &SavedConnection, arguments: Vec<String>) -> Vec<String> {
    inspection_arguments_in(socket_directory(), connection, arguments)
}

fn inspection_arguments_in(
    directory: Option<&Path>,
    connection: &SavedConnection,
    mut arguments: Vec<String>,
) -> Vec<String> {
    let Some(directory) = directory else {
        return arguments;
    };
    if let Some(options) = options_in(directory, connection, &arguments) {
        let destination = arguments
            .pop()
            .expect("connection arguments end with a destination");
        arguments.extend(options);
        arguments.push(destination);
    }
    arguments
}

fn options_in(
    directory: &Path,
    connection: &SavedConnection,
    arguments: &[String],
) -> Option<Vec<String>> {
    if connection.id == CONNECTION_TEST_ID {
        return None;
    }
    let path = control_path(directory, arguments)?;
    if !clear_non_socket(&path) {
        return None;
    }
    masters()
        .lock()
        .entry(connection.id.clone())
        .or_default()
        .insert(path.clone());
    Some(vec![
        "-o".into(),
        "ControlMaster=auto".into(),
        "-o".into(),
        format!("ControlPath={}", path.display()),
        "-o".into(),
        format!("ControlPersist={CONTROL_PERSIST_SECONDS}"),
    ])
}

fn control_path(directory: &Path, arguments: &[String]) -> Option<PathBuf> {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    arguments.hash(&mut hasher);
    let path = directory.join(format!("{:016x}", hasher.finish()));
    let text = path.to_str()?;
    let expandable = text.starts_with('~')
        || text
            .chars()
            .any(|character| character == '%' || character == '"' || character.is_whitespace());
    (text.len() <= MAX_CONTROL_PATH_BYTES && !expandable).then_some(path)
}

#[cfg(unix)]
fn clear_non_socket(path: &Path) -> bool {
    use std::os::unix::fs::FileTypeExt;
    match path.symlink_metadata() {
        Ok(metadata) if metadata.file_type().is_socket() => true,
        Ok(_) => std::fs::remove_file(path).is_ok(),
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

#[cfg(not(unix))]
fn clear_non_socket(_path: &Path) -> bool {
    false
}

fn socket_directory() -> Option<&'static Path> {
    static DIRECTORY: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIRECTORY
        .get_or_init(|| {
            let candidate = socket_directory_candidate()?;
            private_directory(&candidate).then_some(candidate)
        })
        .as_deref()
}

#[cfg(target_os = "linux")]
fn socket_directory_candidate() -> Option<PathBuf> {
    socket_directory_for(
        std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from),
        &std::env::temp_dir(),
        unsafe { libc::geteuid() },
    )
}

#[cfg(target_os = "macos")]
fn socket_directory_candidate() -> Option<PathBuf> {
    Some(std::env::temp_dir().join(SOCKET_DIRECTORY_NAME))
}

#[cfg(not(unix))]
fn socket_directory_candidate() -> Option<PathBuf> {
    None
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn socket_directory_for(runtime: Option<PathBuf>, temporary: &Path, uid: u32) -> Option<PathBuf> {
    match runtime.filter(|path| path.is_absolute()) {
        Some(runtime) => Some(runtime.join(SOCKET_DIRECTORY_NAME)),
        None => Some(temporary.join(format!("{SOCKET_DIRECTORY_NAME}-{uid}"))),
    }
}

#[cfg(unix)]
fn private_directory(path: &Path) -> bool {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    let _ = std::fs::DirBuilder::new().mode(0o700).create(path);
    let Ok(metadata) = path.symlink_metadata() else {
        return false;
    };
    if !metadata.file_type().is_dir() || metadata.uid() != unsafe { libc::geteuid() } {
        return false;
    }
    metadata.mode() & 0o077 == 0
        || std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).is_ok()
}

#[cfg(not(unix))]
fn private_directory(_path: &Path) -> bool {
    false
}

#[cfg_attr(not(unix), allow(dead_code))]
fn control_command_arguments(path: &Path, request: &str) -> Vec<String> {
    vec![
        "-O".into(),
        request.into(),
        "-o".into(),
        format!("ControlPath={}", path.display()),
        CONTROL_COMMAND_HOST.into(),
    ]
}

fn take_masters(connection_id: Option<&str>) -> Vec<PathBuf> {
    let mut masters = masters().lock();
    match connection_id {
        Some(id) => masters.remove(id).into_iter().flatten().collect(),
        None => masters.drain().flat_map(|(_, paths)| paths).collect(),
    }
}

/// Lets the connection's shared SSH masters finish their current calls, then exit.
pub fn stop_connection(connection_id: &str) {
    let paths = take_masters(Some(connection_id));
    if !paths.is_empty() {
        std::thread::spawn(move || send_control_requests(paths, "stop"));
    }
}

/// Ends every shared SSH master this process started.
pub fn exit_all() {
    send_control_requests(take_masters(None), "exit");
}

#[cfg(unix)]
fn send_control_requests(paths: Vec<PathBuf>, request: &'static str) {
    use std::{process::Stdio, time::Duration};
    use wait_timeout::ChildExt;
    let Some(ssh) = crate::ssh::detect_ssh_path() else {
        return;
    };
    let children: Vec<_> = paths
        .iter()
        .filter(|path| path.exists())
        .filter_map(|path| {
            crate::ssh::background_command(&ssh)
                .args(control_command_arguments(path, request))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .ok()
        })
        .collect();
    for mut child in children {
        if !matches!(child.wait_timeout(Duration::from_secs(2)), Ok(Some(_))) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(not(unix))]
fn send_control_requests(_paths: Vec<PathBuf>, _request: &'static str) {}

#[cfg(test)]
mod tests;
