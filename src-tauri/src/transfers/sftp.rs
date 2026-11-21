use std::{
    fs::File,
    io::{self, Cursor, Read, Seek, SeekFrom, Write},
    process::{Child, ChildStdin, ChildStdout, Stdio},
};

use crate::{models::SavedConnection, ssh, ssh_mux};

const VERSION: u8 = 2;
pub(super) const OPEN: u8 = 3;
pub(super) const CLOSE: u8 = 4;
pub(super) const READ: u8 = 5;
pub(super) const WRITE: u8 = 6;
pub(super) const LSTAT: u8 = 7;
pub(super) const FSTAT: u8 = 8;
pub(super) const OPENDIR: u8 = 11;
pub(super) const READDIR: u8 = 12;
pub(super) const REMOVE: u8 = 13;
pub(super) const REALPATH: u8 = 16;
pub(super) const RENAME: u8 = 18;
pub(super) const EXTENDED: u8 = 200;
const EXTENDED_REPLY: u8 = 201;
const STATUS: u8 = 101;
pub(super) const HANDLE: u8 = 102;
pub(super) const DATA: u8 = 103;
pub(super) const NAME: u8 = 104;
pub(super) const ATTRS: u8 = 105;
const MAX_PACKET: usize = 1024 * 1024;
pub(super) const POSIX_RENAME: &[u8] = b"posix-rename@openssh.com";
const STATVFS: &[u8] = b"statvfs@openssh.com";

pub(super) fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "The host sent an invalid SFTP reply.",
    )
}

pub(super) struct Packet(pub Cursor<Vec<u8>>);
impl Packet {
    pub fn byte(&mut self) -> io::Result<u8> {
        let mut value = [0];
        self.0.read_exact(&mut value)?;
        Ok(value[0])
    }

    pub fn number(&mut self) -> io::Result<u32> {
        let mut value = [0; 4];
        self.0.read_exact(&mut value)?;
        Ok(u32::from_be_bytes(value))
    }

    pub fn string(&mut self) -> io::Result<&[u8]> {
        let size = self.number()? as usize;
        let start = self.0.position() as usize;
        let end = start.checked_add(size).ok_or_else(invalid)?;
        self.0.set_position(end as u64);
        self.0.get_ref().get(start..end).ok_or_else(invalid)
    }

    fn wide(&mut self) -> io::Result<u64> {
        Ok((u64::from(self.number()?) << 32) | u64::from(self.number()?))
    }

    pub fn attributes(&mut self) -> io::Result<(Option<u64>, u32)> {
        let flags = self.number()?;
        let size = if flags & 1 != 0 {
            Some(self.wide()?)
        } else {
            None
        };
        if flags & 2 != 0 {
            self.number()?;
            self.number()?;
        }
        let mode = if flags & 4 != 0 { self.number()? } else { 0 };
        if flags & 8 != 0 {
            self.number()?;
            self.number()?;
        }
        if flags & 0x80000000 != 0 {
            for _ in 0..self.number()? {
                self.string()?;
                self.string()?;
            }
        }
        Ok((size, mode))
    }
}

pub(super) fn string(value: &[u8]) -> Vec<u8> {
    let mut out = (value.len() as u32).to_be_bytes().to_vec();
    out.extend(value);
    out
}

pub(super) fn arguments(connection: &SavedConnection) -> Vec<String> {
    let mut args =
        ssh_mux::inspection_arguments(connection, ssh::connection_arguments(connection, false));
    let host = args.pop().expect("SSH arguments include the destination");
    args.extend([
        "-o".into(),
        "ServerAliveInterval=10".into(),
        "-o".into(),
        "ServerAliveCountMax=2".into(),
        "-s".into(),
        "--".into(),
        host,
        "sftp".into(),
    ]);
    args
}

pub(super) struct Sftp {
    process: Child,
    input: ChildStdin,
    output: ChildStdout,
    diagnostics: File,
    sequence: u32,
    pub posix_rename: bool,
    statvfs: bool,
}

impl Drop for Sftp {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}

