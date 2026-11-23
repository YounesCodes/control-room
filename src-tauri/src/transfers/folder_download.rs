use super::*;

pub(super) fn download_folder(
    client: &mut Sftp,
    spec: &Transfer,
    meter: &mut Meter<'_>,
) -> io::Result<Outcome> {
    let source = remote_path(&spec.remote_path)?;
    let local_root = spec.local_path.canonicalize()?;
    let destination =
        download_destination(&local_root, source.rsplit('/').next().ok_or_else(bad_path)?)?;
    match fs::symlink_metadata(&destination) {
        Ok(_) => return Err(destination_exists()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => (),
        Err(error) => return Err(error),
    }

    let staging = tempfile::Builder::new()
        .prefix(".control-room-")
        .tempdir_in(&local_root)?;
    let root = staging.path().join("download");
    fs::create_dir(&root)?;
    let mut folders = vec![(source, root.clone())];
    let mut copied = 0_u64;
    while let Some((remote, local)) = folders.pop() {
        meter.update(copied, None)?;
        let (_, mode) = client
            .request(sftp::LSTAT, &string(remote.as_bytes()), ATTRS)?
            .attributes()?;
        if mode & TYPE_MASK != DIRECTORY {
            return Err(io::Error::other(
                "A remote folder changed during the download.",
            ));
        }
        for entry in read_entries(client, &remote, Some(meter.cancel))? {
            check_cancel(meter.cancel)?;
            if entry.kind == "other" {
                continue;
            }
            let source = remote_child(&remote, &entry.name)?;
            let target = download_destination(&local, &entry.name)?;
            let result = if entry.kind == "folder" {
                fs::create_dir(&target).map(|()| folders.push((source, target)))
            } else {
                copy_entry(client, &source, &target, &mut copied, meter)
            };
            if let Err(error) = result {
                if error.kind() == io::ErrorKind::Interrupted {
                    return Err(error);
                }
                return Err(io::Error::new(
                    error.kind(),
                    format!("{}: {error}", entry.name),
                ));
            }
        }
    }
    check_cancel(meter.cancel)?;
    publish_folder(&root, &destination).map_err(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists {
            destination_exists()
        } else {
            error
        }
    })?;
    Ok(Outcome::Complete)
}

fn copy_entry(
    client: &mut Sftp,
    source: &str,
    target: &Path,
    copied: &mut u64,
    meter: &mut Meter<'_>,
) -> io::Result<()> {
    let mut file = File::create_new(target)?;
    let bytes = copy_remote_file(client, source, &mut file, |bytes, _| {
        meter.update(copied.saturating_add(bytes), None)
    })?;
    file.sync_all()?;
    *copied = copied.saturating_add(bytes);
    Ok(())
}

fn destination_exists() -> io::Error {
    io::Error::new(
        io::ErrorKind::AlreadyExists,
        "That name already exists locally. Choose a different download location.",
    )
}

#[cfg(unix)]
fn publish_folder(source: &Path, destination: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let source = CString::new(source.as_os_str().as_bytes()).map_err(|_| bad_path())?;
    let destination = CString::new(destination.as_os_str().as_bytes()).map_err(|_| bad_path())?;
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(target_os = "macos")]
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn publish_folder(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileW;

    let source: Vec<_> = source.as_os_str().encode_wide().chain([0]).collect();
    let destination: Vec<_> = destination.as_os_str().encode_wide().chain([0]).collect();
    if unsafe { MoveFileW(source.as_ptr(), destination.as_ptr()) } != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publishes_only_when_no_destination_exists() {
        let local = tempfile::tempdir().unwrap();
        let source = local.path().join("staged");
        let destination = local.path().join("download");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("notes.txt"), "downloaded").unwrap();
        fs::create_dir(&destination).unwrap();
        assert!(publish_folder(&source, &destination).is_err());
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
        fs::remove_dir(&destination).unwrap();
        publish_folder(&source, &destination).unwrap();
        assert_eq!(
            fs::read_to_string(destination.join("notes.txt")).unwrap(),
            "downloaded"
        );
    }
}
