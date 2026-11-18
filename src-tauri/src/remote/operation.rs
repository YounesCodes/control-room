use std::{
    collections::HashMap,
    io::{Read, Write},
    process::{Child, Stdio},
    sync::{Arc, mpsc},
    thread,
    time::{Duration, Instant},
};

use parking_lot::{Condvar, Mutex};
use wait_timeout::ChildExt;
use zeroize::Zeroizing;

use crate::{
    models::SavedConnection,
    ssh::{background_command, connection_arguments, detect_ssh_path, ssh_not_found_message},
};

const OUTPUT_LIMIT: u64 = 5 * 1024 * 1024;
pub(crate) const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_STRUCTURED_OPERATIONS_PER_CONNECTION: usize = 2;
pub(crate) const MAX_STRUCTURED_QUEUE_WAIT: Duration = Duration::from_secs(4);

/// Caps Structured Operations per Saved Connection. A permit is the only proof
/// of a slot, and a caller waits at most `MAX_STRUCTURED_QUEUE_WAIT` for one.
#[derive(Default)]
pub struct RemoteOperationLimiter {
    hosts: Arc<Mutex<HashMap<String, Arc<HostOperationLimit>>>>,
    #[cfg(test)]
    after_host_lookup: Option<Arc<dyn Fn() + Send + Sync>>,
}

#[derive(Default)]
struct HostOperationLimit {
    slots: Mutex<HostSlots>,
    available: Condvar,
}

#[derive(Default)]
struct HostSlots {
    active: usize,
    arriving: usize,
}

impl HostSlots {
    fn is_forgettable(&self) -> bool {
        self.active == 0 && self.arriving == 0
    }
}

pub struct RemoteOperationPermit {
    connection_id: String,
    host: Arc<HostOperationLimit>,
    hosts: Arc<Mutex<HashMap<String, Arc<HostOperationLimit>>>>,
}

impl RemoteOperationLimiter {
    pub fn acquire(&self, connection_id: &str) -> Result<RemoteOperationPermit, String> {
        self.acquire_for(connection_id, MAX_STRUCTURED_QUEUE_WAIT)
    }

    fn acquire_for(
        &self,
        connection_id: &str,
        maximum_wait: Duration,
    ) -> Result<RemoteOperationPermit, String> {
        let connection_id = connection_id.to_owned();
        let mut hosts = self.hosts.lock();
        let host = hosts.entry(connection_id.clone()).or_default().clone();
        host.slots.lock().arriving += 1;
        drop(hosts);
        #[cfg(test)]
        if let Some(hook) = &self.after_host_lookup {
            hook();
        }
        let deadline = Instant::now() + maximum_wait;
        let mut slots = host.slots.lock();
        while slots.active >= MAX_STRUCTURED_OPERATIONS_PER_CONNECTION {
            if host.available.wait_until(&mut slots, deadline).timed_out()
                && slots.active >= MAX_STRUCTURED_OPERATIONS_PER_CONNECTION
            {
                slots.arriving -= 1;
                drop(slots);
                let mut hosts = self.hosts.lock();
                let remove = hosts.get(&connection_id).is_some_and(|tracked| {
                    Arc::ptr_eq(tracked, &host) && tracked.slots.lock().is_forgettable()
                });
                if remove {
                    hosts.remove(&connection_id);
                }
                return Err(format!(
                    "Remote operation queue was busy for {} seconds",
                    MAX_STRUCTURED_QUEUE_WAIT.as_secs()
                ));
            }
        }
        slots.active += 1;
        slots.arriving -= 1;
        drop(slots);
        Ok(RemoteOperationPermit {
            connection_id,
            host,
            hosts: self.hosts.clone(),
        })
    }

    #[cfg(test)]
    fn tracked_connections(&self) -> usize {
        self.hosts.lock().len()
    }

    #[cfg(test)]
    fn with_lookup_hook(hook: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self {
            hosts: Arc::default(),
            after_host_lookup: Some(hook),
        }
    }

    #[cfg(test)]
    fn wake_waiters(&self, connection_id: &str) {
        if let Some(host) = self.hosts.lock().get(connection_id) {
            host.available.notify_all();
        }
    }
}

#[cfg(test)]
impl RemoteOperationPermit {
    fn live_on_its_limit(&self) -> usize {
        self.host.slots.lock().active
    }

    fn shares_a_limit_with(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.host, &other.host)
    }
}

impl Drop for RemoteOperationPermit {
    fn drop(&mut self) {
        let mut slots = self.host.slots.lock();
        slots.active = slots.active.saturating_sub(1);
        let idle = slots.is_forgettable();
        self.host.available.notify_one();
        drop(slots);

        if idle {
            let mut hosts = self.hosts.lock();
            let remove = hosts.get(&self.connection_id).is_some_and(|host| {
                Arc::ptr_eq(host, &self.host) && host.slots.lock().is_forgettable()
            });
            if remove {
                hosts.remove(&self.connection_id);
            }
        }
    }
}

