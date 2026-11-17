use std::io::Cursor;
use std::sync::{
    Barrier,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

use super::*;

const RESOURCE_OUTPUT: &str = "cpu_total_1=1000\n\
cpu_idle_1=800\n\
cpu_total_2=1200\n\
cpu_idle_2=950\n\
cores=4\n\
load=0.15 0.32 0.41\n\
memtotal=8123456\n\
memavailable=5123456\n\
swaptotal=1048576\n\
swapfree=1048576\n";

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

fn posix_shell() -> std::process::Command {
    #[cfg(windows)]
    {
        let bash = crate::local_shell::resolve_installed("git-bash").unwrap();
        let mut command = background_command(bash.program());
        command.args(["--noprofile", "--norc"]);
        command
    }
    #[cfg(not(windows))]
    background_command("sh")
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
fn reads_cpu_busy_share_from_the_two_proc_stat_samples() {
    let resources = parse_host_resources(RESOURCE_OUTPUT);
    assert_eq!(resources.cpu_percent, Some(25.0));
    assert_eq!(resources.core_count, Some(4));
    assert_eq!(resources.load1, Some(0.15));
    assert_eq!(resources.load15, Some(0.41));
    assert_eq!(resources.memory_total_kib, Some(8_123_456));
    assert_eq!(resources.memory_available_kib, Some(5_123_456));
    assert_eq!(resources.swap_free_kib, Some(1_048_576));
}

#[test]
#[cfg(windows)]
fn cpu_probe_does_not_double_count_guests_or_truncate_large_counters() {
    let command = resource_command().replace("/proc/stat", "\"$fixture\"");
    let script = format!(
        r#"fixture=$(mktemp)
trap 'rm -f "$fixture"' EXIT
printf 'cpu 4294967296 10 20 4294967296 10 20 30 40 100 20\n' > "$fixture"
{command}
"#
    );
    let mut process = posix_shell();
    process.args(["-c", &script]);
    let output = run_process(process, "cpu_fixture", None, COMMAND_TIMEOUT)
        .unwrap()
        .success_text()
        .unwrap();
    let values = parse_key_values(&output);
    assert_eq!(
        values.get("cpu_total_1").map(String::as_str),
        Some("8589934722")
    );
    assert_eq!(values.get("cpu_total_2"), values.get("cpu_total_1"));
    assert_eq!(
        values.get("cpu_idle_1").map(String::as_str),
        Some("4294967306")
    );
}

#[test]
fn reports_an_unmeasured_cpu_as_missing_rather_than_zero() {
    let resources = parse_host_resources("cores=2\nmemtotal=100\n");
    assert_eq!(resources.cpu_percent, None);
    assert_eq!(resources.core_count, Some(2));
}

#[test]
fn normalizes_the_supported_distribution_families() {
    for (id, like, expected) in [
        ("ubuntu", None, "debian"),
        ("rocky", Some("rhel centos fedora"), "rhel"),
        ("almalinux", Some("rhel centos fedora"), "rhel"),
        ("rhel", Some("fedora"), "rhel"),
        ("ol", Some("fedora"), "rhel"),
        ("centos", Some("rhel fedora"), "rhel"),
        ("fedora", None, "rhel"),
        ("amzn", Some("fedora"), "amazon"),
        ("opensuse-leap", Some("suse opensuse"), "suse"),
        ("sles", Some("suse"), "suse"),
        ("arch", None, "arch"),
        ("alpine", None, "alpine"),
    ] {
        assert_eq!(
            distribution_family(Some(id), like).as_deref(),
            Some(expected),
            "wrong family for {id}"
        );
    }
    assert_eq!(distribution_family(Some("gentoo"), None), None);
}

#[test]
fn capability_probe_has_busybox_fallbacks() {
    let command = capability_command();
    assert!(command.contains("/proc/uptime"));
    assert!(command.contains("test -r /etc/passwd"));
    assert!(command.contains("printf 'os_like=%s"));
}

#[test]
fn refuses_a_zero_width_window_instead_of_dividing_by_it() {
    let text = "cpu_total_1=500\ncpu_idle_1=400\ncpu_total_2=500\ncpu_idle_2=400\n";
    assert_eq!(parse_host_resources(text).cpu_percent, None);
}

#[test]
fn clamps_a_counter_reset_rather_than_reporting_negative_load() {
    let text = "cpu_total_1=100\ncpu_idle_1=90\ncpu_total_2=300\ncpu_idle_2=1000\n";
    let percent = parse_host_resources(text).cpu_percent.unwrap();
    assert!((0.0..=100.0).contains(&percent), "out of range: {percent}");
    assert_eq!(percent, 0.0);
}

#[test]
fn the_resource_read_touches_only_proc() {
    let command = resource_command();
    for probe in ["/proc/stat", "/proc/meminfo", "/proc/loadavg"] {
        assert!(command.contains(probe), "missing {probe}");
    }
    for forbidden in ["ps ", "docker", "systemctl", "journalctl", "sudo"] {
        assert!(!command.contains(forbidden), "unexpected {forbidden}");
    }
}

fn live_connection() -> SavedConnection {
    SavedConnection {
        id: "live-fixture".into(),
        display_name: "Linux fixture".into(),
        destination: std::env::var("CONTROL_ROOM_TEST_HOST")
            .expect("CONTROL_ROOM_TEST_HOST is required"),
        username: std::env::var("CONTROL_ROOM_TEST_USER").ok(),
        port: std::env::var("CONTROL_ROOM_TEST_PORT")
            .ok()
            .and_then(|value| value.parse().ok()),
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

#[test]
fn parses_and_sorts_systemd_units_across_supported_types() {
    let units = parse_systemd_units(
        "Id=nginx.service\nDescription=nginx\nLoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n\nId=cleanup.timer\nDescription=Cleanup timer\nLoadState=loaded\nActiveState=failed\nSubState=failed\nUnitFileState=enabled\n\nId=data.mount\nDescription=Data mount\nLoadState=loaded\nActiveState=failed\nSubState=failed\nUnitFileState=generated\n\nId=api.socket\nDescription=API socket\nLoadState=loaded\nActiveState=active\nSubState=listening\nUnitFileState=enabled\n",
    );
    assert_eq!(units.len(), 4);
    assert_eq!(units[0].id, "data.mount");
    assert_eq!(units[1].id, "cleanup.timer");
    assert_eq!(units[2].unit_type, "service");
    assert_eq!(units[3].unit_type, "socket");
}

#[test]
fn ports_only_offers_navigation_to_units_the_systemd_view_lists() {
    let text = concat!(
        "tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* ",
        "users:((\"sshd\",pid=1276,fd=3))
",
        "tcp LISTEN 0 4096 0.0.0.0:2375 0.0.0.0:* ",
        "users:((\"systemd\",pid=1,fd=120))
",
        "
__CONTROL_ROOM_PROCESS_UNITS__
",
        "1276 ssh.service sshd
",
        "1 init.scope systemd
",
    );
    let sockets = parse_listening_sockets(text).unwrap();

    let ssh = sockets.iter().find(|s| s.port == 22).expect("port 22");
    assert_eq!(ssh.systemd_unit.as_deref(), Some("ssh.service"));

    let activated = sockets.iter().find(|s| s.port == 2375).expect("port 2375");
    assert_eq!(activated.process_name.as_deref(), Some("systemd"));
    assert_eq!(activated.systemd_unit, None);

    assert!(is_navigable_systemd_unit("ssh.service"));
    assert!(is_navigable_systemd_unit("srv-data.mount"));
    assert!(!is_navigable_systemd_unit("init.scope"));
    assert!(!is_navigable_systemd_unit("user.slice"));
    assert!(!is_navigable_systemd_unit("multi-user.target"));
    assert!(validate_systemd_unit_id("init.scope").is_ok());
    assert!(validate_systemd_unit_id("multi-user.target").is_ok());
}

#[test]
fn ignores_unsupported_or_malformed_systemd_units() {
    let units = parse_systemd_units(
        "Id=multi-user.target\nActiveState=active\n\nId=missing-suffix\nActiveState=failed\n",
    );
    assert!(units.is_empty());
}

#[test]
fn systemd_unit_listing_is_bounded_and_read_only() {
    let command = systemd_unit_list_command();
    assert!(command.contains("--type=service,timer,mount,socket"));
    assert!(
        command.contains("--property=Id,Description,LoadState,ActiveState,SubState,UnitFileState")
    );
    for mutation in [
        " start ",
        " stop ",
        " restart ",
        " reset-failed ",
        " enable ",
        " disable ",
    ] {
        assert!(!command.contains(mutation));
    }
}

#[test]
fn parses_tcp_udp_address_families_owners_and_shared_ports() {
    let sockets = parse_listening_sockets(
        "tcp LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:((\"nginx\",pid=742,fd=6))\n\
         tcp LISTEN 0 511 [::]:443 [::]:* users:((\"nginx\",pid=742,fd=7))\n\
         udp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*\n\
         tcp LISTEN 0 64 127.0.0.1:8080 0.0.0.0:* users:((\"worker-a\",pid=900,fd=3),(\"worker-b\",pid=901,fd=3))\n\
         __CONTROL_ROOM_PROCESS_UNITS__\n\
         742 nginx.service nginx\n\
         900 worker-a.scope worker-a\n",
    )
    .unwrap();

    assert_eq!(sockets.len(), 4);
    assert_eq!(
        sockets.iter().filter(|socket| socket.port == 443).count(),
        2
    );
    assert_eq!(sockets[0].protocol, "udp");
    assert_eq!(sockets[0].address_family, "ipv4");
    assert_eq!(sockets[0].ownership, "unavailable");
    assert_eq!(sockets[1].systemd_unit.as_deref(), Some("nginx.service"));
    assert_eq!(sockets[2].address_family, "ipv6");
    assert_eq!(sockets[3].ownership, "ambiguous");
    assert_eq!(sockets[3].process_id, None);
    assert_eq!(sockets[3].systemd_unit, None);
}

#[test]
fn socket_activated_sshd_is_owned_by_sshd_not_by_systemd() {
    let text = concat!(
        "tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* ",
        "users:((\"sshd\",pid=1276,fd=3),(\"systemd\",pid=1,fd=94))
",
        "
__CONTROL_ROOM_PROCESS_UNITS__
",
        "1276 ssh.service sshd
",
    );
    let sockets = parse_listening_sockets(text).unwrap();
    let ssh = &sockets[0];
    assert_eq!(ssh.ownership, "known");
    assert_eq!(ssh.process_id, Some(1276));
    assert_eq!(ssh.process_name.as_deref(), Some("sshd"));
    assert_eq!(ssh.systemd_unit.as_deref(), Some("ssh.service"));
}

#[test]
fn a_socket_waiting_on_activation_still_reports_systemd() {
    let text = concat!(
        "tcp LISTEN 0 4096 0.0.0.0:2375 0.0.0.0:* ",
        "users:((\"systemd\",pid=1,fd=120))
",
        "
__CONTROL_ROOM_PROCESS_UNITS__
",
    );
    let sockets = parse_listening_sockets(text).unwrap();
    assert_eq!(sockets[0].ownership, "known");
    assert_eq!(sockets[0].process_name.as_deref(), Some("systemd"));
}

#[test]
fn dropping_the_supervisor_does_not_invent_an_owner_for_real_rivals() {
    let text = concat!(
        "tcp LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:* ",
        "users:((\"nginx\",pid=900,fd=6),(\"haproxy\",pid=901,fd=7),(\"systemd\",pid=1,fd=9))
",
        "
__CONTROL_ROOM_PROCESS_UNITS__
",
    );
    let sockets = parse_listening_sockets(text).unwrap();
    assert_eq!(sockets[0].ownership, "ambiguous");
    assert_eq!(sockets[0].process_id, None);
}

#[test]
fn an_unelevated_read_reports_no_owner_at_all() {
    let text = concat!(
        "tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*
",
        "
__CONTROL_ROOM_PROCESS_UNITS__
",
    );
    let sockets = parse_listening_sockets(text).unwrap();
    assert_eq!(sockets[0].ownership, "unavailable");
    assert_eq!(sockets[0].process_name, None);
}

#[test]
fn a_process_merely_named_systemd_is_not_the_supervisor() {
    let text = concat!(
        "udp UNCONN 0 0 127.0.0.53:53 0.0.0.0:* ",
        "users:((\"systemd-resolve\",pid=673,fd=14),(\"unbound\",pid=674,fd=3))
",
        "
__CONTROL_ROOM_PROCESS_UNITS__
",
    );
    let sockets = parse_listening_sockets(text).unwrap();
    assert_eq!(sockets[0].ownership, "ambiguous");
}

#[test]
fn shared_name_multiprocess_listener_keeps_the_process_name_but_not_ownership() {
    let sockets = parse_listening_sockets(
        "tcp LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:((\"nginx\",pid=742,fd=6),(\"nginx\",pid=743,fd=6),(\"nginx\",pid=744,fd=6))\n\
         __CONTROL_ROOM_PROCESS_UNITS__\n\
         742 nginx.service nginx\n",
    )
    .unwrap();

    assert_eq!(sockets.len(), 1);
    assert_eq!(sockets[0].process_name.as_deref(), Some("nginx"));
    assert_eq!(sockets[0].ownership, "ambiguous");
    assert_eq!(sockets[0].process_id, None);
    assert_eq!(sockets[0].systemd_unit, None);
}

#[test]
fn ignores_unix_and_malformed_socket_rows() {
    let sockets = parse_listening_sockets(
        "u_str LISTEN 0 4096 /run/dbus/system_bus_socket * 0\n\
         tcp LISTEN 0 128 127.0.0.1:* 0.0.0.0:*\n\
         __CONTROL_ROOM_PROCESS_UNITS__\n",
    )
    .unwrap();
    assert!(sockets.is_empty());
}

#[test]
fn port_listing_is_one_bounded_read_only_query_without_process_arguments() {
    let command = port_list_command();
    assert!(command.contains("ss -H -lntupO"));
    assert!(command.contains("ps -eo pid=,unit=,comm="));
    assert!(!command.contains("args="));
    for mutation in [" kill ", " rm ", " systemctl start ", " docker stop "] {
        assert!(!command.contains(mutation));
    }
}

#[test]
fn parses_ufw_status_rules_defaults_and_families() {
    let status = parse_firewall_status(
        "__CR_FW_BACKEND__\tufw\nStatus: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), disabled (routed)\nNew profiles: skip\n\nTo                         Action      From\n--                         ------      ----\n22/tcp                     ALLOW IN    Anywhere\n443                        ALLOW IN    Anywhere\n5432/tcp                   ALLOW IN    192.168.0.0/16\n22/tcp (v6)                ALLOW IN    Anywhere (v6)\n",
    );
    assert!(status.available);
    assert_eq!(status.backend.as_deref(), Some("ufw"));
    assert_eq!(status.active, Some(true));
    assert_eq!(status.default_incoming.as_deref(), Some("deny"));
    assert_eq!(status.rules.len(), 4);
    assert_eq!(status.rules[0].port, Some(22));
    assert_eq!(status.rules[0].protocol.as_deref(), Some("tcp"));
    assert_eq!(status.rules[0].from, "Anywhere");
    assert_eq!(status.rules[1].port, Some(443));
    assert_eq!(status.rules[1].protocol, None);
    assert_eq!(status.rules[2].from, "192.168.0.0/16");
    assert!(status.rules[3].ipv6);
}

#[test]
fn parses_firewalld_active_zone_numeric_ports_without_global_policy_claims() {
    let status = parse_firewall_status(
        "__CR_FW_BACKEND__\tfirewalld\n__CR_FW_STATE__\tactive\n__CR_FW_ZONE__\tpublic\t22/tcp 5353/udp\n",
    );
    assert!(status.available);
    assert_eq!(status.backend.as_deref(), Some("firewalld"));
    assert_eq!(status.active, Some(true));
    assert_eq!(status.default_incoming, None);
    assert_eq!(status.rules.len(), 4);
    assert_eq!(status.rules[0].from, "zone public");
    assert_eq!(status.rules[0].port, Some(22));
    assert_eq!(status.rules[0].protocol.as_deref(), Some("tcp"));
    assert!(!status.rules[0].ipv6);
    assert!(status.rules[1].ipv6);
}

#[test]
#[cfg(unix)]
fn firewalld_read_failures_do_not_become_empty_rule_sets() {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command as Shell;

    let script = firewall_status_command()
        .strip_prefix("env LC_ALL=C sh -c '")
        .and_then(|value| value.strip_suffix("'"))
        .expect("firewall command shell");
    let directory = tempfile::tempdir().unwrap();
    let mock = directory.path().join("firewall-cmd");
    std::fs::write(
        &mock,
        r#"#!/bin/sh
case "$1" in
  --state) exit 0;;
  --get-active-zones) test "$CR_FW_FAIL" = zones && exit 13; printf 'public\n  interfaces: eth0\n';;
  --zone=public) test "$CR_FW_FAIL" = ports && exit 14; printf '22/tcp\n';;
esac
"#,
    )
    .unwrap();
    std::fs::set_permissions(&mock, std::fs::Permissions::from_mode(0o755)).unwrap();

    for (failure, expected_status) in [("zones", 13), ("ports", 14)] {
        let output = Shell::new("/bin/sh")
            .arg("-c")
            .arg(script)
            .env("PATH", directory.path())
            .env("CR_FW_FAIL", failure)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(expected_status));
        assert!(!String::from_utf8_lossy(&output.stdout).contains(FIREWALL_ZONE_MARKER));
    }
}

