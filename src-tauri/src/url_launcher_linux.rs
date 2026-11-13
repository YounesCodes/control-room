use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub(crate) fn launch(mut command: Command) -> Result<(), String> {
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start the default browser: {error}"))?;
    finish_launch(child)
}

fn finish_launch(mut child: Child) -> Result<(), String> {
    // Some xdg-open desktop fallbacks remain attached to the browser. Catch
    // immediate launch errors without making the UI wait for a browser to close.
    let deadline = Instant::now() + Duration::from_millis(200);
    loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) if status.success() => return Ok(()),
            Some(_) => return Err(
                "Could not open the default web browser. Check your desktop's browser settings."
                    .into(),
            ),
            None if Instant::now() >= deadline => break,
            None => std::thread::sleep(Duration::from_millis(10)),
        }
    }
    std::thread::Builder::new()
        .name("browser-launcher".into())
        .spawn(move || {
            let _ = child.wait();
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_running_browser_does_not_hold_the_native_request_open() {
        // A real child stays alive until the test releases its input pipe.
        let mut child = Command::new("sh")
            .args(["-c", "read -r answer"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let pid = child.id();
        let (done, result) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || {
            let launched = finish_launch(child);
            let still_running = std::path::Path::new(&format!("/proc/{pid}")).exists();
            let _ = done.send((launched, still_running));
        });
        let completed = result.recv_timeout(Duration::from_secs(2));
        drop(input);
        waiter.join().unwrap();
        let (launched, still_running) =
            completed.expect("Launching waited for the browser to exit");
        assert!(launched.is_ok());
        assert!(still_running);
        let deadline = Instant::now() + Duration::from_secs(2);
        while std::path::Path::new(&format!("/proc/{pid}")).exists() {
            assert!(
                Instant::now() < deadline,
                "The owned browser child was not reaped"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn missing_launchers_and_immediate_failures_are_reported() {
        assert!(launch(Command::new("/control-room-missing-browser-fixture")).is_err());
        let mut command = Command::new("sh");
        command.args(["-c", "exit 17"]);
        assert!(launch(command).unwrap_err().contains("browser settings"));
    }
}