#[derive(Debug)]
pub struct CommandOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

impl CommandOutput {
    pub(crate) fn success_text(self) -> Result<String, String> {
        if self.exit_code != 0 {
            return Err(classify_failure(self.exit_code, &self.stderr));
        }
        String::from_utf8(self.stdout).map_err(|_| "Remote output was not valid UTF-8".into())
    }
}

/// How much privilege a Structured Operation asks for. Elevation is a
/// per-request decision, never a stored credential: `Password` holds a value the
/// user typed a moment ago and drops it when the request ends.
#[derive(Debug, Clone, Default)]
pub enum Elevation {
    /// Run as the connecting account.
    #[default]
    None,
    /// The Saved Connection allows sudo, so run elevated when the account has
    /// passwordless sudo and run unelevated when it does not.
    Allowed,
    /// A one-shot password from the sudo dialog.
    Password(Zeroizing<String>),
}

impl Elevation {
    /// Turns a stored permission and an optional one-shot password into the mode
    /// a request should run in. A password the user just typed always wins: it
    /// is the answer to a prompt that already happened.
    pub fn resolve(allowed: bool, password: Option<String>) -> Self {
        match password {
            Some(password) => Self::Password(Zeroizing::new(password)),
            None if allowed => Self::Allowed,
            None => Self::None,
        }
    }
}

/// Wraps a read in sudo according to `elevation`.
///
/// `Allowed` probes sudo and falls back inside the same shell, so an account
/// without passwordless sudo still gets its unelevated result in one round trip
/// instead of an error. When that result hits a permission wall, the caller can
/// still offer the password dialog.
pub fn elevated_command(remote_command: &str, elevation: &Elevation) -> String {
    match elevation {
        Elevation::None => remote_command.to_string(),
        Elevation::Allowed => format!(
            "if sudo -n true 2>/dev/null; then sudo -n -- {remote_command}; else {remote_command}; fi"
        ),
        Elevation::Password(_) => format!("sudo -S -p '[control-room-sudo]' -- {remote_command}"),
    }
}

/// The only way to run a bounded remote read. Every call gets the same
/// `COMMAND_TIMEOUT`, output limit, child termination and failure messages.
pub struct RemoteCommandExecutor;

impl RemoteCommandExecutor {
    pub fn execute(
        connection: &SavedConnection,
        operation: &'static str,
        remote_command: &str,
    ) -> Result<CommandOutput, String> {
        run_ssh(connection, operation, remote_command, None)
    }

    /// Runs one read at the requested privilege. The password, when there is
    /// one, goes to sudo over stdin and is never written to the command line
    /// where the remote host's process list could show it.
    pub fn execute_elevated(
        connection: &SavedConnection,
        operation: &'static str,
        remote_command: &str,
        elevation: &Elevation,
    ) -> Result<CommandOutput, String> {
        let command = elevated_command(remote_command, elevation);
        match elevation {
            Elevation::Password(password) => {
                run_ssh(connection, operation, &command, Some(password.as_bytes()))
            }
            _ => run_ssh(connection, operation, &command, None),
        }
    }

    pub fn execute_with_input(
        connection: &SavedConnection,
        operation: &'static str,
        remote_command: &str,
        input: &[u8],
    ) -> Result<CommandOutput, String> {
        run_ssh(connection, operation, remote_command, Some(input))
    }
}

fn run_ssh(
    connection: &SavedConnection,
    operation: &'static str,
    remote_command: &str,
    stdin: Option<&[u8]>,
) -> Result<CommandOutput, String> {
    let ssh_path = detect_ssh_path().ok_or_else(ssh_not_found_message)?;
    let mut arguments = connection_arguments(connection, false);
    arguments.push(remote_command.into());
    let mut command = background_command(ssh_path);
    command.args(arguments);
    run_process(command, operation, stdin, COMMAND_TIMEOUT)
}

