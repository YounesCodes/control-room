use std::{
    ffi::{CString, OsStr, OsString},
    io,
    os::unix::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
    ptr,
};

use portable_pty::{Child, ChildKiller, CommandBuilder, ExitStatus, MasterPty};

const POSIX_SPAWN_SETSID: libc::c_int = 0x0400;

unsafe extern "C" {
    fn posix_spawn_file_actions_addchdir_np(
        actions: *mut libc::posix_spawn_file_actions_t,
        path: *const libc::c_char,
    ) -> libc::c_int;
}

pub(super) fn spawn(
    master: &dyn MasterPty,
    command: &CommandBuilder,
) -> io::Result<Box<dyn Child + Send + Sync>> {
    let tty = master
        .tty_name()
        .ok_or_else(|| io::Error::other("missing PTY name"))?;
    let launch = Launch::from_builder(command)?;
    let pid = launch.spawn(&tty)?;
    Ok(Box::new(SpawnedChild { pid, status: None }))
}

struct Launch {
    program: CString,
    argv: Vec<CString>,
    envp: Vec<CString>,
    directory: CString,
}

impl Launch {
    fn from_builder(command: &CommandBuilder) -> io::Result<Self> {
        let arguments = command.get_argv();
        let first = arguments
            .first()
            .ok_or_else(|| io::Error::other("missing terminal program"))?;
        let mut environment: Vec<(OsString, OsString)> =
            vec![("SHELL".into(), command.get_shell().into())];
        environment.extend(
            command
                .iter_full_env_as_str()
                .filter(|(key, _)| *key != "SHELL")
                .map(|(key, value)| (key.into(), value.into())),
        );
        let lookup = |name: &str| {
            environment
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        };
        let home = lookup("HOME")
            .or_else(|| std::env::var_os("HOME"))
            .unwrap_or_else(|| "/".into());
        let directory = command
            .get_cwd()
            .filter(|directory| Path::new(directory).is_dir())
            .cloned()
            .unwrap_or(home);
        let program = resolve_program(first, lookup("PATH").as_deref(), Path::new(&directory))?;
        Ok(Self {
            program: c_string(program.into_os_string())?,
            argv: arguments
                .iter()
                .cloned()
                .map(c_string)
                .collect::<io::Result<_>>()?,
            envp: environment
                .into_iter()
                .map(|(key, value)| {
                    let mut entry = key;
                    entry.push("=");
                    entry.push(value);
                    c_string(entry)
                })
                .collect::<io::Result<_>>()?,
            directory: c_string(directory)?,
        })
    }

    fn spawn(&self, tty: &Path) -> io::Result<libc::pid_t> {
        let tty = c_string(tty.as_os_str().to_owned())?;
        let mut argv: Vec<*mut libc::c_char> = self
            .argv
            .iter()
            .map(|value| value.as_ptr().cast_mut())
            .collect();
        argv.push(ptr::null_mut());
        let mut envp: Vec<*mut libc::c_char> = self
            .envp
            .iter()
            .map(|value| value.as_ptr().cast_mut())
            .collect();
        envp.push(ptr::null_mut());
        let mut attributes = Attributes::new()?;
        let mut actions = FileActions::new()?;
        unsafe {
            let mut every_signal: libc::sigset_t = std::mem::zeroed();
            let mut no_signal: libc::sigset_t = std::mem::zeroed();
            libc::sigfillset(&mut every_signal);
            libc::sigemptyset(&mut no_signal);
            check(libc::posix_spawnattr_setsigdefault(
                &mut attributes.0,
                &every_signal,
            ))?;
            check(libc::posix_spawnattr_setsigmask(
                &mut attributes.0,
                &no_signal,
            ))?;
            check(libc::posix_spawnattr_setflags(
                &mut attributes.0,
                (POSIX_SPAWN_SETSID
                    | libc::POSIX_SPAWN_CLOEXEC_DEFAULT
                    | libc::POSIX_SPAWN_SETSIGDEF
                    | libc::POSIX_SPAWN_SETSIGMASK) as libc::c_short,
            ))?;
            check(libc::posix_spawn_file_actions_addopen(
                &mut actions.0,
                0,
                tty.as_ptr(),
                libc::O_RDWR,
                0,
            ))?;
            check(libc::posix_spawn_file_actions_adddup2(&mut actions.0, 0, 1))?;
            check(libc::posix_spawn_file_actions_adddup2(&mut actions.0, 0, 2))?;
            check(posix_spawn_file_actions_addchdir_np(
                &mut actions.0,
                self.directory.as_ptr(),
            ))?;
            let mut pid = 0;
            check(libc::posix_spawn(
                &mut pid,
                self.program.as_ptr(),
                &actions.0,
                &attributes.0,
                argv.as_ptr(),
                envp.as_ptr(),
            ))?;
            Ok(pid)
        }
    }
}

fn resolve_program(program: &OsStr, path: Option<&OsStr>, directory: &Path) -> io::Result<PathBuf> {
    let program = Path::new(program);
    if program.as_os_str().as_bytes().contains(&b'/') {
        return Ok(if program.is_absolute() {
            program.to_path_buf()
        } else {
            directory.join(program)
        });
    }
    let path = path
        .map(OsStr::to_owned)
        .or_else(|| std::env::var_os("PATH"))
        .unwrap_or_default();
    std::env::split_paths(&path)
        .map(|entry| entry.join(program))
        .find(|candidate| is_executable(candidate))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("{} was not found on PATH", program.display()),
            )
        })
}

fn is_executable(path: &Path) -> bool {
    path.is_file()
        && c_string(path.as_os_str().to_owned())
            .is_ok_and(|path| unsafe { libc::access(path.as_ptr(), libc::X_OK) } == 0)
}

