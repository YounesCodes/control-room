#[cfg(windows)]
use std::{
    io::{Read, Write},
    time::Instant,
};
use std::{
    sync::{Arc, mpsc},
    time::Duration,
};

use portable_pty::CommandBuilder;
#[cfg(any(windows, target_os = "macos"))]
use portable_pty::{PtySize, native_pty_system};

use crate::models::{SessionEndCategory, SessionState};

use super::{
    CONNECTED_MARKER, MAX_UNACKNOWLEDGED_OUTPUT_BYTES, OUTPUT_READ_BUFFER_BYTES, OutputFlow,
    SessionManager, SessionMode, StartupTiming, TERMINAL_TYPE, TerminalFailureDetector, TerminalFailureHint,
    classify_local_exit, classify_session_exit, interactive_shell_command,
};

#[cfg(any(windows, target_os = "macos"))]
use super::map_pty_kill_result;

type Classification = (Option<TerminalFailureHint>, bool);

fn observe_chunked(stream: &[u8], boundaries: &[usize]) -> Classification {
    let mut detector = TerminalFailureDetector::default();
    let mut start = 0;
    for &end in boundaries {
        detector.observe(&stream[start..end]);
        start = end;
    }
    detector.observe(&stream[start..]);
    (detector.hint, detector.established())
}

fn classification_independent_of_chunking(name: &str, stream: &[u8]) -> Classification {
    let whole = observe_chunked(stream, &[]);
    for split in 1..stream.len() {
        assert_eq!(
            observe_chunked(stream, &[split]),
            whole,
            "{name}: a cut after byte {split} changed the classification"
        );
    }
    let every_byte = (1..stream.len()).collect::<Vec<_>>();
    assert_eq!(
        observe_chunked(stream, &every_byte),
        whole,
        "{name}: reading one byte at a time changed the classification"
    );
    whole
}

#[test]
fn the_terminal_type_is_requested_explicitly_without_clearing_the_environment() {
    unsafe { std::env::set_var("CONTROL_ROOM_ENV_PROBE", "kept") };
    let mut command = CommandBuilder::new("ssh.exe");
    command.env("TERM", TERMINAL_TYPE);

    assert_eq!(command.get_env("TERM").unwrap(), TERMINAL_TYPE);
    assert_eq!(
        command.get_env("CONTROL_ROOM_ENV_PROBE"),
        Some(std::ffi::OsStr::new("kept")),
        "setting TERM must merge into the inherited environment, not replace it"
    );
    unsafe { std::env::remove_var("CONTROL_ROOM_ENV_PROBE") };
}

#[test]
#[cfg(windows)]
fn conpty_success_with_stale_last_error_is_not_shown_as_a_failure() {
    assert!(map_pty_kill_result(Err(std::io::Error::from_raw_os_error(0))).is_ok());
    assert!(map_pty_kill_result(Err(std::io::Error::from_raw_os_error(6))).is_ok());
}

#[test]
fn terminal_failure_detection_handles_split_ssh_diagnostics() {
    let mut detector = TerminalFailureDetector::default();
    detector.observe(b"ssh: connect to host laptop port 22: Connection ref");
    detector.observe(b"used\r\n");
    assert_eq!(detector.hint, Some(TerminalFailureHint::ConnectionRefused));
}

#[test]
fn authentication_prompts_do_not_mark_a_terminal_connected() {
    let mut detector = TerminalFailureDetector::default();
    detector.observe(b"user@host's password: ");
    assert!(!detector.connected);
    detector.observe(b"\x1b]633;ControlRoom;con");
    assert!(!detector.connected);
    detector.observe(b"nected\x07");
    assert!(detector.connected);
}

#[test]
fn interactive_shells_emit_the_connection_marker_before_startup() {
    assert!(interactive_shell_command(false).contains("ControlRoom;connected"));
    assert!(interactive_shell_command(false).contains("${SHELL:-/bin/bash}"));
    assert!(interactive_shell_command(true).contains("CONTROL_ROOM_SHELL_INTEGRATION=1"));
}

#[test]
fn user_disconnect_is_not_reported_as_a_failure() {
    assert_eq!(
        classify_session_exit(
            true,
            None,
            false,
            1,
            Some(TerminalFailureHint::ConnectionLost),
            true,
        ),
        (
            SessionState::Disconnected,
            Some(SessionEndCategory::UserDisconnect),
            None
        )
    );
}

