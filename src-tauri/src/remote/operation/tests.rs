use std::sync::{
    Barrier,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

use super::*;

#[test]
#[cfg(windows)]
fn sending_input_to_a_process_that_never_reads_it_is_bounded() {
    let mut command = background_command("powershell.exe");
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-Command",
        "[Threading.Thread]::Sleep(30000)",
    ]);
    let started = Instant::now();
    let error = run_process(
        command,
        "blocked_stdin_test",
        Some(&vec![b'x'; 1024 * 1024]),
        Duration::from_millis(250),
    )
    .unwrap_err();
    assert!(error.contains("timed out"), "{error}");
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn process_input_and_output_pipes_are_drained_concurrently() {
    let mut command = posix_shell();
    command.args([
        "-c",
        "head -c 131072 /dev/zero | tr '\\0' x; wc -c | tr -d ' '",
    ]);
    let output = run_process(
        command,
        "pipe_drain_test",
        Some(&vec![b'y'; 131072]),
        COMMAND_TIMEOUT,
    )
    .unwrap();
    assert_eq!(output.exit_code, 0);
    assert!(output.stdout.starts_with(&vec![b'x'; 131072]));
    assert_eq!(&output.stdout[131072..], b"131073\n");
}

#[test]
fn elevation_off_leaves_the_command_alone() {
    assert_eq!(
        elevated_command("ss -H -lntupO", &Elevation::None),
        "ss -H -lntupO"
    );
}

#[test]
fn allowed_elevation_uses_sudo_only_when_it_needs_no_password() {
    let command = elevated_command("ss -H -lntupO", &Elevation::Allowed);
    assert_eq!(
        command,
        "if sudo -n true 2>/dev/null; then sudo -n -- ss -H -lntupO; else ss -H -lntupO; fi"
    );
    assert!(!command.contains("sudo -S"));
}

#[test]
fn a_typed_password_goes_to_sudo_over_stdin_not_the_command_line() {
    let command = elevated_command(
        "ufw status verbose",
        &Elevation::Password(Zeroizing::new("hunter2".into())),
    );
    assert_eq!(
        command,
        "sudo -S -p '[control-room-sudo]' -- ufw status verbose"
    );
    assert!(!command.contains("hunter2"));
}

#[test]
fn a_typed_password_outranks_the_stored_permission() {
    assert!(matches!(
        Elevation::resolve(false, Some("hunter2".into())),
        Elevation::Password(_)
    ));
    assert!(matches!(
        Elevation::resolve(true, Some("hunter2".into())),
        Elevation::Password(_)
    ));
    assert!(matches!(Elevation::resolve(true, None), Elevation::Allowed));
    assert!(matches!(Elevation::resolve(false, None), Elevation::None));
}

#[test]
fn classifies_useful_ssh_errors() {
    assert!(classify_failure(255, b"Permission denied (publickey)").starts_with("Permission"));
    assert!(classify_failure(255, b"Connection refused").starts_with("Connection refused"));
    assert!(
        classify_failure(127, b"sh: 1: docker: not found").starts_with("Feature is not installed")
    );
}

#[test]
fn windows_docker_unavailable_errors_are_concise() {
    for (message, expected) in [
        (
            "Docker CLI was not found on this Windows host.",
            "Docker is not installed on this host.",
        ),
        (
            "Docker could not read the daemon. Check that Docker is running and this SSH account has access.",
            "Docker is unavailable. Check that it is running and this SSH account has access.",
        ),
    ] {
        for stderr in [
            message.to_string(),
            format!(
                "#< CLIXML\r\n<Objs Version=\"1.1.0.1\" xmlns=\"http://schemas.microsoft.com/powershell/2004/04\"><S S=\"Error\">{message}_x000D__x000A_</S><S S=\"Error\">At line:15 char:5_x000D__x000A_</S></Objs>"
            ),
        ] {
            assert_eq!(classify_failure(1, stderr.as_bytes()), expected);
        }
    }
}

#[test]
fn firewalld_authorization_errors_preserve_the_permission_retry() {
    for message in [
        "Authorization failed.
    Make sure polkit agent is running or run the application as superuser.",
        "Error: NOT_AUTHORIZED",
        "org.fedoraproject.FirewallD1.NotAuthorizedException",
    ] {
        assert_eq!(
            classify_failure(253, message.as_bytes()),
            format!("Permission denied: {message}")
        );
    }
    assert_eq!(
        classify_failure(253, b"unrelated command failure"),
        "Remote command failed: unrelated command failure"
    );
}

