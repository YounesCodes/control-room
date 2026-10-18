//! Exercise real updater HTTP and Minisign paths. Installation is opt-in and isolated.
//! The fixture contains only public material; its disposable private key was discarded.

#[path = "../src/updater_network.rs"]
mod network;

use network::{DOWNLOAD_TIMEOUT, check_with_download_timeout};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri_plugin_updater::{Updater, UpdaterExt};

struct Server {
    endpoint: String,
    stopped: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
        self.thread.take().unwrap().join().unwrap();
    }
}

fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!("../test-fixtures/updater.json")).unwrap()
}

fn server(legacy: bool, version: &str, manifest_delay: Duration, body_delay: Duration) -> Server {
    server_using(fixture(), legacy, version, manifest_delay, body_delay)
}

fn server_using(
    fixture: serde_json::Value,
    legacy: bool,
    version: &str,
    manifest_delay: Duration,
    body_delay: Duration,
) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/latest.json", listener.local_addr().unwrap());
    let signature = fixture[if legacy {
        "legacySignature"
    } else {
        "signature"
    }]
    .as_str()
    .unwrap();
    let manifest = serde_json::json!({
        "version": version,
        "url": endpoint.replace("latest.json", "installer.exe"),
        "signature": signature,
    })
    .to_string();
    let payload = match fixture["payloadPath"].as_str() {
        Some(path) => std::fs::read(path).unwrap(),
        None => fixture["payload"].as_str().unwrap().as_bytes().to_vec(),
    };
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    let thread = thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            let (mut stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(error) => panic!("HTTP fixture accept failed: {error}"),
            };
            // Windows inherits the listener's nonblocking mode on accept.
            // Read a complete request before replying instead of treating
            // WouldBlock as EOF and resetting a healthy client connection.
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let count = stream.read(&mut buffer).unwrap_or(0);
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..count]);
                assert!(request.len() <= 16 * 1024, "HTTP fixture header too large");
            }
            if request.is_empty() {
                continue;
            }
            let is_manifest = request.starts_with(b"GET /latest.json ");
            let body = if is_manifest {
                manifest.as_bytes()
            } else {
                &payload
            };
            if is_manifest {
                thread::sleep(manifest_delay);
            }
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            // Send part of the artifact before stalling, so the timeout also
            // covers an interrupted body rather than only response headers.
            let (first, rest) = body.split_at(usize::from(!is_manifest && !body.is_empty()));
            let _ = stream.write_all(first);
            let _ = stream.flush();
            if !is_manifest {
                thread::sleep(body_delay);
            }
            let _ = stream.write_all(rest);
        }
    });
    Server {
        endpoint,
        stopped,
        thread: Some(thread),
    }
}

fn app() -> tauri::App<tauri::test::MockRuntime> {
    app_using(&fixture())
}

fn app_using(fixture: &serde_json::Value) -> tauri::App<tauri::test::MockRuntime> {
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    // Use the production security settings. Only transport and the public key
    // differ, because this server is restricted to the loopback interface.
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let mut updater = config["plugins"]["updater"].clone();
    updater["pubkey"] = fixture["pubkey"].clone();
    updater["dangerousInsecureTransportProtocol"] = true.into();
    if let Some(directory) = fixture["installDirectory"].as_str() {
        updater["windows"]["installerArgs"] = serde_json::json!([format!("/D={directory}")]);
    }
    context
        .config_mut()
        .plugins
        .0
        .insert("updater".into(), updater);
    tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap()
}

fn updater(app: &tauri::App<tauri::test::MockRuntime>, server: &Server) -> Updater {
    app.updater_builder()
        .endpoints(vec![server.endpoint.parse().unwrap()])
        .unwrap()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap()
}

#[test]
fn slow_installer_download_outlives_the_short_manifest_timeout() {
    let server = server(false, "1.0.0", Duration::ZERO, Duration::from_secs(4));
    let app = app();
    tauri::async_runtime::block_on(async {
        let update = check_with_download_timeout(updater(&app, &server), DOWNLOAD_TIMEOUT)
            .await
            .unwrap()
            .unwrap();
        let bytes = update.download(|_, _| {}, || {}).await.unwrap();
        assert_eq!(bytes, fixture()["payload"].as_str().unwrap().as_bytes());
        assert_eq!(update.timeout, Some(DOWNLOAD_TIMEOUT));
    });
}

#[test]
fn slow_manifest_still_uses_the_short_check_timeout() {
    let server = server(false, "1.0.0", Duration::from_secs(4), Duration::ZERO);
    let app = app();
    let result = tauri::async_runtime::block_on(check_with_download_timeout(
        updater(&app, &server),
        DOWNLOAD_TIMEOUT,
    ));
    let Err(failure) = result else {
        panic!("a stalled manifest must time out")
    };
    assert!(matches!(failure, tauri_plugin_updater::Error::Reqwest(_)));
}