fn c_string(value: OsString) -> io::Result<CString> {
    CString::new(value.into_vec()).map_err(|_| io::Error::other("argument contains a NUL byte"))
}

fn check(result: libc::c_int) -> io::Result<()> {
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(result))
    }
}

struct Attributes(libc::posix_spawnattr_t);

impl Attributes {
    fn new() -> io::Result<Self> {
        let mut attributes = ptr::null_mut();
        check(unsafe { libc::posix_spawnattr_init(&mut attributes) })?;
        Ok(Self(attributes))
    }
}

impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe { libc::posix_spawnattr_destroy(&mut self.0) };
    }
}

struct FileActions(libc::posix_spawn_file_actions_t);

impl FileActions {
    fn new() -> io::Result<Self> {
        let mut actions = ptr::null_mut();
        check(unsafe { libc::posix_spawn_file_actions_init(&mut actions) })?;
        Ok(Self(actions))
    }
}

impl Drop for FileActions {
    fn drop(&mut self) {
        unsafe { libc::posix_spawn_file_actions_destroy(&mut self.0) };
    }
}

#[derive(Debug)]
pub(super) struct SpawnedChild {
    pid: libc::pid_t,
    status: Option<ExitStatus>,
}

impl SpawnedChild {
    fn reap(&mut self, options: libc::c_int) -> io::Result<Option<ExitStatus>> {
        if let Some(status) = &self.status {
            return Ok(Some(status.clone()));
        }
        let mut raw = 0;
        loop {
            let result = unsafe { libc::waitpid(self.pid, &mut raw, options) };
            if result == 0 {
                return Ok(None);
            }
            if result == self.pid {
                break;
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
        let status = if libc::WIFEXITED(raw) {
            ExitStatus::with_exit_code(libc::WEXITSTATUS(raw) as u32)
        } else {
            ExitStatus::with_signal(&format!("signal {}", libc::WTERMSIG(raw)))
        };
        self.status = Some(status.clone());
        Ok(Some(status))
    }
}

impl Child for SpawnedChild {
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.reap(libc::WNOHANG)
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        self.reap(0)
            .map(|status| status.expect("a blocking wait returns a status"))
    }

    fn process_id(&self) -> Option<u32> {
        Some(self.pid as u32)
    }
}

impl ChildKiller for SpawnedChild {
    fn kill(&mut self) -> io::Result<()> {
        HangUp(self.pid).kill()
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(HangUp(self.pid))
    }
}

#[derive(Debug, Clone, Copy)]
struct HangUp(libc::pid_t);

impl ChildKiller for HangUp {
    fn kill(&mut self) -> io::Result<()> {
        if unsafe { libc::kill(self.0, libc::SIGHUP) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(*self)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io::{BufRead, BufReader},
        time::{Duration, Instant},
    };

    use portable_pty::{PtySize, native_pty_system};

    use super::*;

    fn size(rows: u16, cols: u16) -> PtySize {
        PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        }
    }

    #[test]
    fn a_spawned_shell_owns_its_pty_and_hears_resizes() {
        let pair = native_pty_system().openpty(size(24, 80)).unwrap();
        let directory = std::env::temp_dir().canonicalize().unwrap();
        let mut command = CommandBuilder::new("sh");
        command.args([
            "-c",
            "trap 'echo WINCH=$(stty size); exit 7' WINCH; echo TTY=$(ps -o tty= -p $$) PWD=$(pwd) MARK=$CONTROL_ROOM_SPAWN_MARK; echo READY; while :; do sleep 1; done",
        ]);
        command.env("CONTROL_ROOM_SPAWN_MARK", "kept");
        command.cwd(&directory);
        let started = Instant::now();
        let mut child = spawn(pair.master.as_ref(), &command).unwrap();
        let spawn_time = started.elapsed();
        drop(pair.slave);
        let tty = pair.master.tty_name().unwrap();
        let mut lines = BufReader::new(pair.master.try_clone_reader().unwrap()).lines();

        let first = lines.next().unwrap().unwrap();
        assert!(
            first.contains(&format!(
                "TTY={}",
                tty.file_name().unwrap().to_string_lossy()
            )),
            "{first} does not name {tty:?} as the controlling terminal"
        );
        assert!(
            first.contains(&format!("PWD={}", directory.display())),
            "{first}"
        );
        assert!(first.contains("MARK=kept"), "{first}");
        assert_eq!(lines.next().unwrap().unwrap().trim(), "READY");

        pair.master.resize(size(40, 100)).unwrap();
        assert_eq!(lines.next().unwrap().unwrap().trim(), "WINCH=40 100");
        let status = child.wait().unwrap();
        assert_eq!(status.exit_code(), 7);
        assert!(spawn_time < Duration::from_secs(1));
    }

    #[test]
    fn closing_a_spawned_shell_hangs_it_up() {
        let pair = native_pty_system().openpty(size(24, 80)).unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "echo READY; while :; do sleep 1; done"]);
        let mut child = spawn(pair.master.as_ref(), &command).unwrap();
        drop(pair.slave);
        let mut lines = BufReader::new(pair.master.try_clone_reader().unwrap()).lines();
        assert_eq!(lines.next().unwrap().unwrap().trim(), "READY");

        child.clone_killer().kill().unwrap();

        assert!(!child.wait().unwrap().success());
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn a_missing_program_is_reported_before_spawning() {
        let pair = native_pty_system().openpty(size(24, 80)).unwrap();
        let command = CommandBuilder::new("control-room-no-such-shell");
        let error = spawn(pair.master.as_ref(), &command).err().unwrap();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }
}