#[test]
#[cfg(windows)]
fn terminated_remote_children_are_reaped() {
    let mut child = background_command("powershell.exe")
        .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
        .spawn()
        .unwrap();
    terminate_child(&mut child);
    assert!(child.try_wait().unwrap().is_some());
}

#[test]
fn limits_parallel_structured_operations_per_connection() {
    let limiter = Arc::new(RemoteOperationLimiter::default());
    let start = Arc::new(Barrier::new(7));
    let active = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let mut workers = Vec::new();

    for _ in 0..6 {
        let limiter = limiter.clone();
        let start = start.clone();
        let active = active.clone();
        let maximum = maximum.clone();
        workers.push(thread::spawn(move || {
            start.wait();
            let _permit = limiter.acquire("connection-a").unwrap();
            let current = active.fetch_add(1, Ordering::SeqCst) + 1;
            maximum.fetch_max(current, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(25));
            active.fetch_sub(1, Ordering::SeqCst);
        }));
    }

    start.wait();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(maximum.load(Ordering::SeqCst), 2);
    assert_eq!(limiter.tracked_connections(), 0);
}

#[test]
fn queued_structured_operations_have_a_deadline() {
    let limiter = RemoteOperationLimiter::default();
    let first = limiter
        .acquire_for("connection-a", Duration::from_millis(10))
        .unwrap();
    let second = limiter
        .acquire_for("connection-a", Duration::from_millis(10))
        .unwrap();

    let error = limiter
        .acquire_for("connection-a", Duration::from_millis(10))
        .err()
        .expect("the third operation should time out");

    assert_eq!(error, "Remote operation queue was busy for 4 seconds");
    drop(first);
    drop(second);
    assert_eq!(limiter.tracked_connections(), 0);
}

#[test]
fn waking_a_queued_operation_does_not_extend_its_deadline() {
    const WAIT: Duration = Duration::from_millis(200);
    let limiter = Arc::new(RemoteOperationLimiter::default());
    let first = limiter.acquire_for("connection-a", WAIT).unwrap();
    let second = limiter.acquire_for("connection-a", WAIT).unwrap();

    let finished = Arc::new(AtomicBool::new(false));
    let waiter = thread::spawn({
        let limiter = limiter.clone();
        let finished = finished.clone();
        move || {
            let started = Instant::now();
            let outcome = limiter.acquire_for("connection-a", WAIT);
            finished.store(true, Ordering::SeqCst);
            (outcome.is_err(), started.elapsed())
        }
    });

    let churn_until = Instant::now() + WAIT * 8;
    while Instant::now() < churn_until && !finished.load(Ordering::SeqCst) {
        thread::sleep(WAIT / 5);
        limiter.wake_waiters("connection-a");
    }

    let (timed_out, elapsed) = waiter.join().unwrap();
    assert!(timed_out, "the queued operation should have timed out");
    assert!(
        elapsed < WAIT * 4,
        "queue wait was not bounded by its deadline: {elapsed:?}"
    );

    drop(first);
    drop(second);
    assert_eq!(limiter.tracked_connections(), 0);
}

#[test]
fn a_queued_operation_acquires_a_slot_freed_before_its_deadline() {
    const WAIT: Duration = Duration::from_secs(5);
    let limiter = Arc::new(RemoteOperationLimiter::default());
    let first = limiter.acquire_for("connection-a", WAIT).unwrap();
    let second = limiter.acquire_for("connection-a", WAIT).unwrap();

    let waiter = thread::spawn({
        let limiter = limiter.clone();
        move || limiter.acquire_for("connection-a", WAIT).is_ok()
    });

    thread::sleep(Duration::from_millis(50));
    drop(first);

    assert!(
        waiter.join().unwrap(),
        "a slot freed inside the budget should be handed to the waiter"
    );
    drop(second);
    assert_eq!(limiter.tracked_connections(), 0);
}