#[test]
fn firewall_reports_unavailable_when_supported_frontends_are_missing() {
    let status = parse_firewall_status("__CR_FW_UNAVAILABLE__\n");
    assert!(!status.available);
    assert_eq!(status.backend, None);
    assert_eq!(status.active, None);
    assert!(status.rules.is_empty());
}

#[test]
fn capability_discovery_reports_sudo_as_a_fact_without_using_it() {
    let script = capability_command();
    assert!(script.contains("passwordless_sudo=true"));
    assert!(script.contains("passwordless_sudo=false"));
    assert!(script.contains("command -v sudo >/dev/null 2>&1 && sudo -n true"));
    assert!(script.contains("account_name=$(id -un"));
    assert!(!script.contains("sudo -n id"));
    assert!(!script.contains("sudo -n getent"));
}

#[test]
fn docker_reachable_only_under_sudo_is_recorded_separately() {
    let script = capability_command();
    assert!(script.contains("docker_accessible_with_sudo=true"));
    let direct = script.find("docker_accessible=true").expect("direct probe");
    let fallback = script
        .find("docker_accessible_with_sudo=true")
        .expect("sudo probe");
    assert!(direct < fallback);
    assert!(script.contains("sudo -n docker info"));
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
fn elevation_never_turns_a_read_into_a_write() {
    for command in [
        port_list_command(),
        firewall_status_command(),
        docker_container_list_command(),
    ] {
        for elevation in [
            Elevation::None,
            Elevation::Allowed,
            Elevation::Password(Zeroizing::new("hunter2".into())),
        ] {
            let elevated = elevated_command(command, &elevation);
            for mutation in [" rm ", " systemctl start", " docker rm", " ufw allow"] {
                assert!(!elevated.contains(mutation), "{elevated}");
            }
        }
    }
}

#[test]
fn firewall_command_is_read_only_and_probes_supported_frontends() {
    let command = firewall_status_command();
    assert!(command.contains("ufw status"));
    assert!(command.contains("firewall-cmd --state"));
    assert!(command.contains("firewall-cmd --zone=\"$zone\" --list-ports"));
    for mutation in [
        " ufw enable",
        " ufw disable",
        " ufw allow",
        " ufw deny",
        " ufw delete",
    ] {
        assert!(!command.contains(mutation));
    }
    for mutation in ["--add-", "--remove-", "--reload", "--runtime-to-permanent"] {
        assert!(!command.contains(mutation));
    }
}

#[test]
fn aggregates_established_connections_by_owner_and_port() {
    let text = "0 0 10.0.0.5:443 203.0.113.9:5001 users:((\"nginx\",pid=742,fd=8))\n\
         0 0 10.0.0.5:443 203.0.113.9:5002 users:((\"nginx\",pid=743,fd=9))\n\
         0 0 10.0.0.5:443 198.51.100.7:6100 users:((\"nginx\",pid=742,fd=10))\n\
         0 0 10.0.0.5:22 198.51.100.9:40001 users:((\"sshd\",pid=1200,fd=3))\n\
         __CONTROL_ROOM_PROCESS_UNITS__\n\
         742 nginx.service nginx\n\
         743 nginx.service nginx\n\
         1200 ssh.service sshd\n";
    let overview = parse_established_connections(text);
    assert_eq!(overview.total_established, 4);
    assert!(!overview.truncated);
    assert_eq!(overview.groups.len(), 2);
    let https = &overview.groups[0];
    assert_eq!(https.local_port, 443);
    assert_eq!(https.systemd_unit.as_deref(), Some("nginx.service"));
    assert_eq!(https.established, 3);
    assert_eq!(https.remote_address_count, 2);
    assert_eq!(https.remotes[0].address, "203.0.113.9");
    assert_eq!(https.remotes[0].count, 2);
    assert_eq!(https.process_id, None);
    let ssh = &overview.groups[1];
    assert_eq!(ssh.local_port, 22);
    assert_eq!(ssh.process_id, Some(1200));
}

#[test]
fn established_connections_parse_ipv6_and_tolerate_missing_ownership() {
    let text = "0 0 [2001:db8::1]:443 [2001:db8::99]:5001 \n\
         __CONTROL_ROOM_PROCESS_UNITS__\n";
    let overview = parse_established_connections(text);
    assert_eq!(overview.total_established, 1);
    assert_eq!(overview.groups.len(), 1);
    let group = &overview.groups[0];
    assert_eq!(group.local_port, 443);
    assert_eq!(group.process_name, None);
    assert_eq!(group.systemd_unit, None);
    assert_eq!(group.remotes[0].address, "2001:db8::99");
}

#[test]
fn connections_command_is_one_bounded_read_only_query() {
    let command = connections_command();
    assert!(command.contains("ss -H -tnp state established"));
    assert!(command.contains("head -n 4000"));
    assert!(!command.contains("args="));
    for mutation in [" kill ", " rm ", " ss -K", " tcpkill "] {
        assert!(!command.contains(mutation));
    }
}

#[test]
fn parses_docker_json_lines() {
    let container = parse_container(
        r#"{"ID":"abc","Names":"npmplus","Image":"docker.io/npmplus","State":"running","Status":"Up","Ports":"80/tcp","CreatedAt":"today","ComposeProject":"proxy","ComposeService":"gateway","ComposeContainerNumber":"2","ComposeOneoff":"False"}"#,
    )
    .unwrap();
    assert_eq!(container.name, "npmplus");
    assert_eq!(container.state, "running");
    assert_eq!(container.compose_project.as_deref(), Some("proxy"));
    assert_eq!(container.compose_service.as_deref(), Some("gateway"));
    assert_eq!(container.compose_container_number, Some(2));
    assert_eq!(container.compose_oneoff, Some(false));
}

#[test]
fn parses_unhealthy_compose_container_details_without_sensitive_values() {
    let id = "a".repeat(64);
    let json = r#"[{
            "Id":"__ID__","Name":"/gateway-1","Image":"sha256:abc",
            "Config":{
                "Image":"https://user:secret@registry.example/gateway:latest?token=hidden",
                "Env":["SECRET=should-not-surface"],
                "Cmd":["/bin/gateway","--serve"],
                "Labels":{
                    "com.docker.compose.project":"proxy",
                    "com.docker.compose.service":"gateway",
                    "com.docker.compose.container-number":"1",
                    "com.docker.compose.oneoff":"False"
                }
            },
            "State":{
                "Status":"running","Running":true,"Paused":false,"Restarting":false,
                "OOMKilled":false,"Dead":false,"ExitCode":0,
                "StartedAt":"2026-08-31T01:00:00Z","FinishedAt":"0001-01-01T00:00:00Z",
                "Health":{"Status":"unhealthy","FailingStreak":3,"Log":[{"Output":"boom"}]}
            },
            "HostConfig":{"RestartPolicy":{"Name":"unless-stopped","MaximumRetryCount":0}},
            "Mounts":[{"Type":"bind","Name":"","Source":"/host/secret","Destination":"/etc/gateway","RW":false,"Propagation":"rprivate"}],
            "NetworkSettings":{
                "Networks":{"proxy_default":{"IPAddress":"172.20.0.2","Gateway":"172.20.0.1","GlobalIPv6Address":"","IPv6Gateway":""}},
                "Ports":{"8443/tcp":[{"HostIp":"0.0.0.0","HostPort":"443"}]}
            }
        }]"#
    .replace("__ID__", &id);
    let details = parse_container_details(&json).unwrap();

    assert_eq!(details.id, id);
    assert_eq!(details.name, "gateway-1");
    assert_eq!(
        details.image_reference,
        "https://[redacted]@registry.example/gateway:latest"
    );
    assert_eq!(details.health_status.as_deref(), Some("unhealthy"));
    assert_eq!(details.failing_streak, Some(3));
    assert_eq!(details.finished_at, None);
    assert_eq!(details.compose_project.as_deref(), Some("proxy"));
    assert_eq!(details.compose_container_number, Some(1));
    assert_eq!(details.mounts[0].mount_type, "bind");
    assert_eq!(details.mounts[0].name, None);
    assert_eq!(
        details.networks[0].ipv4_address.as_deref(),
        Some("172.20.0.2")
    );
    assert_eq!(details.published_ports[0].host_port, 443);

    let serialized = serde_json::to_string(&details).unwrap();
    assert!(!serialized.contains("should-not-surface"));
    assert!(!serialized.contains("/host/secret"));
    assert!(!serialized.contains("boom"));
    assert!(!serialized.contains("secret@"));
}

