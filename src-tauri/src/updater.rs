use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[path = "updater_network.rs"]
mod network;

use crate::database::Database;

const CHECK_TIMEOUT: Duration = Duration::from_secs(12);

/// The key the one-time post-update notice lives under in `application_settings`.
/// The table is already the app's generic key/value store, so this needs no new
/// table and no schema migration.
pub const PENDING_NOTICE_KEY: &str = "pending_update_notice";

/// What React is told about an available update. Deliberately narrow: a version,
/// human-readable notes, and a date. No URL, no signature, no raw feed JSON,
/// because the frontend has no decision to make with any of them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    /// The version running right now, read from the Tauri package metadata
    /// rather than hardcoded anywhere.
    pub current_version: String,
    pub version: String,
    pub notes: Option<String>,
    pub published_at: Option<String>,
}

/// The one-time "What's new" notice, written just before an install replaces
/// this process and read once by the version that install produced.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingUpdateNotice {
    pub version: String,
    pub notes: Option<String>,
    pub published_at: Option<String>,
}

/// Download progress, shaped so an unknown content length stays representable
/// rather than being faked as zero.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event")]
pub enum UpdateProgress {
    Started { content_length: Option<u64> },
    Progress { downloaded: u64, total: Option<u64> },
    Finished,
}

/// Which step failed. Collapsing these into one message would hide the only
/// distinction that matters: a signature failure is not a flaky network.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UpdateFailureKind {
    Check,
    Download,
    /// The downloaded package did not match the signature for the public key
    /// built into this binary. There is no path past this, by design.
    Signature,
    Install,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFailure {
    pub kind: UpdateFailureKind,
    pub message: String,
}

impl UpdateFailure {
    fn new(kind: UpdateFailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn from_download(error: tauri_plugin_updater::Error) -> Self {
        let kind = match error {
            tauri_plugin_updater::Error::Minisign(_)
            | tauri_plugin_updater::Error::Base64(_)
            | tauri_plugin_updater::Error::SignatureUtf8(_)
            | tauri_plugin_updater::Error::MissingSignedVersion
            | tauri_plugin_updater::Error::SignedVersionMismatch { .. } => {
                UpdateFailureKind::Signature
            }
            _ => UpdateFailureKind::Download,
        };
        Self::new(kind, describe(&error))
    }
}

fn describe(error: &tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error;
    match error {
        Error::EmptyEndpoints => "No update endpoint is configured in this build.".into(),
        Error::ReleaseNotFound => "No published release information was found.".into(),
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) => {
            "That release has no package for this platform.".into()
        }
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::MissingSignedVersion
        | Error::SignedVersionMismatch { .. } => "The update signature did not verify.".into(),
        Error::Reqwest(_) | Error::Network(_) | Error::Io(_) => {
            "Could not reach the update endpoint.".into()
        }
        Error::Semver(_) => "The published version number could not be read.".into(),
        other => other.to_string(),
    }
}

/// The pending update and its downloaded bytes.
///
/// One authoritative place, so a second check cannot replace an update that is
/// mid-download and an install can never run against bytes that belong to a
/// different version.
#[derive(Default)]
pub struct UpdaterState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    pending: Option<Arc<Update>>,
    downloaded: Option<Vec<u8>>,
    checking: bool,
    downloading: bool,
    installing: bool,
}

impl UpdaterState {
    fn begin_check(&self) -> bool {
        let mut inner = self.inner.lock();
        if inner.checking || inner.downloading || inner.installing {
            return false;
        }
        inner.checking = true;
        true
    }

    fn end_check(&self) {
        self.inner.lock().checking = false;
    }

    fn set_pending(&self, update: Option<Arc<Update>>) {
        let mut inner = self.inner.lock();
        inner.pending = update;
        inner.downloaded = None;
    }

