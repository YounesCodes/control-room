use std::{collections::HashSet, io, mem, sync::Arc};

use portable_pty::{Child, ChildKiller};
use windows_sys::Win32::{
    Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE, STILL_ACTIVE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        },
        Threading::{
            GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_TERMINATE, TerminateProcess,
        },
    },
};

const TERMINATED_EXIT_CODE: u32 = 1;

struct Process(HANDLE);

// The handle is a kernel object reference that any thread may use.
unsafe impl Send for Process {}
unsafe impl Sync for Process {}

impl Drop for Process {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

impl Process {
    fn open(pid: u32) -> io::Result<Self> {
        let handle = unsafe {
            OpenProcess(
                PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        if handle.is_null() {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(handle))
        }
    }

    fn created(&self) -> io::Result<u64> {
        let mut times = [FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        }; 4];
        let [created, exited, kernel, user] = &mut times;
        if unsafe { GetProcessTimes(self.0, created, exited, kernel, user) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    fn exited(&self) -> bool {
        let mut code = 0;
        unsafe { GetExitCodeProcess(self.0, &mut code) != 0 && code != STILL_ACTIVE as u32 }
    }

    fn terminate(&self) -> io::Result<()> {
        if unsafe { TerminateProcess(self.0, TERMINATED_EXIT_CODE) } != 0 || self.exited() {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

/// Ends the PTY child together with every process it started. Git Bash's
/// `bin\bash.exe` is a launcher whose real shell keeps the pseudoconsole open
/// when only the launcher is terminated.
#[derive(Clone)]
pub(super) struct Killer {
    pid: u32,
    root: Arc<Process>,
}

impl Killer {
    pub(super) fn new(child: &dyn Child) -> io::Result<Self> {
        let pid = child
            .process_id()
            .ok_or_else(|| io::Error::other("missing PTY child pid"))?;
        Ok(Self {
            pid,
            root: Arc::new(Process::open(pid)?),
        })
    }
}

impl std::fmt::Debug for Killer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Killer")
            .field("pid", &self.pid)
            .finish()
    }
}

impl ChildKiller for Killer {
    fn kill(&mut self) -> io::Result<()> {
        if !self.root.exited() {
            let created = self.root.created()?;
            for process in descendants(self.pid, created) {
                let _ = process.terminate();
            }
        }
        self.root.terminate()
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(self.clone())
    }
}

fn descendants(root_pid: u32, root_created: u64) -> Vec<Process> {
    let parents = parent_pids();
    let mut visited = HashSet::from([root_pid]);
    let mut frontier = vec![(root_pid, root_created)];
    let mut found = Vec::new();
    while let Some((parent, parent_created)) = frontier.pop() {
        for &(pid, parent_pid) in &parents {
            if parent_pid != parent || !visited.insert(pid) {
                continue;
            }
            let Ok(process) = Process::open(pid) else {
                continue;
            };
            match process.created() {
                Ok(created) if created >= parent_created => {
                    frontier.push((pid, created));
                    found.push(process);
                }
                _ => {}
            }
        }
    }
    found
}

struct Snapshot(HANDLE);

impl Drop for Snapshot {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

fn parent_pids() -> Vec<(u32, u32)> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Vec::new();
    }
    let snapshot = Snapshot(snapshot);
    let mut entry: PROCESSENTRY32W = unsafe { mem::zeroed() };
    entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut pairs = Vec::new();
    let mut more = unsafe { Process32FirstW(snapshot.0, &mut entry) } != 0;
    while more {
        pairs.push((entry.th32ProcessID, entry.th32ParentProcessID));
        more = unsafe { Process32NextW(snapshot.0, &mut entry) } != 0;
    }
    pairs
}

#[cfg(test)]
pub(super) struct ProcessTree(Vec<Process>);

#[cfg(test)]
impl ProcessTree {
    pub(super) fn below(pid: u32) -> Self {
        let root = Process::open(pid).unwrap();
        Self(descendants(pid, root.created().unwrap()))
    }

    pub(super) fn len(&self) -> usize {
        self.0.len()
    }

    pub(super) fn running(&self) -> usize {
        self.0.iter().filter(|process| !process.exited()).count()
    }
}