impl Sftp {
    pub fn connect(connection: &SavedConnection) -> io::Result<Self> {
        let ssh_path =
            ssh::detect_ssh_path().ok_or_else(|| io::Error::other(ssh::ssh_not_found_message()))?;
        let diagnostics = tempfile::tempfile()?;
        let mut process = ssh::background_command(ssh_path)
            .args(arguments(connection))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(diagnostics.try_clone()?)
            .spawn()?;
        let mut client = Self {
            input: process.stdin.take().unwrap(),
            output: process.stdout.take().unwrap(),
            process,
            diagnostics,
            sequence: 0,
            posix_rename: false,
            statvfs: false,
        };
        client.send(&[1, 0, 0, 0, 3])?;
        let mut version = client.receive()?;
        if version.byte()? != VERSION || version.number()? != 3 {
            return Err(io::Error::other(
                "This host does not support SFTP version 3.",
            ));
        }
        while version.0.position() < version.0.get_ref().len() as u64 {
            let extension = version.string()?.to_vec();
            let revision = version.string()?;
            client.posix_rename |= extension == POSIX_RENAME && revision == b"1";
            client.statvfs |= extension == STATVFS && revision == b"2";
        }
        Ok(client)
    }

    fn send(&mut self, data: &[u8]) -> io::Result<()> {
        self.input.write_all(&(data.len() as u32).to_be_bytes())?;
        self.input.write_all(data)?;
        self.input.flush()
    }

    fn receive(&mut self) -> io::Result<Packet> {
        let mut length = [0; 4];
        if self.output.read_exact(&mut length).is_err() {
            let mut reason = String::new();
            self.diagnostics.seek(SeekFrom::Start(0))?;
            let _ = (&self.diagnostics).take(4096).read_to_string(&mut reason);
            let reason = reason.trim();
            return Err(io::Error::other(if reason.is_empty() {
                "The host closed the SFTP connection.".into()
            } else if reason.contains("Permission denied") {
                format!("SSH authentication failed. Check your key or SSH agent. {reason}")
            } else {
                reason.to_owned()
            }));
        }
        let size = u32::from_be_bytes(length) as usize;
        if !(1..=MAX_PACKET).contains(&size) {
            return Err(invalid());
        }
        let mut data = vec![0; size];
        self.output.read_exact(&mut data)?;
        Ok(Packet(Cursor::new(data)))
    }

    pub fn request(&mut self, kind: u8, body: &[u8], expected: u8) -> io::Result<Packet> {
        self.sequence = self.sequence.wrapping_add(1);
        let mut data = vec![kind];
        data.extend(self.sequence.to_be_bytes());
        data.extend(body);
        self.send(&data)?;
        let mut packet = self.receive()?;
        let kind = packet.byte()?;
        if packet.number()? != self.sequence {
            return Err(invalid());
        }
        if kind == STATUS {
            let code = packet.number()?;
            if code == 0 && expected == STATUS {
                return Ok(packet);
            }
            let detail = String::from_utf8_lossy(packet.string()?);
            let (kind, message) = match code {
                1 => (io::ErrorKind::UnexpectedEof, "End of SFTP listing or file"),
                2 => (io::ErrorKind::NotFound, "Path not found on the host"),
                3 => (
                    io::ErrorKind::PermissionDenied,
                    "Permission denied on the host",
                ),
                14 => (io::ErrorKind::StorageFull, "The host disk is full"),
                _ => (
                    io::ErrorKind::Other,
                    "The host could not complete the file operation",
                ),
            };
            return Err(io::Error::new(kind, format!("{message}: {detail}")));
        }
        if kind != expected {
            return Err(invalid());
        }
        Ok(packet)
    }

    pub fn status(&mut self, kind: u8, body: &[u8]) -> io::Result<()> {
        self.request(kind, body, STATUS).map(|_| ())
    }

    pub fn disk_full(&mut self, folder: &str) -> bool {
        if !self.statvfs {
            return false;
        }
        let mut body = string(STATVFS);
        body.extend(string(folder.as_bytes()));
        self.request(EXTENDED, &body, EXTENDED_REPLY)
            .and_then(|mut reply| {
                let _block_size = reply.wide()?;
                let _fragment_size = reply.wide()?;
                let _blocks = reply.wide()?;
                let _free = reply.wide()?;
                let available = reply.wide()?;
                Ok(available == 0)
            })
            .unwrap_or(false)
    }

    pub fn handle(&mut self, kind: u8, body: &[u8]) -> io::Result<Vec<u8>> {
        Ok(string(self.request(kind, body, HANDLE)?.string()?))
    }
}