fn run_process(
    mut command: std::process::Command,
    operation: &'static str,
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<CommandOutput, String> {
    let started_at = Instant::now();
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("SSH process could not start: {error}"))?;
    let spawned_at = Instant::now();

    let stdout = child.stdout.take().ok_or_else(|| {
        terminate_child(&mut child);
        "SSH process stdout was unavailable".to_string()
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        terminate_child(&mut child);
        "SSH process stderr was unavailable".to_string()
    })?;
    let (first_byte_tx, first_byte_rx) = mpsc::channel();
    let stdout_first_byte = first_byte_tx.clone();
    let stdout_reader = thread::spawn(move || read_limited(stdout, stdout_first_byte));
    let stderr_reader = thread::spawn(move || read_limited(stderr, first_byte_tx));
    // Pipes have bounded capacity and an SSH peer can stop reading, so write and drain on workers.
    let child_stdin = child.stdin.take().expect("stdin was piped");
    let input_writer = stdin.map(|bytes| spawn_input_writer(child_stdin, bytes));
    let status = match child.wait_timeout(timeout) {
        Ok(Some(status)) => status,
        Ok(None) => {
            terminate_child(&mut child);
            if let Some(writer) = input_writer {
                let _ = writer.join();
            }
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            log_operation_timing(operation, started_at, spawned_at, None, "timeout");
            return Err(format!(
                "Remote command timed out after {} seconds",
                timeout.as_secs_f64()
            ));
        }
        Err(error) => {
            terminate_child(&mut child);
            if let Some(writer) = input_writer {
                let _ = writer.join();
            }
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(format!("Could not wait for SSH process: {error}"));
        }
    };
    let input_result = input_writer
        .map(|writer| {
            writer
                .join()
                .map_err(|_| "Remote input writer panicked".to_string())?
                .map_err(|error| format!("Could not send process input: {error}"))
        })
        .unwrap_or(Ok(()));
    let stdout_result = stdout_reader
        .join()
        .map_err(|_| "Remote output reader panicked".to_string());
    let stderr_result = stderr_reader
        .join()
        .map_err(|_| "Remote error reader panicked".to_string());
    input_result?;
    let stdout = stdout_result??;
    let stderr = stderr_result??;
    let first_byte_at = first_byte_rx.try_iter().min();
    log_operation_timing(
        operation,
        started_at,
        spawned_at,
        first_byte_at,
        if status.success() { "ok" } else { "failed" },
    );
    Ok(CommandOutput {
        stdout,
        stderr,
        exit_code: status.code().unwrap_or(255),
    })
}

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

pub(super) fn spawn_input_writer(
    mut pipe: std::process::ChildStdin,
    bytes: &[u8],
) -> thread::JoinHandle<std::io::Result<()>> {
    let bytes = Zeroizing::new(bytes.to_vec());
    thread::spawn(move || pipe.write_all(&bytes).and_then(|_| pipe.write_all(b"\n")))
}

fn read_limited(
    mut reader: impl Read,
    first_byte: mpsc::Sender<Instant>,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        if bytes.is_empty() {
            let _ = first_byte.send(Instant::now());
        }
        if bytes.len() + count > OUTPUT_LIMIT as usize {
            return Err("Remote command output exceeded 5 MiB".into());
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    Ok(bytes)
}

fn log_operation_timing(
    operation: &str,
    started_at: Instant,
    spawned_at: Instant,
    first_byte_at: Option<Instant>,
    outcome: &str,
) {
    let first_byte_ms = first_byte_at
        .map(|value| value.duration_since(started_at).as_millis().to_string())
        .unwrap_or_else(|| "none".into());
    eprintln!(
        "[control-room] remote_operation={operation} spawn_ms={} first_byte_ms={first_byte_ms} total_ms={} outcome={outcome}",
        spawned_at.duration_since(started_at).as_millis(),
        started_at.elapsed().as_millis(),
    );
}

pub(super) fn classify_failure(code: i32, stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    let lower = stderr.to_ascii_lowercase();
    // PowerShell serializes thrown errors as CLIXML under -EncodedCommand.
    if lower.contains("docker cli was not found on this windows host.") {
        return "Docker is not installed on this host.".into();
    }
    if lower.contains("docker could not read the daemon. check that docker is running and this ssh account has access.") {
        return "Docker is unavailable. Check that it is running and this SSH account has access."
            .into();
    }
    let category = if lower.contains("permission denied")
        || lower.contains("access denied")
        || lower.contains("you need to be root")
        || lower.contains("operation not permitted")
        || lower.contains("authorization failed")
        || lower.contains("not_authorized")
        || lower.contains("notauthorizedexception")
    {
        "Permission denied"
    } else if lower.contains("could not resolve hostname") {
        "Host could not be resolved"
    } else if lower.contains("connection refused") {
        "Connection refused"
    } else if lower.contains("timed out") {
        "Connection timed out"
    } else if lower.contains("host key verification failed") {
        "Host-key verification failed"
    } else if lower.contains("command not found")
        || lower.contains("docker: not found")
        || lower.contains("journalctl: not found")
        || lower.contains("systemctl: not found")
        || (lower.contains("no such file or directory")
            && (lower.contains("docker")
                || lower.contains("journalctl")
                || lower.contains("systemctl")))
    {
        "Feature is not installed on this host"
    } else {
        "Remote command failed"
    };
    if stderr.is_empty() {
        format!("{category} with exit code {code}")
    } else {
        format!("{category}: {stderr}")
    }
}

#[cfg(all(test, windows))]
pub(super) fn run_local_script(
    command: std::process::Command,
    operation: &'static str,
) -> Result<CommandOutput, String> {
    run_process(command, operation, None, COMMAND_TIMEOUT)
}

#[cfg(test)]
mod tests;
