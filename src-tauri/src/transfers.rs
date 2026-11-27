mod folder_download;
mod sftp;
#[cfg(test)]
mod tests;

use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{State, WebviewWindow, ipc::Channel};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

use crate::{database::Database, models::SavedConnection};
use sftp::{ATTRS, DATA, NAME, POSIX_RENAME, Sftp, invalid, string};

const TYPE_MASK: u32 = 0o170000;
const DIRECTORY: u32 = 0o040000;
const REGULAR: u32 = 0o100000;

#[derive(Default)]
pub struct Transfers {
    active: Mutex<HashMap<Uuid, Arc<AtomicBool>>>,
    uploads: Mutex<HashSet<PathBuf>>,
    downloads: Mutex<HashSet<PathBuf>>,
}

impl Transfers {
    pub fn cancel_all(&self) {
        for flag in self.active.lock().values() {
            flag.store(true, Ordering::Release);
        }
    }

    pub fn allow_drop(&self, paths: &[PathBuf]) {
        self.uploads.lock().extend(paths.iter().cloned());
    }
}

#[tauri::command(async)]
pub fn choose_transfer_paths(
    window: WebviewWindow,
    transfers: State<'_, Transfers>,
    direction: Direction,
) -> Result<Vec<PathBuf>, String> {
    let picker = window.dialog().file();
    #[cfg(any(windows, target_os = "macos"))]
    let picker = picker.set_parent(&window);
    let picked = match direction {
        Direction::Upload => picker
            .set_title("Choose files to upload")
            .blocking_pick_files()
            .unwrap_or_default(),
        Direction::Download => picker
            .set_title("Choose download folder")
            .blocking_pick_folder()
            .into_iter()
            .collect(),
    };
    let paths = picked
        .into_iter()
        .map(|file| file.into_path().map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let allowed = match direction {
        Direction::Upload => &transfers.uploads,
        Direction::Download => &transfers.downloads,
    };
    allowed.lock().extend(paths.iter().cloned());
    Ok(paths)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    path: String,
    entries: Vec<Entry>,
}

#[derive(Serialize)]
struct Entry {
    name: String,
    kind: &'static str,
    size: Option<u64>,
}

fn bad_path() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "Choose a valid absolute path.")
}

fn remote_path(value: &str) -> io::Result<String> {
    if value.is_empty() || value.len() > 32767 || value.chars().any(char::is_control) {
        return Err(bad_path());
    }
    let bytes = value.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
    {
        return Ok(format!("/{}", value.replace('\\', "/")));
    }
    if !value.starts_with('/') {
        return Err(bad_path());
    }
    Ok(value.to_owned())
}

fn remote_child(folder: &str, name: &str) -> io::Result<String> {
    if name.is_empty()
        || matches!(name, "." | "..")
        || name.contains('/')
        || name.chars().any(char::is_control)
    {
        return Err(bad_path());
    }
    let folder = remote_path(folder)?;
    let bytes = folder.as_bytes();
    if bytes.len() >= 3 && bytes[1].is_ascii_alphabetic() && bytes[2] == b':' {
        validate_windows_name(name)?;
    }
    Ok(format!("{}/{name}", folder.trim_end_matches('/')))
}

fn download_destination(folder: &Path, name: &str) -> io::Result<PathBuf> {
    if !folder.is_absolute()
        || name.is_empty()
        || name.chars().any(char::is_control)
        || Path::new(name).components().count() != 1
        || !matches!(
            Path::new(name).components().next(),
            Some(Component::Normal(_))
        )
    {
        return Err(bad_path());
    }
    #[cfg(windows)]
    validate_windows_name(name)?;
    Ok(folder.join(name))
}

fn validate_windows_name(name: &str) -> io::Result<()> {
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    if name.contains(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
        || name.ends_with([' ', '.'])
        || matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        )
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|n| {
                n.len() == 1 && n.as_bytes()[0].is_ascii_digit() || ["¹", "²", "³"].contains(&n)
            })
        })
    {
        return Err(io::Error::other(
            "This filename cannot be transferred to Windows.",
        ));
    }
    Ok(())
}