    fn begin_download(&self) -> Result<Arc<Update>, UpdateFailure> {
        let mut inner = self.inner.lock();
        if inner.checking || inner.downloading || inner.installing {
            return Err(UpdateFailure::new(
                UpdateFailureKind::Download,
                "Another update operation is already running.",
            ));
        }
        let Some(update) = inner.pending.clone() else {
            return Err(UpdateFailure::new(
                UpdateFailureKind::Download,
                "No update is available to download.",
            ));
        };
        inner.downloading = true;
        Ok(update)
    }

    fn end_download(&self, bytes: Option<Vec<u8>>) {
        let mut inner = self.inner.lock();
        inner.downloading = false;
        inner.downloaded = bytes;
    }

    fn begin_install(&self) -> Option<(Arc<Update>, Vec<u8>)> {
        let mut inner = self.inner.lock();
        if inner.checking || inner.downloading || inner.installing {
            return None;
        }
        let update = inner.pending.clone()?;
        let bytes = inner.downloaded.take()?;
        inner.installing = true;
        Some((update, bytes))
    }

    fn end_install(&self) {
        self.inner.lock().installing = false;
    }
}

fn format_published(date: Option<time::OffsetDateTime>) -> Option<String> {
    let date = date?;
    chrono::DateTime::from_timestamp(date.unix_timestamp(), date.nanosecond())
        .map(|value| value.to_rfc3339())
}

fn describe_update(update: &Update) -> AppUpdateInfo {
    AppUpdateInfo {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        notes: update
            .body
            .as_ref()
            .map(|body| body.trim().to_string())
            .filter(|body| !body.is_empty()),
        published_at: format_published(update.date),
    }
}

/// Asks the configured endpoint whether a newer version exists.
///
pub(crate) fn in_app_updates() -> bool {
    #[cfg(target_os = "linux")]
    {
        crate::appimage::running()
    }
    #[cfg(not(target_os = "linux"))]
    cfg!(any(windows, target_os = "macos"))
}

/// Returns `Ok(None)` when this build is current. The plugin's default
/// comparison accepts a release only when its semver is strictly greater than
/// the running version, which is what keeps this from ever offering a
/// downgrade.
#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<Option<AppUpdateInfo>, UpdateFailure> {
    if !in_app_updates() {
        return Err(UpdateFailure::new(
            UpdateFailureKind::Check,
            "Get the latest installer from Control Room releases.",
        ));
    }
    if !state.begin_check() {
        return Err(UpdateFailure::new(
            UpdateFailureKind::Check,
            "Another update operation is already running.",
        ));
    }
    let result = run_check(&app).await;
    let result = match result {
        Ok(Some(update)) => {
            let info = describe_update(&update);
            state.set_pending(Some(Arc::new(update)));
            Ok(Some(info))
        }
        Ok(None) => {
            state.set_pending(None);
            Ok(None)
        }
        Err(failure) => Err(failure),
    };
    state.end_check();
    result
}

async fn run_check(app: &AppHandle) -> Result<Option<Update>, UpdateFailure> {
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|error| UpdateFailure::new(UpdateFailureKind::Check, describe(&error)))?;
    network::check_with_download_timeout(updater, network::DOWNLOAD_TIMEOUT)
        .await
        .map_err(|error| UpdateFailure::new(UpdateFailureKind::Check, describe(&error)))
}