#[test]
fn parses_stopped_non_compose_container_without_health_or_bindings() {
    let id = "b".repeat(64);
    let json = r#"[{
            "Id":"__ID__","Name":"/job","Image":"sha256:def",
            "Config":{"Image":"job:1","Labels":{}},
            "State":{
                "Status":"exited","Running":false,"Paused":false,"Restarting":false,
                "OOMKilled":true,"Dead":false,"ExitCode":137,
                "StartedAt":"2026-08-31T01:00:00Z","FinishedAt":"2026-08-31T01:05:00Z"
            },
            "HostConfig":{"RestartPolicy":{"Name":"no","MaximumRetryCount":0}},
            "Mounts":[],
            "NetworkSettings":{"Networks":{},"Ports":{"5000/tcp":null}}
        }]"#
    .replace("__ID__", &id);
    let details = parse_container_details(&json).unwrap();

    assert!(!details.running);
    assert!(details.oom_killed);
    assert_eq!(details.exit_code, 137);
    assert_eq!(details.health_status, None);
    assert_eq!(details.failing_streak, None);
    assert_eq!(details.compose_project, None);
    assert!(details.mounts.is_empty());
    assert!(details.networks.is_empty());
    assert!(details.published_ports.is_empty());
}

#[test]
fn container_inspection_uses_full_stable_id_and_avoids_templates_and_mutations() {
    let id = "c".repeat(64);
    assert!(validate_stable_container_id(&id).is_ok());
    assert!(validate_stable_container_id("short-id").is_err());
    let command = docker_container_inspect_command(&id);
    assert!(command.starts_with("docker inspect --type container -- "));
    assert!(command.ends_with(&format!("'{id}'")));
    assert!(!command.contains("--format"));
    assert!(!command.contains("{{"));
    for mutation in [" start ", " stop ", " restart ", " rm ", " exec "] {
        assert!(!command.contains(mutation));
    }
}