#[test]
fn signed_legacy_installer_cannot_be_replayed_as_a_new_release() {
    let server = server(true, "9.9.9", Duration::ZERO, Duration::ZERO);
    let app = app();
    tauri::async_runtime::block_on(async {
        let update = check_with_download_timeout(updater(&app, &server), DOWNLOAD_TIMEOUT)
            .await
            .unwrap()
            .unwrap();
        let error = update
            .download(|_, _| {}, || {})
            .await
            .expect_err("legacy signature must not bypass version binding");
        assert!(matches!(
            error,
            tauri_plugin_updater::Error::MissingSignedVersion
        ));
    });
}

#[test]
fn installer_signed_for_another_version_is_a_signature_failure() {
    let server = server(false, "9.9.9", Duration::ZERO, Duration::ZERO);
    let app = app();
    tauri::async_runtime::block_on(async {
        let update = check_with_download_timeout(updater(&app, &server), DOWNLOAD_TIMEOUT)
            .await
            .unwrap()
            .unwrap();
        let error = update
            .download(|_, _| {}, || {})
            .await
            .expect_err("manifest must match the signed version");
        assert!(matches!(
            error,
            tauri_plugin_updater::Error::SignedVersionMismatch { .. }
        ));
    });
}

#[test]
fn stalled_installer_download_respects_its_own_deadline() {
    let server = server(false, "1.0.0", Duration::ZERO, Duration::from_secs(4));
    let app = app();
    tauri::async_runtime::block_on(async {
        let update =
            check_with_download_timeout(updater(&app, &server), Duration::from_millis(100))
                .await
                .unwrap()
                .unwrap();
        let mut received_bytes = 0;
        let error = update
            .download(|chunk, _| received_bytes += chunk, || {})
            .await
            .expect_err("a stalled installer must time out");
        assert!(
            matches!(error, tauri_plugin_updater::Error::Reqwest(ref request) if request.is_timeout())
        );
        assert!(received_bytes > 0, "fixture must stall during the body");
    });
}

#[cfg(windows)]
#[test]
#[ignore = "run node scripts/test-updater-install.mjs to build the isolated NSIS fixture"]
fn isolated_signed_installer_replaces_only_the_fixture() {
    use std::process::Command;
    use std::time::Instant;
    use wait_timeout::ChildExt;

    let fixture_path = std::env::var_os("CONTROL_ROOM_UPDATER_INSTALL_FIXTURE")
        .expect("the updater installation harness must provide its signed fixture");
    let mut fixture: serde_json::Value =
        serde_json::from_slice(&std::fs::read(fixture_path).unwrap()).unwrap();
    if std::env::var_os("CONTROL_ROOM_UPDATER_INSTALL_CHILD").is_some() {
        let server = server_using(
            fixture.clone(),
            false,
            "1.0.0",
            Duration::ZERO,
            Duration::ZERO,
        );
        let app = app_using(&fixture);
        tauri::async_runtime::block_on(async {
            let update = check_with_download_timeout(updater(&app, &server), DOWNLOAD_TIMEOUT)
                .await
                .unwrap()
                .unwrap();
            let bytes = update.download(|_, _| {}, || {}).await.unwrap();
            update.install(bytes).unwrap();
            panic!("the Windows updater must exit after launching NSIS");
        });
    }

    let directory = tempfile::Builder::new()
        .prefix("control-room-updater-installed-")
        .tempdir()
        .unwrap();
    let marker = directory.path().join("installed.txt");
    std::fs::write(&marker, "previous fixture version").unwrap();
    fixture["installDirectory"] = directory.path().to_str().unwrap().into();
    let child_fixture = directory.path().join("fixture.json");
    std::fs::write(&child_fixture, serde_json::to_vec(&fixture).unwrap()).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "isolated_signed_installer_replaces_only_the_fixture",
            "--ignored",
            "--nocapture",
        ])
        .env("CONTROL_ROOM_UPDATER_INSTALL_CHILD", "1")
        .env("CONTROL_ROOM_UPDATER_INSTALL_FIXTURE", child_fixture)
        .spawn()
        .unwrap();
    let Some(status) = child.wait_timeout(Duration::from_secs(30)).unwrap() else {
        child.kill().unwrap();
        child.wait().unwrap();
        panic!("updater installer handoff timed out");
    };
    assert!(status.success(), "updater child failed: {status}");
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if std::fs::read_to_string(&marker).ok().as_deref() == Some("updated fixture version\n") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "NSIS did not replace the isolated fixture"
        );
        thread::sleep(Duration::from_millis(50));
    }
    let arguments = std::fs::read_to_string(directory.path().join("arguments.txt")).unwrap();
    for argument in ["/P", "/UPDATE", "/R"] {
        assert!(
            arguments.split_whitespace().any(|part| part == argument),
            "missing NSIS argument: {argument}"
        );
    }
    directory.close().unwrap();
}