/// Downloads and verifies the pending update, keeping the bytes in memory.
///
/// Nothing is installed here. The download runs off the UI thread and holds no
/// lock, so terminals, log streams, and Structured Operations keep running
/// while it works.
#[tauri::command]
pub async fn download_update(
    state: State<'_, UpdaterState>,
    progress: Channel<UpdateProgress>,
) -> Result<(), UpdateFailure> {
    let update = state.begin_download()?;

    let mut downloaded: u64 = 0;
    let mut reported: u64 = 0;
    let mut started = false;

    let result = update
        .download(
            |chunk, content_length| {
                if !started {
                    started = true;
                    let _ = progress.send(UpdateProgress::Started { content_length });
                }
                downloaded += chunk as u64;
                let step = content_length.map_or(512 * 1024, |total| (total / 100).max(1));
                if downloaded - reported >= step || Some(downloaded) == content_length {
                    reported = downloaded;
                    let _ = progress.send(UpdateProgress::Progress {
                        downloaded,
                        total: content_length,
                    });
                }
            },
            || {},
        )
        .await;

    match result {
        Ok(bytes) => {
            state.end_download(Some(bytes));
            let _ = progress.send(UpdateProgress::Finished);
            Ok(())
        }
        Err(error) => {
            state.end_download(None);
            Err(UpdateFailure::from_download(error))
        }
    }
}

/// Records the one-time notice, then installs.
///
/// The notice is written first because an installer may replace this process,
/// so anything held only in memory at this point can disappear. On Windows the
/// NSIS install does not return; macOS may return and use the restart below.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    state: State<'_, UpdaterState>,
    database: State<'_, Database>,
) -> Result<(), UpdateFailure> {
    let Some((update, bytes)) = state.begin_install() else {
        return Err(UpdateFailure::new(
            UpdateFailureKind::Install,
            "No downloaded update is ready to install.",
        ));
    };

    let info = describe_update(&update);
    let notice = PendingUpdateNotice {
        version: info.version.clone(),
        notes: info.notes.clone(),
        published_at: info.published_at.clone(),
    };
    if let Ok(payload) = serde_json::to_string(&notice) {
        let _ = database.set_app_metadata(PENDING_NOTICE_KEY, &payload);
    }

    if let Err(error) = update.install(bytes) {
        state.end_install();
        return Err(UpdateFailure::new(
            UpdateFailureKind::Install,
            describe(&error),
        ));
    }

    // Only reached where the installer leaves this process running.
    app.restart();
}