#[test]
fn a_startup_phrase_in_the_marker_chunk_does_not_block_establishment() {
    let mut detector = TerminalFailureDetector::default();
    detector.observe(
        format!(
            "{CONNECTED_MARKER}Welcome to Debian\r\n\
             run-parts: /etc/update-motd.d/50-motd-news: Permission denied\r\n"
        )
        .as_bytes(),
    );

    assert!(detector.connected, "the marker is in this chunk");
    assert_eq!(
        detector.hint,
        Some(TerminalFailureHint::Authentication),
        "the phrase still matches, which is exactly why the marker has to win"
    );
    assert!(
        detector.established(),
        "reaching the marker proves ssh authenticated and ran the remote command"
    );

    let (state, category, _) =
        classify_session_exit(false, None, false, 1, detector.hint, detector.established());
    assert_eq!(state, SessionState::Disconnected);
    assert_eq!(category, Some(SessionEndCategory::RemoteExit));
}

#[test]
fn losing_the_connection_in_the_marker_chunk_is_still_an_error() {
    let mut detector = TerminalFailureDetector::default();
    detector.observe(
        format!("{CONNECTED_MARKER}client_loop: send disconnect: Connection reset\r\n").as_bytes(),
    );

    assert!(detector.established());
    assert_eq!(detector.hint, Some(TerminalFailureHint::ConnectionLost));

    let (state, category, _) = classify_session_exit(
        false,
        None,
        false,
        255,
        detector.hint,
        detector.established(),
    );
    assert_eq!(state, SessionState::Error);
    assert_eq!(category, Some(SessionEndCategory::ConnectionLost));
}

#[test]
fn a_clean_remote_shell_exit_is_a_plain_disconnect() {
    for connected in [true, false] {
        assert_eq!(
            classify_session_exit(false, None, true, 0, None, connected),
            (
                SessionState::Disconnected,
                Some(SessionEndCategory::RemoteExit),
                Some("SSH session ended.".into())
            ),
            "connected: {connected}"
        );
    }
}

#[test]
fn a_failed_startup_is_never_established() {
    for diagnostic in [
        "user@host: Permission denied (publickey).",
        "ssh: Could not resolve hostname host: Name or service not known",
        "ssh: connect to host port 22: Connection refused",
        "ssh: connect to host port 22: Connection timed out",
        "Host key verification failed.",
    ] {
        let mut detector = TerminalFailureDetector::default();
        detector.observe(diagnostic.as_bytes());
        assert!(!detector.established(), "{diagnostic}");
        assert!(detector.hint.is_some(), "{diagnostic}");
    }
}

#[test]
fn a_connected_session_that_exits_nonzero_reports_the_shell_exit() {
    let mut detector = TerminalFailureDetector::default();
    detector.observe(CONNECTED_MARKER.as_bytes());
    detector.observe(b"ls: cannot open directory '/root': Permission denied\r\n");
    assert!(detector.connected);
    assert_eq!(detector.hint, Some(TerminalFailureHint::Authentication));

    let (state, category, reason) =
        classify_session_exit(false, None, false, 1, detector.hint, true);

    assert_eq!(state, SessionState::Disconnected);
    assert_eq!(category, Some(SessionEndCategory::RemoteExit));
    assert!(
        reason.as_deref().is_some_and(|reason| reason.contains("1")),
        "the shell's exit status is still worth reporting: {reason:?}"
    );
}

#[test]
fn a_session_that_never_connected_keeps_its_startup_category() {
    let mut detector = TerminalFailureDetector::default();
    detector.observe(b"user@host: Permission denied (publickey).\r\n");
    assert!(!detector.connected);

    let (state, category, _) = classify_session_exit(false, None, false, 255, detector.hint, false);

    assert_eq!(state, SessionState::Error);
    assert_eq!(category, Some(SessionEndCategory::Authentication));
}

#[test]
fn a_connected_session_that_loses_its_connection_is_still_an_error() {
    let (state, category, _) = classify_session_exit(
        false,
        None,
        false,
        255,
        Some(TerminalFailureHint::ConnectionLost),
        true,
    );

    assert_eq!(state, SessionState::Error);
    assert_eq!(category, Some(SessionEndCategory::ConnectionLost));
}

#[test]
fn authentication_failure_has_a_distinct_error_category() {
    let (state, category, reason) = classify_session_exit(
        false,
        None,
        false,
        255,
        Some(TerminalFailureHint::Authentication),
        false,
    );
    assert_eq!(state, SessionState::Error);
    assert_eq!(category, Some(SessionEndCategory::Authentication));
    assert!(reason.unwrap().starts_with("SSH authentication failed"));
}

