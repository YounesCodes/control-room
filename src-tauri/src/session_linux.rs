//! Linux PTYs can stay readable or open after the shell that owned them exits.
//! Wake the reader at child exit and drain the queued output without waiting on
//! descendants that still have the slave open.

use std::{
    fs::File,
    io::{self, Read},
    os::{
        fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd},
        unix::net::UnixStream,
    },
    sync::Arc,
};

use portable_pty::{Child, ChildKiller, MasterPty};

pub(super) fn open_io(master: &dyn MasterPty) -> io::Result<(Output, File, UnixStream)> {
    let fd = master
        .as_raw_fd()
        .ok_or_else(|| io::Error::other("missing PTY fd"))?;
    // The master owns this fd for the duration of the borrow.
    let fd = unsafe { BorrowedFd::borrow_raw(fd) };
    let reader = File::from(fd.try_clone_to_owned()?);
    let writer = File::from(fd.try_clone_to_owned()?);
    let (exit, signal) = UnixStream::pair()?;
    Ok((
        Output {
            reader,
            exit,
            drain: None,
        },
        writer,
        signal,
    ))
}

pub(super) struct Output {
    reader: File,
    exit: UnixStream,
    drain: Option<usize>,
}

impl Read for Output {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() || self.drain == Some(0) {
            return Ok(0);
        }

        let mut fds = [
            libc::pollfd {
                fd: self.reader.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: self.exit.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        let timeout = if self.drain.is_some() { 0 } else { -1 };
        loop {
            // Both descriptors belong to this reader, and poll only borrows fds.
            let result = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as _, timeout) };
            if result >= 0 {
                break;
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
        if fds[1].revents != 0 {
            // Allow buffered terminal output to reach scrollback, while a
            // surviving writer cannot keep the finished session alive forever.
            self.drain.get_or_insert(64 * 1024);
        }
        if fds[0].revents == 0 {
            return Ok(0);
        }
        let limit = buffer.len().min(self.drain.unwrap_or(usize::MAX));
        match self.reader.read(&mut buffer[..limit]) {
            Ok(bytes) => {
                if let Some(remaining) = &mut self.drain {
                    *remaining -= bytes;
                }
                Ok(bytes)
            }
            // Linux signals EOF on the master with EIO after the slave closes.
            Err(error) if error.raw_os_error() == Some(libc::EIO) => Ok(0),
            Err(error) => Err(error),
        }
    }
}

/// A pidfd pins the child identity even when close races with wait. The
/// portable-pty killer on Unix only sends SIGHUP, which a shell can ignore.
#[derive(Debug, Clone)]
pub(super) struct Killer(Arc<OwnedFd>);

impl Killer {
    pub(super) fn new(child: &dyn Child) -> io::Result<Self> {
        let pid = child
            .process_id()
            .ok_or_else(|| io::Error::other("missing PTY child pid"))?;
        // The child has not been reaped. pidfd_open returns a new owned fd.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(Arc::new(unsafe { OwnedFd::from_raw_fd(fd as _) })))
    }
}

impl ChildKiller for Killer {
    fn kill(&mut self) -> io::Result<()> {
        // A PTY close ends the session leader even when it traps SIGHUP.
        let result = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                self.0.as_raw_fd(),
                libc::SIGKILL,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        if result == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(error)
        }
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(self.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, sync::mpsc, thread, time::Duration};

    use portable_pty::{CommandBuilder, PtySize, native_pty_system};

