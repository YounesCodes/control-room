use super::*;
use crate::ssh::connection_arguments;

fn saved(id: &str) -> SavedConnection {
    SavedConnection {
        id: id.into(),
        display_name: "Fixture".into(),
        destination: "host.example".into(),
        username: Some("fixture".into()),
        port: Some(2222),
        identity_file: None,
        history_enabled: false,
        sudo_enabled: false,
        group_id: None,
        tags: Vec::new(),
        created_at: String::new(),
        updated_at: String::new(),
        last_connected_at: None,
    }
}

#[cfg(unix)]
fn private_temp() -> tempfile::TempDir {
    let directory = tempfile::Builder::new()
        .prefix("crm")
        .tempdir_in("/tmp")
        .unwrap();
    assert!(private_directory(directory.path()));
    directory
}

#[test]
fn without_a_socket_directory_arguments_are_unchanged() {
    let connection = saved("no-directory");
    let arguments = connection_arguments(&connection, false);
    assert_eq!(
        inspection_arguments_in(None, &connection, arguments.clone()),
        arguments
    );
}

#[test]
fn control_paths_are_short_and_distinct_per_ssh_target() {
    let directory = Path::new("/run/user/1000/control-room-ssh");
    let base = saved("paths");
    let path = control_path(directory, &connection_arguments(&base, false)).unwrap();
    assert!(path.starts_with(directory));
    assert!(path.to_str().unwrap().len() <= MAX_CONTROL_PATH_BYTES);
    assert_eq!(
        control_path(directory, &connection_arguments(&base, false)),
        Some(path.clone())
    );
    let variants = [
        SavedConnection {
            destination: "other.example".into(),
            ..saved("paths")
        },
        SavedConnection {
            username: Some("someone-else".into()),
            ..saved("paths")
        },
        SavedConnection {
            port: Some(22),
            ..saved("paths")
        },
        SavedConnection {
            identity_file: Some("/home/fixture/.ssh/other".into()),
            ..saved("paths")
        },
    ];
    for variant in variants {
        assert_ne!(
            control_path(directory, &connection_arguments(&variant, false)),
            Some(path.clone())
        );
    }
}

#[test]
fn control_paths_that_ssh_would_expand_or_truncate_are_refused() {
    let arguments = connection_arguments(&saved("refused"), false);
    assert!(
        control_path(
            &PathBuf::from("/tmp/".to_string() + &"d".repeat(70)),
            &arguments
        )
        .is_none()
    );
    assert!(control_path(Path::new("/tmp/100%/control-room-ssh"), &arguments).is_none());
    assert!(control_path(Path::new("/tmp/with space"), &arguments).is_none());
    assert!(control_path(Path::new("~/control-room-ssh"), &arguments).is_none());
}

#[test]
fn macos_temporary_directories_fit_the_socket_limit() {
    let tmpdir = Path::new("/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/control-room-ssh");
    let arguments = connection_arguments(&saved("macos"), false);
    assert!(control_path(tmpdir, &arguments).is_some());
}

#[cfg(unix)]
#[test]
fn linux_prefers_the_runtime_directory_and_falls_back_per_user() {
    assert_eq!(
        socket_directory_for(Some("/run/user/1000".into()), Path::new("/tmp"), 1000),
        Some(PathBuf::from("/run/user/1000/control-room-ssh"))
    );
    assert_eq!(
        socket_directory_for(Some("relative".into()), Path::new("/tmp"), 1000),
        Some(PathBuf::from("/tmp/control-room-ssh-1000"))
    );
    assert_eq!(
        socket_directory_for(None, Path::new("/tmp"), 501),
        Some(PathBuf::from("/tmp/control-room-ssh-501"))
    );
}

#[test]
fn control_requests_name_only_the_socket() {
    assert_eq!(
        control_command_arguments(Path::new("/run/user/1000/control-room-ssh/abc"), "stop"),
        vec![
            "-O",
            "stop",
            "-o",
            "ControlPath=/run/user/1000/control-room-ssh/abc",
            "control-room"
        ]
    );
}

#[cfg(unix)]
#[test]
fn inspection_calls_share_a_master_before_the_destination() {
    let directory = private_temp();
    let connection = saved("shared-master");
    let base = connection_arguments(&connection, false);
    let arguments = inspection_arguments_in(Some(directory.path()), &connection, base.clone());
    let path = control_path(directory.path(), &base).unwrap();
    assert_eq!(&arguments[..base.len() - 1], &base[..base.len() - 1]);
    assert_eq!(
        &arguments[base.len() - 1..],
        &[
            "-o".to_string(),
            "ControlMaster=auto".into(),
            "-o".into(),
            format!("ControlPath={}", path.display()),
            "-o".into(),
            "ControlPersist=60".into(),
            "host.example".into(),
        ]
    );
    assert!(arguments.contains(&"BatchMode=yes".to_string()));
    assert_eq!(take_masters(Some("shared-master")), vec![path]);
    assert!(take_masters(Some("shared-master")).is_empty());
}

#[cfg(unix)]
#[test]
fn connection_tests_never_reuse_a_master() {
    let directory = private_temp();
    let connection = saved(CONNECTION_TEST_ID);
    let arguments = connection_arguments(&connection, false);
    assert_eq!(
        inspection_arguments_in(Some(directory.path()), &connection, arguments.clone()),
        arguments
    );
    assert!(take_masters(Some(CONNECTION_TEST_ID)).is_empty());
}

#[cfg(unix)]
#[test]
fn a_stale_non_socket_file_is_removed_before_use() {
    let directory = private_temp();
    let connection = saved("stale");
    let base = connection_arguments(&connection, false);
    let path = control_path(directory.path(), &base).unwrap();
    std::fs::write(&path, b"stale").unwrap();
    let arguments = inspection_arguments_in(Some(directory.path()), &connection, base);
    assert!(
        arguments
            .iter()
            .any(|argument| argument.starts_with("ControlPath="))
    );
    assert!(!path.exists());
    take_masters(Some("stale"));
}

#[cfg(unix)]
#[test]
fn the_socket_directory_is_owner_only_and_not_a_symlink() {
    use std::os::unix::fs::PermissionsExt;
    let parent = tempfile::tempdir().unwrap();
    let directory = parent.path().join("sockets");
    assert!(private_directory(&directory));
    let mode = std::fs::metadata(&directory).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o700);
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(private_directory(&directory));
    let mode = std::fs::metadata(&directory).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o700);
    let link = parent.path().join("link");
    std::os::unix::fs::symlink(&directory, &link).unwrap();
    assert!(!private_directory(&link));
    let file = parent.path().join("file");
    std::fs::write(&file, b"").unwrap();
    assert!(!private_directory(&file));
}

#[cfg(unix)]
#[test]
fn stopping_a_connection_forgets_only_its_masters() {
    let directory = private_temp();
    for id in ["stop-a", "stop-b"] {
        inspection_arguments_in(
            Some(directory.path()),
            &saved(id),
            connection_arguments(&saved(id), false),
        );
    }
    stop_connection("stop-a");
    assert!(take_masters(Some("stop-a")).is_empty());
    assert_eq!(take_masters(Some("stop-b")).len(), 1);
}