#[test]
fn classification_does_not_depend_on_where_pty_reads_are_cut() {
    let long_banner = "motd line\r\n".repeat(60);
    assert!(
        long_banner.len() > 512,
        "this case exists to cross the detector's tail window"
    );

    let cases: [(&str, String, Classification); 8] = [
        ("marker alone", CONNECTED_MARKER.into(), (None, true)),
        (
            "marker beside a failing motd script",
            format!(
                "{CONNECTED_MARKER}Welcome to Debian\r\n\
                 run-parts: /etc/update-motd.d/50-motd-news: Permission denied\r\n"
            ),
            (Some(TerminalFailureHint::Authentication), true),
        ),
        (
            "marker after a banner longer than the tail window",
            format!("{long_banner}{CONNECTED_MARKER}"),
            (None, true),
        ),
        (
            "connection lost in the marker's own chunk",
            format!("{CONNECTED_MARKER}client_loop: send disconnect: Connection reset\r\n"),
            (Some(TerminalFailureHint::ConnectionLost), true),
        ),
        (
            "refused before any marker",
            "ssh: connect to host laptop port 22: Connection refused\r\n".into(),
            (Some(TerminalFailureHint::ConnectionRefused), false),
        ),
        (
            "host key rejected before any marker",
            "@@@@@@@@@@\r\nHost key verification failed.\r\n".into(),
            (Some(TerminalFailureHint::HostKey), false),
        ),
        (
            "name resolution failed before any marker",
            "ssh: Could not resolve hostname laptop: Name or service not known\r\n".into(),
            (Some(TerminalFailureHint::HostResolution), false),
        ),
        (
            "repeated misleading output after the marker",
            format!(
                "{CONNECTED_MARKER}$ ls /root\r\n\
                 ls: cannot open directory '/root': Permission denied\r\n\
                 $ ls /root\r\n\
                 ls: cannot open directory '/root': Permission denied\r\n"
            ),
            (Some(TerminalFailureHint::Authentication), true),
        ),
    ];

    for (name, stream, expected) in cases {
        assert_eq!(
            classification_independent_of_chunking(name, stream.as_bytes()),
            expected,
            "{name}"
        );
    }
}

#[test]
fn a_split_multibyte_character_hides_neither_the_marker_nor_a_diagnostic() {
    let stream = format!("Bienvenue à l'hôte →{CONNECTED_MARKER}ls: Permission denied\r\n");
    let bytes = stream.as_bytes();

    for split in 1..bytes.len() {
        assert_eq!(
            observe_chunked(bytes, &[split]),
            (Some(TerminalFailureHint::Authentication), true),
            "a cut after byte {split} changed the classification"
        );
    }

    let mut hostile = vec![0xff, 0xfe, 0x80];
    hostile.extend_from_slice(CONNECTED_MARKER.as_bytes());
    hostile.extend_from_slice(&[0x80, 0xff]);
    assert_eq!(
        classification_independent_of_chunking("invalid utf-8 around the marker", &hostile),
        (None, true)
    );
}

#[test]
fn only_the_full_marker_establishes_a_session() {
    for near_miss in [
        "633;ControlRoom;connected",
        "\u{1b}]633;ControlRoom;connected",
        "]633;ControlRoom;connected\u{7}",
        "\u{1b}]633;ControlRoom;connecting\u{7}",
        "\u{1b}]633;ControlRoom;connected\u{8}",
    ] {
        let mut detector = TerminalFailureDetector::default();
        detector.observe(near_miss.as_bytes());
        assert!(
            !detector.established(),
            "{near_miss:?} is not the connected marker"
        );
    }
}

#[test]
fn a_user_disconnect_outranks_the_failure_its_own_teardown_causes() {
    assert_eq!(
        classify_session_exit(
            true,
            Some("Terminal output channel closed".into()),
            false,
            255,
            Some(TerminalFailureHint::ConnectionLost),
            true,
        ),
        (
            SessionState::Disconnected,
            Some(SessionEndCategory::UserDisconnect),
            None
        )
    );
    assert_eq!(
        classify_local_exit(
            true,
            Some("Terminal output channel closed".into()),
            false,
            255,
            "Git Bash",
        ),
        (
            SessionState::Disconnected,
            Some(SessionEndCategory::UserStop),
            None
        )
    );
}

#[test]
fn startup_hints_stop_counting_once_a_session_is_established() {
    let startup_only = [
        TerminalFailureHint::Authentication,
        TerminalFailureHint::HostResolution,
        TerminalFailureHint::ConnectionRefused,
        TerminalFailureHint::ConnectionTimeout,
        TerminalFailureHint::HostKey,
    ];

    for hint in startup_only {
        let (state, category, reason) =
            classify_session_exit(false, None, false, 42, Some(hint), true);
        assert_eq!(state, SessionState::Disconnected, "{hint:?}");
        assert_eq!(category, Some(SessionEndCategory::RemoteExit), "{hint:?}");
        assert_eq!(
            reason.as_deref(),
            Some("The remote shell exited with code 42."),
            "{hint:?}"
        );

        let (state, category, _) = classify_session_exit(false, None, false, 42, Some(hint), false);
        assert_eq!(state, SessionState::Error, "{hint:?}");
        assert_ne!(category, Some(SessionEndCategory::RemoteExit), "{hint:?}");
    }

    let (state, category, _) = classify_session_exit(
        false,
        None,
        false,
        42,
        Some(TerminalFailureHint::ConnectionLost),
        true,
    );
    assert_eq!(
        (state, category),
        (
            SessionState::Error,
            Some(SessionEndCategory::ConnectionLost)
        )
    );
}