#[test]
fn a_container_terminal_execs_one_validated_container_through_the_host_pty() {
    let id = "d".repeat(64);
    let command = docker_exec_command(&id, false).unwrap();
    assert!(command.starts_with("printf '\\033]633;ControlRoom;connected\\007'; exec "));
    assert!(command.contains(&format!(
        "docker exec -it -e TERM=xterm-256color '{id}' sh -c '{CONTAINER_SHELL_SCRIPT}'"
    )));
    assert!(CONTAINER_SHELL_SCRIPT.contains("exec bash"));
    assert!(CONTAINER_SHELL_SCRIPT.contains("exec sh"));
    assert!(!CONTAINER_SHELL_SCRIPT.contains(['\'', '"']));
    assert!(!command.contains("sudo"));
    for mutation in [" rm ", " stop ", " restart ", " kill "] {
        assert!(!command.contains(mutation));
    }

    for rejected in [
        "short",
        "web",
        &format!("{id}'; reboot; '"),
        &"g".repeat(64),
    ] {
        assert!(docker_exec_command(rejected, false).is_err(), "{rejected}");
    }
}

#[test]
fn a_container_terminal_uses_sudo_only_when_allowed_and_the_daemon_needs_it() {
    let id = "e".repeat(64);
    let command = docker_exec_command(&id, true).unwrap();
    let direct = format!("then exec docker exec -it -e TERM=xterm-256color '{id}'");
    let elevated = format!("else exec sudo docker exec -it -e TERM=xterm-256color '{id}'");
    assert!(command.contains("if docker version >/dev/null 2>&1; "));
    assert!(command.contains(&direct));
    assert!(command.contains(&elevated));
    assert!(!command.contains("sudo -n"));
}

