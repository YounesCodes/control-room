use super::*;

fn connection() -> SavedConnection {
    SavedConnection {
        id: "sftp-fixture".into(),
        display_name: "Fixture".into(),
        destination: "example".into(),
        username: Some("tester".into()),
        port: Some(2222),
        identity_file: None,
        history_enabled: false,
        sudo_enabled: false,
        group_id: None,
        tags: vec![],
        created_at: String::new(),
        updated_at: String::new(),
        last_connected_at: None,
    }
}

#[test]
fn subsystem_uses_saved_ssh_arguments_and_never_starts_a_shell() {
    let args = sftp::arguments(&connection());
    for pair in [["-o", "BatchMode=yes"], ["-l", "tester"], ["-p", "2222"]] {
        assert!(args.windows(2).any(|w| w == pair));
    }
    assert!(args.ends_with(&["-s".into(), "--".into(), "example".into(), "sftp".into()]));
}

#[test]
fn paths_are_literal_absolute_and_confined_to_the_chosen_folder() {
    assert_eq!(remote_path(r"C:\Users\name").unwrap(), "/C:/Users/name");
    assert_eq!(remote_path("D:/").unwrap(), "/D:/");
    assert_eq!(remote_child("/", "-a '[x]*").unwrap(), "/-a '[x]*");
    assert!(remote_child("/C:/Users/test", r"..\outside").is_err());
    assert!(remote_child("/C:/Users/test", "file:stream").is_err());
    for path in ["-o", "", "../etc", "/tmp/x\n", "C:relative"] {
        assert!(remote_path(path).is_err());
    }
    let folder = std::env::temp_dir();
    for name in [".", "..", "../bad", "/bad", "sub/file"] {
        assert!(download_destination(&folder, name).is_err());
    }
    #[cfg(windows)]
    for name in ["x:stream", "CON.txt", r"..\bad", "LPT1"] {
        assert!(download_destination(&folder, name).is_err());
    }
}

#[test]
#[ignore = "requires an explicitly configured Linux SSH fixture"]
fn live_file_round_trip() {
    let mut connection = connection();
    connection.destination = std::env::var("CONTROL_ROOM_TEST_HOST").unwrap();
    connection.username = std::env::var("CONTROL_ROOM_TEST_USER").ok();
    connection.port = std::env::var("CONTROL_ROOM_TEST_PORT")
        .ok()
        .and_then(|v| v.parse().ok());
    let mut client = Sftp::connect(&connection).unwrap();
    let local = tempfile::tempdir().unwrap();
    let name = format!("control-room-{} 'sample [1].bin", Uuid::new_v4());
    let source = local.path().join(&name);
    let data: Vec<u8> = (0..175_000).map(|n| (n % 251) as u8).collect();
    fs::write(&source, &data).unwrap();
    let mut spec = Transfer {
        id: Uuid::new_v4(),
        direction: Direction::Upload,
        local_path: source,
        remote_path: "/tmp".into(),
        replace: false,
    };
    let cancel = AtomicBool::new(false);
    let mut meter = Meter {
        cancel: &cancel,
        notify: &|_| {},
        start: Instant::now(),
        last: None,
    };
    let remote = format!("/tmp/{name}");
    let check = (|| -> io::Result<()> {
        assert_eq!(upload(&mut client, &spec, &mut meter)?, Outcome::Complete);
        assert_eq!(upload(&mut client, &spec, &mut meter)?, Outcome::Exists);
        spec.replace = true;
        cancel.store(true, Ordering::Release);
        assert!(upload(&mut client, &spec, &mut meter).is_err());
        cancel.store(false, Ordering::Release);
        assert_eq!(upload(&mut client, &spec, &mut meter)?, Outcome::Complete);
        assert!(
            list(&mut client, Some("/tmp"))?
                .entries
                .iter()
                .any(|e| e.name == name && e.size == Some(data.len() as u64))
        );
        spec.direction = Direction::Download;
        spec.local_path = local.path().join("received");
        fs::create_dir(&spec.local_path)?;
        spec.remote_path = remote.clone();
        spec.replace = false;
        assert_eq!(download(&mut client, &spec, &mut meter)?, Outcome::Complete);
        assert_eq!(download(&mut client, &spec, &mut meter)?, Outcome::Exists);
        assert_eq!(fs::read(spec.local_path.join(name))?, data);
        Ok(())
    })();
    client
        .status(sftp::REMOVE, &string(remote.as_bytes()))
        .unwrap();
    check.unwrap();
}