#[test]
fn a_failed_startup_with_no_recognised_diagnostic_is_still_an_error() {
    let (state, category, reason) = classify_session_exit(false, None, false, 255, None, false);
    assert_eq!(state, SessionState::Error);
    assert_eq!(category, Some(SessionEndCategory::RemoteExit));
    assert_eq!(
        reason.as_deref(),
        Some("SSH session ended unexpectedly (exit code 255)")
    );
}

#[test]
fn every_ssh_failure_category_reports_the_exit_status() {
    for hint in [
        None,
        Some(TerminalFailureHint::Authentication),
        Some(TerminalFailureHint::HostResolution),
        Some(TerminalFailureHint::ConnectionRefused),
        Some(TerminalFailureHint::ConnectionTimeout),
        Some(TerminalFailureHint::HostKey),
        Some(TerminalFailureHint::ConnectionLost),
    ] {
        let (state, category, reason) = classify_session_exit(false, None, false, 77, hint, false);
        assert_eq!(state, SessionState::Error, "{hint:?}");
        assert!(category.is_some(), "{hint:?}");
        assert!(
            reason
                .as_deref()
                .is_some_and(|reason| reason.contains("77")),
            "{hint:?}: {reason:?}"
        );
    }
}

#[test]
fn a_local_shell_exit_is_never_classified_as_an_ssh_failure() {
    for success in [true, false] {
        let (state, category, _) =
            classify_local_exit(false, None, success, 1, "Windows PowerShell");
        assert_eq!(state, SessionState::Disconnected, "success: {success}");
        assert_eq!(
            category,
            Some(SessionEndCategory::LocalExit),
            "success: {success}"
        );
    }
}

#[test]
fn operations_on_a_session_that_is_gone_report_it_rather_than_panicking() {
    let sessions = SessionManager::default();
    let missing = "11111111-1111-4111-8111-111111111111";

    for result in [
        sessions.write(missing, b"whoami\r"),
        sessions.resize(missing, 80, 24),
        sessions.close(missing),
    ] {
        assert_eq!(
            result.unwrap_err(),
            "Terminal Session is no longer active",
            "a stale session id has to be reported, not silently accepted"
        );
    }

    sessions.acknowledge_output(missing, 4096);
    sessions.close_all();
}

#[test]
fn terminal_output_waits_for_frontend_acknowledgement() {
    let flow = Arc::new(OutputFlow::new());
    assert!(flow.reserve(MAX_UNACKNOWLEDGED_OUTPUT_BYTES));
    let blocked_flow = flow.clone();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(blocked_flow.reserve(1));
    });

    assert!(receiver.recv_timeout(Duration::from_millis(50)).is_err());
    flow.acknowledge(1);
    assert!(receiver.recv_timeout(Duration::from_secs(1)).unwrap());
}

#[test]
fn closing_terminal_output_unblocks_a_waiting_reader() {
    let flow = Arc::new(OutputFlow::new());
    assert!(flow.reserve(MAX_UNACKNOWLEDGED_OUTPUT_BYTES));
    let blocked_flow = flow.clone();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(blocked_flow.reserve(1));
    });

    assert!(receiver.recv_timeout(Duration::from_millis(50)).is_err());
    flow.close();
    assert!(!receiver.recv_timeout(Duration::from_secs(1)).unwrap());
}

#[test]
fn the_output_cap_admits_exactly_its_limit() {
    let flow = OutputFlow::new();
    assert!(flow.reserve(MAX_UNACKNOWLEDGED_OUTPUT_BYTES - 1));
    flow.acknowledge(MAX_UNACKNOWLEDGED_OUTPUT_BYTES - 1);
    assert!(flow.reserve(MAX_UNACKNOWLEDGED_OUTPUT_BYTES));

    flow.acknowledge(1);
    assert!(flow.reserve(1));
}

#[test]
fn one_pty_read_always_fits_under_the_output_cap() {
    const {
        assert!(OUTPUT_READ_BUFFER_BYTES < MAX_UNACKNOWLEDGED_OUTPUT_BYTES);
    }

    let flow = Arc::new(OutputFlow::new());
    let reader = flow.clone();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(reader.reserve(OUTPUT_READ_BUFFER_BYTES));
    });
    assert_eq!(receiver.recv_timeout(Duration::from_secs(5)), Ok(true));
}