#[test]
fn reports_removed_containers_as_stale_selection() {
    assert!(is_missing_container(b"Error: No such object: abc"));
    assert!(!is_missing_container(b"permission denied"));
}

#[test]
fn rejects_incomplete_or_malformed_compose_identity() {
    let missing_service = parse_container(
        r#"{"ID":"one","ComposeProject":"proxy","ComposeService":"","ComposeContainerNumber":"1","ComposeOneoff":"False"}"#,
    )
    .unwrap();
    let malformed_project = parse_container(
        r#"{"ID":"two","ComposeProject":"proxy/app","ComposeService":"gateway","ComposeContainerNumber":"1","ComposeOneoff":"True"}"#,
    )
    .unwrap();

    assert_eq!(missing_service.compose_project, None);
    assert_eq!(missing_service.compose_service, None);
    assert_eq!(malformed_project.compose_project, None);
    assert_eq!(malformed_project.compose_oneoff, None);
}

#[test]
fn container_listing_requests_only_selected_compose_labels() {
    let command = docker_container_list_command();
    assert!(command.contains("com.docker.compose.project"));
    assert!(command.contains("com.docker.compose.service"));
    assert!(command.contains("com.docker.compose.container-number"));
    assert!(command.contains("com.docker.compose.oneoff"));
    assert!(!command.contains(".Labels"));
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
fn docker_logs_merge_container_stderr_into_the_stream() {
    assert_eq!(
        docker_log_command("container-1", 200, true),
        "env LC_ALL=C docker logs --tail 200 --follow 'container-1' 2>&1"
    );
    assert_eq!(
        journal_command("ssh.service", 50, false),
        "env LC_ALL=C journalctl -u 'ssh.service' -n 50 --no-pager -o short-iso-precise"
    );
}

#[test]
fn stream_diagnostics_are_capped_but_fully_drained() {
    struct CountingReader {
        inner: Cursor<Vec<u8>>,
        read: Arc<AtomicUsize>,
    }

    impl Read for CountingReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let count = self.inner.read(buffer)?;
            self.read.fetch_add(count, Ordering::SeqCst);
            Ok(count)
        }
    }

    let total = STREAM_DIAGNOSTIC_LIMIT * 3;
    let read = Arc::new(AtomicUsize::new(0));
    let diagnostics = read_stream_diagnostics(
        CountingReader {
            inner: Cursor::new(vec![b'x'; total]),
            read: read.clone(),
        },
        |_| panic!("no notice expected"),
    );
    assert_eq!(diagnostics.len(), STREAM_DIAGNOSTIC_LIMIT);
    assert_eq!(read.load(Ordering::SeqCst), total);
}