fn list(client: &mut Sftp, folder: Option<&str>) -> io::Result<Folder> {
    let path = folder
        .map(remote_path)
        .transpose()?
        .unwrap_or_else(|| ".".into());
    let path = resolve_folder(client, &path)?;
    let mut entries = read_entries(client, &path, None)?;
    entries.sort_by_cached_key(|entry| (entry.kind != "folder", entry.name.to_lowercase()));
    Ok(Folder { path, entries })
}

fn read_entries(
    client: &mut Sftp,
    path: &str,
    cancel: Option<&AtomicBool>,
) -> io::Result<Vec<Entry>> {
    let handle = client.handle(sftp::OPENDIR, &string(path.as_bytes()))?;
    let mut entries = Vec::new();
    loop {
        if let Some(cancel) = cancel {
            check_cancel(cancel)?;
        }
        let mut batch = match client.request(sftp::READDIR, &handle, NAME) {
            Err(e)
                if e.kind() == io::ErrorKind::UnexpectedEof
                    && e.to_string().starts_with("End of SFTP") =>
            {
                break;
            }
            result => result?,
        };
        let count = batch.number()?;
        if count == 0 {
            return Err(invalid());
        }
        for _ in 0..count {
            let name = std::str::from_utf8(batch.string()?).map(str::to_owned);
            if name.is_err() && cancel.is_some() {
                return Err(io::Error::other(
                    "A name in this folder is not valid UTF-8.",
                ));
            }
            batch.string()?;
            let (size, mode) = batch.attributes()?;
            let Some(name) = name.ok().filter(|n| !matches!(n.as_str(), "." | "..")) else {
                continue;
            };
            let kind = match mode & TYPE_MASK {
                DIRECTORY => "folder",
                REGULAR => "file",
                _ => "other",
            };
            entries.push(Entry { name, kind, size });
            if entries.len() > 100_000 {
                return Err(io::Error::other(
                    "This folder has too many entries to display.",
                ));
            }
        }
    }
    client.status(sftp::CLOSE, &handle)?;
    Ok(entries)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderReadError {
    message: String,
    permission_denied: bool,
}

#[tauri::command(async)]
pub fn list_transfer_folder(
    database: State<'_, Database>,
    connection_id: String,
    folder: Option<String>,
) -> Result<Folder, FolderReadError> {
    let connection =
        database
            .get_connection(&connection_id)
            .map_err(|message| FolderReadError {
                message,
                permission_denied: false,
            })?;
    let mut client = Sftp::connect(&connection).map_err(|error| FolderReadError {
        message: error.to_string(),
        permission_denied: false,
    })?;
    list(&mut client, folder.as_deref()).map_err(|error| FolderReadError {
        message: error.to_string(),
        permission_denied: error.kind() == io::ErrorKind::PermissionDenied,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Upload,
    Download,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    id: Uuid,
    direction: Direction,
    local_path: PathBuf,
    remote_path: String,
    replace: bool,
    #[serde(default)]
    folder: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    bytes: u64,
    total: Option<u64>,
    bytes_per_second: u64,
}

struct Meter<'a> {
    cancel: &'a AtomicBool,
    notify: &'a dyn Fn(Progress),
    start: Instant,
    last: Option<Instant>,
}

fn check_cancel(cancel: &AtomicBool) -> io::Result<()> {
    if cancel.load(Ordering::Acquire) {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "Transfer canceled.",
        ));
    }
    Ok(())
}

impl Meter<'_> {
    fn update(&mut self, bytes: u64, total: impl Into<Option<u64>>) -> io::Result<()> {
        check_cancel(self.cancel)?;
        let total = total.into();
        if total == Some(bytes)
            || self
                .last
                .is_none_or(|last| last.elapsed() >= Duration::from_millis(150))
        {
            (self.notify)(Progress {
                bytes,
                total,
                bytes_per_second: (bytes as f64 / self.start.elapsed().as_secs_f64().max(0.001))
                    as u64,
            });
            self.last = Some(Instant::now());
        }
        Ok(())
    }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Complete,
    Exists,
}