#[test]
fn over_acknowledgement_cannot_underflow_the_outstanding_total() {
    let flow = Arc::new(OutputFlow::new());
    assert!(flow.reserve(1_024));
    flow.acknowledge(usize::MAX);
    flow.acknowledge(4_096);

    let drained = flow.clone();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(drained.reserve(MAX_UNACKNOWLEDGED_OUTPUT_BYTES));
    });
    assert_eq!(
        receiver.recv_timeout(Duration::from_secs(5)),
        Ok(true),
        "the flow has to be empty again after being over-acknowledged"
    );
}

#[test]
fn closing_the_output_flow_repeatedly_is_harmless() {
    let flow = OutputFlow::new();
    flow.close();
    flow.close();
    flow.acknowledge(4_096);
    assert!(
        !flow.reserve(1),
        "a closed flow refuses new bytes rather than blocking the reader"
    );
    flow.close();
    assert!(!flow.reserve(1));
}

#[test]
fn a_producer_arriving_after_close_does_not_block() {
    let flow = Arc::new(OutputFlow::new());
    assert!(flow.reserve(MAX_UNACKNOWLEDGED_OUTPUT_BYTES));
    flow.close();

    let late = flow.clone();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(late.reserve(1));
    });
    assert_eq!(
        receiver.recv_timeout(Duration::from_secs(5)),
        Ok(false),
        "reserve after close has to return, not wait"
    );
}

#[test]
fn a_blocked_producer_resumes_only_once_enough_has_drained() {
    let flow = Arc::new(OutputFlow::new());
    assert!(flow.reserve(MAX_UNACKNOWLEDGED_OUTPUT_BYTES));

    let blocked = flow.clone();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(blocked.reserve(4_096));
    });

    for _ in 0..8 {
        flow.acknowledge(256);
        assert!(
            receiver.recv_timeout(Duration::from_millis(20)).is_err(),
            "2048 acknowledged bytes cannot admit a 4096-byte reservation"
        );
    }

    flow.acknowledge(4_096);
    assert_eq!(receiver.recv_timeout(Duration::from_secs(5)), Ok(true));
}

#[cfg(windows)]
#[test]
fn conpty_runs_a_console_process() {
    let pair = native_pty_system().openpty(PtySize::default()).unwrap();
    let mut command = CommandBuilder::new("cmd.exe");
    command.args(["/Q", "/D", "/C", "echo CONTROL_ROOM_CONPTY_OK"]);
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            let _ = sender.send(buffer[..count].to_vec());
        }
    });
    let first_output = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
    if first_output.windows(4).any(|window| window == b"\x1b[6n") {
        writer.write_all(b"\x1b[1;1R").unwrap();
        writer.flush().unwrap();
    }
    #[cfg(not(target_os = "linux"))]
    let killer = child.clone_killer();
    let (status_sender, status_receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = status_sender.send(child.wait());
    });
    let status = match status_receiver.recv_timeout(Duration::from_secs(5)) {
        Ok(result) => result.unwrap(),
        Err(error) => {
            let mut killer = killer;
            let _ = killer.kill();
            std::thread::sleep(Duration::from_millis(100));
            let output = first_output
                .iter()
                .copied()
                .chain(receiver.try_iter().flatten())
                .collect::<Vec<_>>();
            panic!(
                "ConPTY child did not exit: {error}; output={}",
                String::from_utf8_lossy(&output)
            );
        }
    };
    assert!(status.success());
    let mut output = first_output;
    let output_deadline = Instant::now() + Duration::from_secs(1);
    while !output
        .windows("CONTROL_ROOM_CONPTY_OK".len())
        .any(|window| window == b"CONTROL_ROOM_CONPTY_OK")
        && Instant::now() < output_deadline
    {
        match receiver.recv_timeout(Duration::from_millis(25)) {
            Ok(chunk) => output.extend(chunk),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    assert!(String::from_utf8_lossy(&output).contains("CONTROL_ROOM_CONPTY_OK"));
}

#[test]
#[cfg(windows)]
fn process_exit_drains_conpty_output_before_closing_flow_control() {
    let pair = native_pty_system().openpty(PtySize::default()).unwrap();
    let mut command = CommandBuilder::new("cmd.exe");
    command.args([
        "/Q",
        "/D",
        "/C",
        "for /L %i in (1,1,2000) do @echo CONTROL_ROOM_DRAIN_%i",
    ]);
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let flow = Arc::new(OutputFlow::new());
    let reading_flow = flow.clone();
    let reading = std::thread::spawn(move || {
        let mut output = Vec::new();
        let mut buffer = [0; OUTPUT_READ_BUFFER_BYTES];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            if buffer[..count].windows(4).any(|bytes| bytes == b"\x1b[6n") {
                let _ = writer.write_all(b"\x1b[1;1R");
                let _ = writer.flush();
            }
            if !reading_flow.reserve(count) {
                break;
            }
            output.extend_from_slice(&buffer[..count]);
            reading_flow.acknowledge(count);
            std::thread::sleep(Duration::from_millis(1));
        }
        output
    });
    let (sender, receiver) = mpsc::channel();
    let mut killer = child.clone_killer();
    std::thread::spawn(move || {
        let status = child.wait().unwrap();
        assert!(status.success());
        let master = parking_lot::Mutex::new(Some(pair.master));
        let output = super::drain_pty_output(&master, reading, &flow).unwrap();
        let _ = sender.send(output);
    });
    let output = receiver
        .recv_timeout(Duration::from_secs(10))
        .unwrap_or_else(|error| {
            let _ = killer.kill();
            panic!("ConPTY output did not drain: {error}");
        });
    let output = String::from_utf8_lossy(&output);
    assert!(output.contains("CONTROL_ROOM_DRAIN_2000"));
    assert_eq!(output.matches("CONTROL_ROOM_DRAIN_").count(), 2000);
}