    fn run_pty(command: CommandBuilder, exercise: impl FnOnce(&mut File, &mpsc::Receiver<String>)) {
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let (mut output, mut input, signal) = open_io(pair.master.as_ref()).unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut killer = Killer::new(child.as_ref()).unwrap();
        pair.master
            .resize(PtySize {
                rows: 37,
                cols: 91,
                ..PtySize::default()
            })
            .unwrap();

        let (tx, rx) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut bytes = [0; 4096];
            loop {
                let n = output.read(&mut bytes).unwrap();
                if n == 0 {
                    break;
                }
                tx.send(String::from_utf8_lossy(&bytes[..n]).into_owned())
                    .unwrap();
            }
        });
        let (done_tx, done_rx) = mpsc::channel();
        let waiter = thread::spawn(move || {
            let status = child.wait().unwrap();
            drop(signal);
            done_tx.send(status).unwrap();
        });
        exercise(&mut input, &rx);
        let status = done_rx.recv_timeout(Duration::from_secs(10));
        if status.is_err() {
            killer.kill().unwrap();
        }
        assert!(status.unwrap().success());
        waiter.join().unwrap();
        reader.join().unwrap();
    }

    fn expect_output(rx: &mpsc::Receiver<String>, expected: &str) {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut text = String::new();
        while !text.contains(expected) {
            let chunk = rx
                .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                .unwrap_or_else(|_| panic!("PTY never printed {expected:?}: {text:?}"));
            text.push_str(&chunk);
        }
    }

    #[test]
    fn linux_pty_handles_input_resize_interrupt_and_exit() {
        let mut command = CommandBuilder::new("/bin/bash");
        command.args([
            "--noprofile",
            "--norc",
            "-c",
            "trap 'printf \"INTERRUPTED\n\"; exit' INT; printf 'READY\n'; read -r value; printf 'VALUE=%s SIZE=%s\n' \"$value\" \"$(stty size)\"; read -r",
        ]);
        run_pty(command, |input, rx| {
            expect_output(rx, "READY");
            input.write_all(b"hello\n").unwrap();
            expect_output(rx, "VALUE=hello SIZE=37 91");
            input.write_all(b"\x03").unwrap();
            expect_output(rx, "INTERRUPTED");
        });
    }

    #[test]
    fn linux_pty_can_close_a_child_that_ignores_hangup() {
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let (mut output, _, signal) = open_io(pair.master.as_ref()).unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "trap '' HUP; printf R; read -r"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut ready = [0];
        output.read_exact(&mut ready).unwrap();
        assert_eq!(ready, *b"R");
        let mut killer = Killer::new(child.as_ref()).unwrap();
        killer.kill().unwrap();
        assert!(!child.wait().unwrap().success());
        killer.kill().unwrap();
        drop(signal);
        output.read_to_end(&mut Vec::new()).unwrap();
    }

    #[test]
    #[ignore = "requires an explicitly configured Linux SSH fixture"]
    fn linux_pty_runs_a_live_ssh_session() {
        use crate::{
            models::SavedConnection,
            ssh::{connection_arguments, detect_ssh_path},
        };

        let connection = SavedConnection {
            id: "linux-ssh-fixture".into(),
            display_name: "Loopback fixture".into(),
            destination: std::env::var("CONTROL_ROOM_TEST_HOST").unwrap(),
            username: Some(std::env::var("CONTROL_ROOM_TEST_USER").unwrap()),
            port: Some(
                std::env::var("CONTROL_ROOM_TEST_PORT")
                    .unwrap()
                    .parse()
                    .unwrap(),
            ),
            identity_file: None,
            history_enabled: false,
            sudo_enabled: false,
            group_id: None,
            tags: Vec::new(),
            created_at: String::new(),
            updated_at: String::new(),
            last_connected_at: None,
        };
        let mut command = CommandBuilder::new(detect_ssh_path().unwrap());
        command.env("TERM", super::super::TERMINAL_TYPE);
        command.args(connection_arguments(&connection, true));
        command.arg(super::super::interactive_shell_command(false));
        run_pty(command, |input, rx| {
            expect_output(rx, super::super::CONNECTED_MARKER);
            input
                .write_all(b"printf 'REMOTE_%s\n' PTY; exit\n")
                .unwrap();
            expect_output(rx, "REMOTE_PTY");
        });
    }
}
