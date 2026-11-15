use std::{
    env,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

pub(crate) fn running() -> bool {
    use tauri::utils::{config::BundleType, platform::bundle_type};
    bundle_type() == Some(BundleType::AppImage)
}

// AppRun adds paths for the app and its WebKit subprocesses. System programs
// launched by the app must resolve their own libraries, Python, and GTK data.
pub(crate) fn host_environment() -> impl Iterator<Item = (&'static str, Option<OsString>)> {
    const PATH_VARIABLES: &[&str] = &[
        "PATH",
        "LD_LIBRARY_PATH",
        "PYTHONHOME",
        "PYTHONPATH",
        "PERLLIB",
        "XDG_DATA_DIRS",
        "GSETTINGS_SCHEMA_DIR",
        "QT_PLUGIN_PATH",
        "GST_PLUGIN_SYSTEM_PATH",
        "GST_PLUGIN_SYSTEM_PATH_1_0",
        "GTK_DATA_PREFIX",
        "GTK_EXE_PREFIX",
        "GTK_PATH",
        "GTK_IM_MODULE_FILE",
        "GDK_PIXBUF_MODULE_FILE",
        "GI_TYPELIB_PATH",
        "GIO_MODULE_DIR",
    ];
    running()
        .then(|| env::var_os("APPDIR").map(PathBuf::from))
        .flatten()
        .filter(|appdir| appdir.is_absolute())
        .into_iter()
        .flat_map(|appdir| {
            PATH_VARIABLES.iter().filter_map(move |&name| {
                let value = env::var_os(name)?;
                let cleaned = without_bundle_paths(&appdir, &value);
                (cleaned.as_deref() != Some(value.as_os_str())).then_some((name, cleaned))
            })
        })
}

fn without_bundle_paths(appdir: &Path, value: &OsStr) -> Option<OsString> {
    let mut paths = env::split_paths(value)
        .filter(|path| !path.as_os_str().is_empty() && !path.starts_with(appdir))
        .peekable();
    paths.peek()?;
    env::join_paths(paths).ok()
}

pub(crate) fn configure_pty(command: &mut portable_pty::CommandBuilder) {
    for (name, value) in host_environment() {
        match value {
            Some(value) => command.env(name, value),
            None => command.env_remove(name),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_paths_keep_host_entries_without_bundle_libraries_or_empty_entries() {
        let appdir = Path::new("/tmp/.mount_control");
        assert_eq!(
            without_bundle_paths(
                appdir,
                OsStr::new(
                    "/tmp/.mount_control/usr/lib::/usr/local/lib:/tmp/.mount_control-other/lib"
                ),
            ),
            Some("/usr/local/lib:/tmp/.mount_control-other/lib".into())
        );
        assert_eq!(
            without_bundle_paths(appdir, OsStr::new("/tmp/.mount_control/usr/")),
            None
        );
    }
}