#[test]
fn a_local_shell_that_exits_keeps_the_workspace_and_reports_the_exit() {
    assert_eq!(
        classify_local_exit(false, None, true, 0, "PowerShell 7"),
        (
            SessionState::Disconnected,
            Some(SessionEndCategory::LocalExit),
            Some("PowerShell 7 exited.".into())
        )
    );
    assert_eq!(
        classify_local_exit(false, None, false, 1, "Git Bash"),
        (
            SessionState::Disconnected,
            Some(SessionEndCategory::LocalExit),
            Some("Git Bash exited with code 1.".into())
        )
    );
}

#[test]
fn stopping_a_local_shell_is_not_reported_as_a_failure() {
    assert_eq!(
        classify_local_exit(true, None, false, 1, "Command Prompt"),
        (
            SessionState::Disconnected,
            Some(SessionEndCategory::UserStop),
            None
        )
    );
}

#[test]
fn a_broken_local_pty_is_the_only_local_error_state() {
    let (state, category, reason) = classify_local_exit(
        false,
        Some("Terminal output failed: pipe closed".into()),
        false,
        1,
        "Git Bash",
    );
    assert_eq!(state, SessionState::Error);
    assert_eq!(category, Some(SessionEndCategory::Process));
    assert_eq!(
        reason.as_deref(),
        Some("Terminal output failed: pipe closed")
    );
}

#[test]
fn a_startup_log_line_splits_preparation_spawn_and_stage_time() {
    let requested_at = std::time::Instant::now();
    let timing = StartupTiming {
        requested_at,
        prepared_at: requested_at + Duration::from_millis(7),
        spawned_at: requested_at + Duration::from_millis(52),
    };
    let local = SessionMode::Local {
        label: "Command Prompt",
        shell_id: "cmd",
    };

    assert_eq!(
        timing.log_line(
            &local.startup_target(),
            "first_output",
            requested_at + Duration::from_millis(180),
        ),
        "[control-room] terminal_start target=local:cmd prepare_ms=7 spawn_ms=45 first_output_ms=180"
    );
    assert_eq!(
        timing.log_line(
            &SessionMode::ssh("11111111-1111-4111-8111-111111111111").startup_target(),
            "connected",
            requested_at + Duration::from_millis(900),
        ),
        "[control-room] terminal_start target=ssh prepare_ms=7 spawn_ms=45 connected_ms=900"
    );
}

#[test]
fn a_local_start_failure_names_the_shell_without_pty_internals() {
    let local = SessionMode::Local {
        label: "PowerShell 7",
        shell_id: "pwsh",
    };
    let remote = SessionMode::ssh("11111111-1111-4111-8111-111111111111");

    assert_eq!(
        local.spawn_error("os error 267: the directory name is invalid"),
        "PowerShell 7 could not be started."
    );
    assert!(
        remote
            .spawn_error("os error 2")
            .starts_with("SSH process could not start")
    );
}