#[test]
fn restricted_journal_hint_is_reported_once_while_the_stream_runs() {
    struct Trickle(Cursor<Vec<u8>>);
    impl Read for Trickle {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let limit = buffer.len().min(7);
            self.0.read(&mut buffer[..limit])
        }
    }
    let stderr = b"Hint: You are currently not seeing messages from other users and the system.\n      Users in groups 'adm', 'systemd-journal' can see all messages.\n      Pass -q to turn off this notice.\nHint: You are currently not seeing messages from other users and the system.\n";
    let mut notices = Vec::new();
    let diagnostics = read_stream_diagnostics(Trickle(Cursor::new(stderr.to_vec())), |notice| {
        notices.push(notice)
    });
    assert_eq!(notices, [StreamNotice::JournalRestricted]);
    assert_eq!(diagnostics, stderr);

    let mut unrelated = Vec::new();
    read_stream_diagnostics(
        Cursor::new(b"Failed to add filter for units: No data available\n".to_vec()),
        |notice| unrelated.push(notice),
    );
    assert!(unrelated.is_empty());
}

#[test]
fn requested_stream_stop_is_not_reported_as_a_failure() {
    assert_eq!(
        classify_stream_exit(true, None, false, 1, b"killed"),
        (StreamState::Stopped, None)
    );
    assert_eq!(
        classify_stream_exit(false, Some("pipe failed".into()), false, 1, b""),
        (StreamState::Error, Some("pipe failed".into()))
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

const HOSTILE_UNIT_NAMES: [&str; 20] = [
    "nginx.service; reboot",
    "nginx.service && reboot",
    "nginx.service | cat /etc/shadow",
    "nginx.service`id`",
    "nginx.service$(id)",
    "nginx'.service",
    "nginx\".service",
    "nginx .service",
    "nginx\t.service",
    "nginx\n.service",
    "nginx\r.service",
    "nginx\\.service",
    "../../etc/shadow.service",
    "*.service",
    "?.service",
    "$HOME.service",
    "nginx.service\u{0}",
    "nginx.service\u{7}",
    "nginx.servicé",
    "nginx.unknown",
];

#[test]
fn a_unit_name_a_host_invented_never_reaches_a_journal_command() {
    for unit in HOSTILE_UNIT_NAMES {
        let listed = parse_systemd_units(&format!(
            "Id={unit}\nDescription=x\nLoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n"
        ));

        assert!(
            validate_systemd_unit_id(unit).is_err(),
            "the log request accepted {unit:?} (listed: {})",
            !listed.is_empty()
        );
    }
}

#[test]
fn every_accepted_unit_id_stays_one_quoted_word_in_its_journal_command() {
    let accepted = [
        "nginx.service",
        "ssh.service",
        "user@1000.service",
        "getty@tty1.service",
        "systemd-journald.service",
        "multi-user.target",
        "dev-sda1.device",
        "swapfile.swap",
        "srv-data\\x2darchive.mount",
        "docker.socket",
        "logrotate.timer",
        "system-getty.slice",
        "session-3.scope",
        "proc-sys-fs-binfmt_misc.automount",
        "systemd-ask-password-wall.path",
        "a.service",
        "--user.service",
        "-u.service",
    ];
    let longest = format!("{}.service", "n".repeat(255 - ".service".len()));

    for unit in accepted
        .iter()
        .map(|unit| unit.to_string())
        .chain([longest])
    {
        assert!(
            validate_systemd_unit_id(&unit).is_ok(),
            "{unit:?} is an ordinary unit name"
        );
        assert!(
            !unit.contains('\''),
            "{unit:?} would close the quoted word around it"
        );

        let command = journal_command(&unit, 200, false);
        assert!(
            command.contains(&format!("-u '{unit}'")),
            "the unit is not the quoted argument of -u: {command}"
        );
        assert_eq!(
            command.matches('\'').count(),
            2,
            "the command has quoting the builder did not write: {command}"
        );
    }
}

#[test]
fn a_container_id_a_host_invented_never_reaches_a_docker_command() {
    for container in [
        "abc123; reboot",
        "abc123 && reboot",
        "abc123`id`",
        "abc123$(id)",
        "abc'123",
        "abc\"123",
        "abc 123",
        "abc\n123",
        "-abc123",
        "--rm",
        "../abc123",
        "*",
        "$HOME",
        "",
    ] {
        assert!(
            validate_container_id(container).is_err(),
            "the container request accepted {container:?}"
        );
    }

    for container in [
        "3f2b1c8a9d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8",
        "3F2B1C8A9D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8",
        "web-1",
        "my_app.service_1",
        "a",
    ] {
        assert!(
            validate_container_id(container).is_ok(),
            "{container:?} is an ordinary container identifier"
        );
        let command = docker_log_command(container, 200, true);
        assert!(
            command.contains(&format!("'{container}'")),
            "the container is not the quoted argument: {command}"
        );
        assert_eq!(command.matches('\'').count(), 2, "{command}");
    }
}

#[test]
fn a_log_tail_is_one_of_the_counts_the_app_offers() {
    assert!(!LOG_TAIL_OPTIONS.is_empty());
    for offered in LOG_TAIL_OPTIONS {
        assert!(validate_tail(offered).is_ok(), "{offered} is offered");
        for neighbour in [offered - 1, offered + 1] {
            if LOG_TAIL_OPTIONS.contains(&neighbour) {
                continue;
            }
            assert!(
                validate_tail(neighbour).is_err(),
                "{neighbour} is not a count the app offers"
            );
        }
    }
    assert!(validate_tail(0).is_err());
    assert!(validate_tail(u16::MAX).is_err());
}

#[test]
#[ignore = "requires an explicitly configured Linux SSH fixture"]
fn live_fixture_supports_structured_features() {
    let connection = live_connection();
    let capabilities = discover_capabilities(&connection).unwrap();
    if let Ok(expected) = std::env::var("CONTROL_ROOM_TEST_OS_ID") {
        assert_eq!(capabilities.os_id.as_deref(), Some(expected.as_str()));
    }
    assert!(
        capabilities.os_family.is_some(),
        "unrecognized distro family"
    );
    let resources = collect_host_resources(&connection).unwrap();
    assert!(resources.memory_total_kib.is_some());
    match list_firewall(&connection, Elevation::None) {
        Ok(firewall) => assert!(!firewall.available || firewall.active.is_some()),
        Err(error) => assert!(error.to_ascii_lowercase().contains("permission"), "{error}"),
    }
    if capabilities.systemd_available {
        let services = list_services(&connection).unwrap();
        assert!(!services.is_empty());
    }
    if std::env::var("CONTROL_ROOM_TEST_EXPECT_PORTS").as_deref() == Ok("true") {
        let _ports = list_ports(&connection, Elevation::None).unwrap();
        let _connections = list_connections(&connection, Elevation::None).unwrap();
    }
    if capabilities.docker_accessible {
        let _containers = list_containers(&connection, Elevation::None).unwrap();
    }
}

#[test]
#[ignore = "requires the explicitly configured local Ubuntu VM"]
fn live_ubuntu_structured_reads_return_typed_evidence() {
    let connection = live_connection();
    let capabilities = discover_capabilities(&connection).unwrap();
    assert_eq!(capabilities.connection_id, connection.id);
    assert_eq!(capabilities.os_id.as_deref(), Some("ubuntu"));
    assert!(capabilities.systemd_available);
    assert!(capabilities.journald_available);

    let resources = collect_host_resources(&connection).unwrap();
    assert!(resources.memory_total_kib.is_some_and(|value| value > 0));
    assert!(resources.core_count.is_some_and(|value| value > 0));
    assert!(
        resources
            .cpu_percent
            .is_some_and(|value| (0.0..=100.0).contains(&value))
    );

    let header = crate::header_metrics::collect_remote(
        &connection,
        &[
            crate::models::HeaderMetric::Cpu,
            crate::models::HeaderMetric::Ram,
            crate::models::HeaderMetric::Gpu,
            crate::models::HeaderMetric::Disk,
            crate::models::HeaderMetric::DiskIo,
            crate::models::HeaderMetric::Uptime,
        ],
    )
    .unwrap();
    assert!(
        header
            .cpu_percent
            .is_some_and(|value| (0.0..=100.0).contains(&value))
    );
    assert!(header.memory_total_kib.is_some_and(|value| value > 0));
    assert!(header.disk_total_kib.is_some_and(|value| value > 0));
    assert!(header.disk_free_kib.unwrap() <= header.disk_total_kib.unwrap());
    assert_eq!(header.disk_label.as_deref(), Some("/"));
    assert!(
        header
            .disk_read_bytes_per_second
            .is_some_and(|v| v.is_finite() && v >= 0.0)
    );
    assert!(
        header
            .disk_write_bytes_per_second
            .is_some_and(|v| v.is_finite() && v >= 0.0)
    );
    assert!(header.uptime_seconds.is_some());
    assert!(
        header
            .gpu_percent
            .is_none_or(|value| (0.0..=100.0).contains(&value))
    );

    let ram_only =
        crate::header_metrics::collect_remote(&connection, &[crate::models::HeaderMetric::Ram])
            .unwrap();
    assert!(ram_only.memory_total_kib.is_some_and(|value| value > 0));
    assert!(ram_only.memory_available_kib.is_some());
    assert_eq!(ram_only.cpu_percent, None);

    let services = list_services(&connection).unwrap();
    assert!(!services.is_empty());
    assert!(services.iter().all(|unit| !unit.id.is_empty()));

    let ports = list_ports(&connection, Elevation::None).unwrap();
    assert!(!ports.is_empty());
    assert!(ports.iter().all(|socket| socket.port > 0));

    let connections = list_connections(&connection, Elevation::None).unwrap();
    assert!(connections.total_established > 0);

    match list_firewall(&connection, Elevation::None) {
        Ok(firewall) => assert!(!firewall.available || firewall.active.is_some()),
        Err(error) => assert!(error.to_ascii_lowercase().contains("permission"), "{error}"),
    }

    if capabilities.docker_accessible {
        let containers = list_containers(&connection, Elevation::None).unwrap();
        if let Some(container) = containers.first() {
            let details = inspect_container(&connection, &container.id, Elevation::None).unwrap();
            assert_eq!(details.id, container.id);
        }
    } else {
        eprintln!(
            "Docker inspection was not exercised because this account cannot access Docker without sudo"
        );
    }
}