/// The notice for an update that has actually been installed.
///
/// The stored version must equal the version now running. Anything else is a
/// notice for an install that never completed, and it is cleared rather than
/// shown, so a cancelled update never produces a "What's new" for a version the
/// user is not on.
#[tauri::command]
pub fn pending_update_notice(
    app: AppHandle,
    database: State<'_, Database>,
) -> Result<Option<PendingUpdateNotice>, String> {
    let stored = database.get_app_metadata(PENDING_NOTICE_KEY)?;
    let current = app.package_info().version.to_string();
    match decide_notice(stored.as_deref(), &current) {
        NoticeDecision::Show(notice) => Ok(Some(notice)),
        NoticeDecision::Discard => {
            database.delete_app_metadata(PENDING_NOTICE_KEY)?;
            Ok(None)
        }
        NoticeDecision::Nothing => Ok(None),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum NoticeDecision {
    Show(PendingUpdateNotice),
    Discard,
    Nothing,
}

fn decide_notice(stored: Option<&str>, current_version: &str) -> NoticeDecision {
    let Some(payload) = stored else {
        return NoticeDecision::Nothing;
    };
    let Ok(notice) = serde_json::from_str::<PendingUpdateNotice>(payload) else {
        return NoticeDecision::Discard;
    };
    if notice.version == current_version {
        NoticeDecision::Show(notice)
    } else {
        NoticeDecision::Discard
    }
}

/// Consumes the notice so it is shown once and never again.
#[tauri::command]
pub fn dismiss_update_notice(database: State<'_, Database>) -> Result<(), String> {
    database.delete_app_metadata(PENDING_NOTICE_KEY)
}

/// The running version, read from the Tauri package metadata so it can never
/// drift from what was built.
#[tauri::command]
pub fn current_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_check_is_refused_while_one_is_running() {
        let state = UpdaterState::default();
        assert!(state.begin_check());
        assert!(!state.begin_check(), "two checks would race over `pending`");
        state.end_check();
        assert!(state.begin_check(), "a finished check releases the claim");
    }

    #[test]
    fn downloading_requires_a_pending_update() {
        let state = UpdaterState::default();
        let Err(failure) = state.begin_download() else {
            panic!("a download with no pending update must be refused");
        };
        assert_eq!(failure.kind, UpdateFailureKind::Download);
    }

    #[test]
    fn update_operations_cannot_overlap() {
        let state = UpdaterState::default();
        for (checking, downloading, installing) in [
            (true, false, false),
            (false, true, false),
            (false, false, true),
        ] {
            {
                let mut inner = state.inner.lock();
                inner.checking = checking;
                inner.downloading = downloading;
                inner.installing = installing;
            }
            assert!(!state.begin_check());
            let Err(failure) = state.begin_download() else {
                panic!("an overlapping download was admitted");
            };
            assert_eq!(
                failure.message,
                "Another update operation is already running."
            );
            assert!(state.begin_install().is_none());
        }
        state.inner.lock().downloading = false;
        state.end_install();
        assert!(state.begin_check());
    }

    #[test]
    fn installing_requires_downloaded_bytes() {
        let state = UpdaterState::default();
        assert!(state.begin_install().is_none());
        state.end_download(Some(vec![1, 2, 3]));
        assert!(state.begin_install().is_none());
    }

    #[test]
    fn a_new_check_discards_bytes_from_the_previous_one() {
        let state = UpdaterState::default();
        state.end_download(Some(vec![1, 2, 3]));
        state.set_pending(None);
        assert!(
            state.inner.lock().downloaded.is_none(),
            "bytes belong to the update they were downloaded for"
        );
    }

    #[test]
    fn signature_errors_are_not_reported_as_network_errors() {
        let failure =
            UpdateFailure::from_download(tauri_plugin_updater::Error::SignatureUtf8("bad".into()));
        assert_eq!(failure.kind, UpdateFailureKind::Signature);

        let failure = UpdateFailure::from_download(tauri_plugin_updater::Error::ReleaseNotFound);
        assert_eq!(failure.kind, UpdateFailureKind::Download);
        for error in [
            tauri_plugin_updater::Error::MissingSignedVersion,
            tauri_plugin_updater::Error::SignedVersionMismatch {
                signed: "1.0.0".into(),
                announced: "9.9.9".into(),
            },
        ] {
            let failure = UpdateFailure::from_download(error);
            assert_eq!(failure.kind, UpdateFailureKind::Signature);
            assert_eq!(failure.message, "The update signature did not verify.");
        }
    }

    fn notice(version: &str) -> String {
        serde_json::to_string(&PendingUpdateNotice {
            version: version.into(),
            notes: Some("- a change".into()),
            published_at: None,
        })
        .unwrap()
    }

    #[test]
    fn a_notice_is_shown_only_for_the_version_now_running() {
        let stored = notice("0.7.0");
        assert!(matches!(
            decide_notice(Some(&stored), "0.7.0"),
            NoticeDecision::Show(_)
        ));
    }

    #[test]
    fn a_notice_for_an_install_that_never_happened_is_discarded() {
        let stored = notice("0.7.0");
        assert_eq!(
            decide_notice(Some(&stored), "0.6.1"),
            NoticeDecision::Discard
        );
    }

    #[test]
    fn a_consumed_notice_shows_nothing() {
        assert_eq!(decide_notice(None, "0.7.0"), NoticeDecision::Nothing);
    }

    #[test]
    fn an_unreadable_notice_is_discarded_rather_than_failing_startup() {
        assert_eq!(
            decide_notice(Some("not json"), "0.7.0"),
            NoticeDecision::Discard
        );
    }

    #[test]
    fn a_published_date_becomes_rfc3339() {
        let date = time::OffsetDateTime::from_unix_timestamp(1_757_000_000).unwrap();
        let formatted = format_published(Some(date)).expect("formats");
        assert!(formatted.starts_with("2025-09-"), "got {formatted}");
        assert!(format_published(None).is_none());
    }
}