#[test]
#[cfg(target_os = "macos")]
fn macos_login_shell_accepts_input_resizes_and_stops() {
    let shell = crate::local_shell::resolve_installed("zsh").unwrap();
    assert_eq!(shell.program(), std::path::Path::new("/bin/zsh"));
    let pair = native_pty_system().openpty(PtySize::default()).unwrap();
    let mut child = pair
        .slave
        .spawn_command(crate::local_shell::command_for(&shell))
        .unwrap();
    drop(pair.slave);
    pair.master
        .resize(PtySize {
            rows: 31,
            cols: 91,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut output = Vec::new();
        let mut buffer = [0; 4096];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            output.extend_from_slice(&buffer[..count]);
            if output
                .windows(b"MAC_PTY_READY".len())
                .any(|s| s == b"MAC_PTY_READY")
            {
                let _ = sender.send(output.clone());
            }
        }
    });
    writer
        .write_all(b"stty size; printf 'MAC_PTY_%s\\n' READY\n")
        .unwrap();
    writer.flush().unwrap();
    let mut killer = child.clone_killer();
    let output = receiver
        .recv_timeout(Duration::from_secs(10))
        .unwrap_or_else(|e| {
            let _ = killer.kill();
            panic!("macOS PTY did not answer typed input: {e}");
        });
    assert!(String::from_utf8_lossy(&output).contains("31 91"));
    assert!(map_pty_kill_result(killer.kill()).is_ok());
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(child.wait());
    });
    assert!(
        receiver
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .is_ok()
    );
}

#[test]
#[cfg(windows)]
fn a_resolved_local_shell_runs_and_stops_under_conpty() {
    let shell = crate::local_shell::resolve_installed("command-prompt").unwrap();
    let pair = native_pty_system().openpty(PtySize::default()).unwrap();
    let mut child = pair
        .slave
        .spawn_command(crate::local_shell::command_for(&shell))
        .unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            let _ = sender.send(buffer[..count].to_vec());
        }
    });

    let first_output = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(!first_output.is_empty());

    let mut writer = pair.master.take_writer().unwrap();
    let mut output = first_output.clone();
    let mut answered_queries = 0;
    let mut sent_command = false;
    let deadline = Instant::now() + Duration::from_secs(15);
    while !String::from_utf8_lossy(&output).contains("CONTROL_ROOM_LOCAL_OK")
        && Instant::now() < deadline
    {
        let query_count = output
            .windows(4)
            .filter(|window| *window == b"\x1b[6n")
            .count();
        while answered_queries < query_count {
            writer.write_all(b"\x1b[1;1R").unwrap();
            writer.flush().unwrap();
            answered_queries += 1;
        }
        if answered_queries > 0 && !sent_command {
            writer.write_all(b"echo CONTROL_ROOM_LOCAL_OK\r\n").unwrap();
            writer.flush().unwrap();
            sent_command = true;
        }
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(chunk) => output.extend(chunk),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    assert!(
        String::from_utf8_lossy(&output).contains("CONTROL_ROOM_LOCAL_OK"),
        "local shell did not answer typed input: {}",
        String::from_utf8_lossy(&output)
    );

    let mut killer = child.clone_killer();
    assert!(map_pty_kill_result(killer.kill()).is_ok());
    let (status_sender, status_receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = status_sender.send(child.wait());
    });
    let status = status_receiver
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    let (state, category, _) = classify_local_exit(
        true,
        None,
        status.success(),
        status.exit_code(),
        shell.label(),
    );
    assert_eq!(
        (state, category),
        (
            SessionState::Disconnected,
            Some(SessionEndCategory::UserStop)
        )
    );
}

#[cfg(windows)]
#[test]
#[ignore = "requires an explicitly configured Linux SSH fixture"]
fn native_pty_hosts_ssh_against_live_fixture() {
    let ssh_path = crate::ssh::detect_ssh_path().unwrap();
    let host = std::env::var("CONTROL_ROOM_TEST_HOST").unwrap();
    let user = std::env::var("CONTROL_ROOM_TEST_USER").unwrap();
    let port = std::env::var("CONTROL_ROOM_TEST_PORT").unwrap_or_else(|_| "22".into());
    let target = format!("{user}@{host}");
    let pair = native_pty_system().openpty(PtySize::default()).unwrap();
    let mut command = CommandBuilder::new(ssh_path);
    command.args([
        "-tt",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-p",
        &port,
        &target,
        "printf CONTROL_ROOM_SSH_OK; exit",
    ]);
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let (output_sender, output_receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            let _ = output_sender.send(buffer[..count].to_vec());
        }
    });
    let mut killer = child.clone_killer();
    let (status_sender, status_receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = status_sender.send(child.wait());
    });
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut output = Vec::new();
    let mut answered_queries = 0;
    let status = loop {
        if let Ok(chunk) = output_receiver.recv_timeout(Duration::from_millis(100)) {
            output.extend(chunk);
            let query_count = output
                .windows(4)
                .filter(|window| *window == b"\x1b[6n")
                .count();
            while answered_queries < query_count {
                writer.write_all(b"\x1b[1;1R").unwrap();
                writer.flush().unwrap();
                answered_queries += 1;
            }
        }
        if let Ok(result) = status_receiver.try_recv() {
            break result.unwrap();
        }
        if Instant::now() >= deadline {
            let _ = killer.kill();
            panic!(
                "Native PTY SSH fixture timed out: {}",
                String::from_utf8_lossy(&output)
            );
        }
    };
    assert!(status.success());
    assert!(String::from_utf8_lossy(&output).contains("CONTROL_ROOM_SSH_OK"));
}

