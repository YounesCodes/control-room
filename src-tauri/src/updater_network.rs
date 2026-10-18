use std::time::Duration;

use tauri_plugin_updater::{Update, Updater};

// This plugin version drops the check timeout from returned updates. Keep a
// separate finite deadline for downloads, including a response that stalls.
pub(crate) const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);

pub(crate) async fn check_with_download_timeout(
    updater: Updater,
    download_timeout: Duration,
) -> tauri_plugin_updater::Result<Option<Update>> {
    let mut update = updater.check().await?;
    if let Some(update) = update.as_mut() {
        update.timeout = Some(download_timeout);
    }
    Ok(update)
}