fn upload(client: &mut Sftp, spec: &Transfer, meter: &mut Meter<'_>) -> io::Result<Outcome> {
    let mut source = File::open(&spec.local_path)?;
    let metadata = source.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::other("Choose individual files to upload."));
    }
    let name = spec
        .local_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(bad_path)?;
    let folder = if spec.remote_path == "." {
        resolve_folder(client, ".")?
    } else {
        remote_path(&spec.remote_path)?
    };
    let destination = string(remote_child(&folder, name)?.as_bytes());
    match client.request(sftp::LSTAT, &destination, ATTRS) {
        Ok(mut attrs) => {
            if attrs.attributes()?.1 & TYPE_MASK != REGULAR {
                return Err(io::Error::other("The destination is not a regular file."));
            }
            if !spec.replace {
                return Ok(Outcome::Exists);
            }
            if !client.posix_rename {
                return Err(io::Error::other(
                    "This SFTP server cannot safely replace an existing file.",
                ));
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(e) => return Err(e),
    }
    let temporary = string(
        remote_child(&folder, &format!(".control-room-{}.part", Uuid::new_v4()))?.as_bytes(),
    );
    let mut open = temporary.clone();
    open.extend((2u32 | 8 | 32).to_be_bytes());
    open.extend(4u32.to_be_bytes());
    open.extend(0o600u32.to_be_bytes());
    let handle = client.handle(sftp::OPEN, &open)?;
    let result = (|| {
        let mut bytes = 0;
        meter.update(0, metadata.len())?;
        let chunk_size = client.chunk_size(metadata.len(), Direction::Upload, &handle)?;
        let mut chunk = vec![0; chunk_size];
        loop {
            let size = source.read(&mut chunk)?;
            if size == 0 {
                break;
            }
            let mut body = handle.clone();
            body.extend(u64::to_be_bytes(bytes));
            body.extend(string(&chunk[..size]));
            if let Err(error) = client.status(sftp::WRITE, &body) {
                if error.kind() == io::ErrorKind::Other && client.disk_full(&folder) {
                    return Err(io::Error::new(
                        io::ErrorKind::StorageFull,
                        "The host disk is full.",
                    ));
                }
                return Err(error);
            }
            bytes += size as u64;
            meter.update(bytes, metadata.len())?;
        }
        if bytes != metadata.len() {
            return Err(io::Error::other("The source file changed during upload."));
        }
        client.status(sftp::CLOSE, &handle)?;
        let (kind, mut rename) = if spec.replace && client.posix_rename {
            (sftp::EXTENDED, string(POSIX_RENAME))
        } else {
            (sftp::RENAME, Vec::new())
        };
        rename.extend(&temporary);
        rename.extend(&destination);
        meter.update(bytes, bytes)?;
        match client.status(kind, &rename) {
            Err(_) if !spec.replace && client.request(sftp::LSTAT, &destination, ATTRS).is_ok() => {
                Ok(Outcome::Exists)
            }
            result => result.map(|()| Outcome::Complete),
        }
    })();
    if !matches!(result, Ok(Outcome::Complete)) {
        let _ = client.status(sftp::CLOSE, &handle);
        let _ = client.status(sftp::REMOVE, &temporary);
    }
    result
}

fn resolve_folder(client: &mut Sftp, path: &str) -> io::Result<String> {
    let mut reply = client.request(sftp::REALPATH, &string(path.as_bytes()), NAME)?;
    if reply.number()? != 1 {
        return Err(invalid());
    }
    remote_path(std::str::from_utf8(reply.string()?).map_err(|_| invalid())?)
}

fn download(client: &mut Sftp, spec: &Transfer, meter: &mut Meter<'_>) -> io::Result<Outcome> {
    let source = remote_path(&spec.remote_path)?;
    let destination = download_destination(
        &spec.local_path,
        source.rsplit('/').next().ok_or_else(bad_path)?,
    )?;
    match fs::symlink_metadata(&destination) {
        Ok(meta) if !meta.is_file() => {
            return Err(io::Error::other("The destination is not a regular file."));
        }
        Ok(_) if !spec.replace => return Ok(Outcome::Exists),
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => (),
    }
    let mut temporary = tempfile::NamedTempFile::new_in(&spec.local_path)?;
    copy_remote_file(client, &source, &mut temporary, |bytes, total| {
        meter.update(bytes, total)
    })?;
    temporary.as_file().sync_all()?;
    check_cancel(meter.cancel)?;
    let result = if spec.replace {
        temporary.persist(destination)
    } else {
        temporary.persist_noclobber(destination)
    };
    match result {
        Ok(_) => Ok(Outcome::Complete),
        Err(e) if e.error.kind() == io::ErrorKind::AlreadyExists => Ok(Outcome::Exists),
        Err(e) => Err(e.error),
    }
}

fn copy_remote_file(
    client: &mut Sftp,
    source: &str,
    destination: &mut impl Write,
    mut report: impl FnMut(u64, u64) -> io::Result<()>,
) -> io::Result<u64> {
    let mut open = string(source.as_bytes());
    open.extend(1u32.to_be_bytes());
    open.extend(0u32.to_be_bytes());
    let handle = client.handle(sftp::OPEN, &open)?;
    let (total, mode) = client.request(sftp::FSTAT, &handle, ATTRS)?.attributes()?;
    if mode & TYPE_MASK != REGULAR {
        return Err(io::Error::other("Choose a regular file to download."));
    }
    let total = total.ok_or_else(invalid)?;
    let mut bytes = 0_u64;
    report(bytes, total)?;
    let chunk_size = client.chunk_size(total, Direction::Download, &handle)?;
    while bytes < total {
        let mut read = handle.clone();
        read.extend(bytes.to_be_bytes());
        let wanted = (total - bytes).min(chunk_size as u64) as u32;
        read.extend(wanted.to_be_bytes());
        let mut reply = client.request(sftp::READ, &read, DATA)?;
        let chunk = reply.string()?;
        if chunk.is_empty() || chunk.len() > wanted as usize {
            return Err(invalid());
        }
        destination.write_all(chunk)?;
        bytes += chunk.len() as u64;
        report(bytes, total)?;
    }
    client.status(sftp::CLOSE, &handle)?;
    Ok(bytes)
}

fn transfer(
    connection: &SavedConnection,
    spec: &Transfer,
    cancel: &AtomicBool,
    notify: &dyn Fn(Progress),
) -> io::Result<Outcome> {
    if !spec.local_path.is_absolute() {
        return Err(bad_path());
    }
    let mut client = Sftp::connect(connection)?;
    let mut meter = Meter {
        cancel,
        notify,
        start: Instant::now(),
        last: None,
    };
    match spec.direction {
        Direction::Upload => upload(&mut client, spec, &mut meter),
        Direction::Download if spec.folder => {
            folder_download::download_folder(&mut client, spec, &mut meter)
        }
        Direction::Download => download(&mut client, spec, &mut meter),
    }
}

#[tauri::command(async)]
pub fn transfer_file(
    database: State<'_, Database>,
    transfers: State<'_, Transfers>,
    connection_id: String,
    expected_target: (String, Option<String>, Option<u16>, Option<String>),
    spec: Transfer,
    progress: Channel<Progress>,
) -> Result<Outcome, String> {
    let allowed = match spec.direction {
        Direction::Upload => &transfers.uploads,
        Direction::Download => &transfers.downloads,
    };
    if !allowed.lock().contains(&spec.local_path) {
        return Err("Choose the local file or folder again.".into());
    }
    let connection = database.get_connection(&connection_id)?;
    if (
        &connection.destination,
        &connection.username,
        connection.port,
        &connection.identity_file,
    ) != (
        &expected_target.0,
        &expected_target.1,
        expected_target.2,
        &expected_target.3,
    ) {
        return Err("The saved host changed. Reopen Files on the updated connection.".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = transfers.active.lock();
        if active.contains_key(&spec.id) {
            return Err("This file is already transferring.".into());
        }
        active.insert(spec.id, cancel.clone());
    }
    let result = transfer(&connection, &spec, &cancel, &|value| {
        let _ = progress.send(value);
    });
    transfers.active.lock().remove(&spec.id);
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cancel_transfer(transfers: State<'_, Transfers>, id: Uuid) {
    if let Some(flag) = transfers.active.lock().get(&id) {
        flag.store(true, Ordering::Release);
    }
}