#[test]
fn the_limiter_forgets_a_connection_after_a_timeout_and_a_success() {
    const WAIT: Duration = Duration::from_millis(50);
    let limiter = RemoteOperationLimiter::default();

    let first = limiter.acquire_for("connection-a", WAIT).unwrap();
    let second = limiter.acquire_for("connection-a", WAIT).unwrap();
    assert!(limiter.acquire_for("connection-a", WAIT).is_err());
    assert_eq!(limiter.tracked_connections(), 1);

    drop(first);
    drop(second);
    assert_eq!(limiter.tracked_connections(), 0);

    drop(limiter.acquire_for("connection-a", WAIT).unwrap());
    assert_eq!(limiter.tracked_connections(), 0);
}

#[test]
fn a_saturated_connection_does_not_delay_a_different_one() {
    const WAIT: Duration = Duration::from_millis(50);
    let limiter = RemoteOperationLimiter::default();

    let first = limiter.acquire_for("connection-a", WAIT).unwrap();
    let second = limiter.acquire_for("connection-a", WAIT).unwrap();
    assert!(
        limiter.acquire_for("connection-a", WAIT).is_err(),
        "connection-a is saturated"
    );

    let third = limiter.acquire_for("connection-b", Duration::ZERO).unwrap();
    let fourth = limiter.acquire_for("connection-b", Duration::ZERO).unwrap();
    assert!(!third.shares_a_limit_with(&first));
    assert!(limiter.acquire_for("connection-b", WAIT).is_err());
    assert_eq!(limiter.tracked_connections(), 2);

    drop(third);
    drop(fourth);
    assert_eq!(limiter.tracked_connections(), 1);
    assert!(limiter.acquire_for("connection-a", WAIT).is_err());

    drop(first);
    drop(second);
    assert_eq!(limiter.tracked_connections(), 0);
}

#[test]
fn repeated_operations_leave_no_trace_of_the_connections_they_used() {
    let limiter = RemoteOperationLimiter::default();
    for round in 0..200 {
        let id = format!("connection-{}", round % 5);
        let first = limiter.acquire_for(&id, Duration::ZERO).unwrap();
        let second = limiter.acquire_for(&id, Duration::ZERO).unwrap();
        assert_eq!(second.live_on_its_limit(), 2, "round {round}");
        drop(first);
        drop(second);
        assert_eq!(
            limiter.tracked_connections(),
            0,
            "round {round} left an entry behind"
        );
    }
}

#[test]
fn a_connection_cannot_exceed_its_operation_limit_across_a_map_eviction() {
    const WAIT: Duration = Duration::from_secs(5);

    let armed = Arc::new(AtomicBool::new(false));
    let (reached_lookup, lookup_reached) = mpsc::channel();
    let (release_lookup, lookup_released) = mpsc::channel::<()>();
    let lookup_released = Arc::new(Mutex::new(lookup_released));
    let limiter = Arc::new(RemoteOperationLimiter::with_lookup_hook(Arc::new({
        let armed = armed.clone();
        move || {
            if armed.swap(false, Ordering::SeqCst) {
                reached_lookup.send(()).unwrap();
                lookup_released.lock().recv().unwrap();
            }
        }
    })));

    let first = limiter.acquire_for("connection-a", WAIT).unwrap();
    let second = limiter.acquire_for("connection-a", WAIT).unwrap();

    armed.store(true, Ordering::SeqCst);
    let queued = thread::spawn({
        let limiter = limiter.clone();
        move || limiter.acquire_for("connection-a", WAIT).unwrap()
    });

    lookup_reached.recv_timeout(WAIT).unwrap();

    drop(first);
    drop(second);

    release_lookup.send(()).unwrap();
    let third = queued.join().unwrap();

    let fourth = limiter.acquire_for("connection-a", WAIT).unwrap();

    assert!(
        third.shares_a_limit_with(&fourth),
        "two live permits for connection-a are counted against different \
         limits, so the per-connection cap bounds neither"
    );
    let live = if third.shares_a_limit_with(&fourth) {
        third.live_on_its_limit()
    } else {
        third.live_on_its_limit() + fourth.live_on_its_limit()
    };
    assert!(
        live <= MAX_STRUCTURED_OPERATIONS_PER_CONNECTION,
        "connection-a has {live} Structured Operations live at once, and the \
         cap is {MAX_STRUCTURED_OPERATIONS_PER_CONNECTION}"
    );
}