#[test]
#[cfg(windows)]
#[ignore = "requires Git Bash and CONTROL_ROOM_TEST_OPENCODE_EXE"]
fn git_bash_survives_opencode_ctrl_c_exit() {
    assert_git_bash_survives_opencode_exit(true);
}

#[test]
#[cfg(windows)]
#[ignore = "requires Git Bash and CONTROL_ROOM_TEST_OPENCODE_EXE"]
fn git_bash_survives_opencode_slash_exit() {
    assert_git_bash_survives_opencode_exit(false);
}

#[cfg(windows)]
fn assert_git_bash_survives_opencode_exit(ctrl_c: bool) {
    let executable = std::env::var("CONTROL_ROOM_TEST_OPENCODE_EXE")
        .expect("Set CONTROL_ROOM_TEST_OPENCODE_EXE to the installed OpenCode executable");
    assert!(std::path::Path::new(&executable).is_file());
    let executable = executable.replace('\\', "/").replace('\'', "'\\''");
    let shell = crate::local_shell::resolve_installed("git-bash").unwrap();
    let directory = tempfile::tempdir().unwrap();
    let mut command = crate::local_shell::command_for(&shell);
    command.cwd(directory.path());
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            ..PtySize::default()
        })
        .unwrap();
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let mut killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = [0; 4096];
        loop {
            let result = reader
                .read(&mut buffer)
                .map(|count| buffer[..count].to_vec());
            let done = result.as_ref().map_or(true, Vec::is_empty);
            if sender.send(result).is_err() || done {
                break;
            }
        }
    });
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let collect = |writer: &mut dyn Write, duration: Duration| {
            let deadline = Instant::now() + duration;
            let mut bytes = Vec::new();
            let mut answered_queries = 0;
            while Instant::now() < deadline {
                if let Ok(chunk) = receiver.recv_timeout(Duration::from_millis(50)) {
                    let chunk = chunk.expect("PTY output read failed");
                    assert!(!chunk.is_empty(), "PTY output closed");
                    bytes.extend(chunk);
                    let queries = bytes.windows(4).filter(|part| *part == b"\x1b[6n").count();
                    while answered_queries < queries {
                        writer.write_all(b"\x1b[1;1R").unwrap();
                        answered_queries += 1;
                    }
                }
            }
            bytes
        };
        collect(&mut *writer, Duration::from_secs(2));
        writer
            .write_all(
                b"PS1='CONTROL_ROOM_PROMPT> '; PROMPT_COMMAND=; printf 'BEFORE_%s\\n' OPENCODE\r",
            )
            .unwrap();
        let before = collect(&mut *writer, Duration::from_secs(5));
        assert!(
            String::from_utf8_lossy(&before).contains("BEFORE_OPENCODE"),
            "Git Bash did not answer the initial input"
        );
        let launch = format!("'{executable}'\r");
        writer.write_all(launch.as_bytes()).unwrap();
        let opened = collect(&mut *writer, Duration::from_secs(8));
        assert!(
            opened.windows(6).any(|part| part == b"\x1b[?25l"),
            "OpenCode did not render its interface"
        );
        assert!(
            !String::from_utf8_lossy(&opened).contains("CONTROL_ROOM_PROMPT> "),
            "OpenCode exited before the quit command"
        );
        if ctrl_c {
            writer.write_all(b"\x03").unwrap();
            collect(&mut *writer, Duration::from_millis(500));
            writer.write_all(b"\x03").unwrap();
        } else {
            writer.write_all(b"/exit").unwrap();
            collect(&mut *writer, Duration::from_millis(500));
            writer.write_all(b"\r").unwrap();
        }
        let exited = collect(&mut *writer, Duration::from_secs(5));
        assert!(
            String::from_utf8_lossy(&exited).contains("CONTROL_ROOM_PROMPT> "),
            "OpenCode did not return to the Bash prompt"
        );
        assert!(
            child.try_wait().unwrap().is_none(),
            "Git Bash exited with OpenCode"
        );
        writer
            .write_all(b"printf 'AFTER_%s\\n' OPENCODE\r")
            .expect("input pipe broke after OpenCode exit");
        let after = collect(&mut *writer, Duration::from_secs(2));
        assert!(
            String::from_utf8_lossy(&after).contains("AFTER_OPENCODE"),
            "Git Bash did not accept input after OpenCode exit"
        );
    }));
    let _ = killer.kill();
    let _ = child.wait();
    drop(pair.master);
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}
