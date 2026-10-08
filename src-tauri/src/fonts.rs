//! Catalog previews stay in memory. Only install_catalog_font writes user fonts.
use std::{
    collections::HashMap,
    io::Read,
    path::Path,
    sync::{Arc, OnceLock},
    time::Duration,
};

use parking_lot::Mutex;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, State,
    ipc::{Channel, Response},
};

const CATALOG: &str = "https://api.fontsource.org/v1/fonts?category=monospace&type=google&weights=400&styles=normal&subsets=latin";
const MAX_DOWNLOAD: usize = 8 * 1024 * 1024;
const MAX_PREVIEW_CACHE: usize = 16 * 1024 * 1024;

#[derive(Clone, Default)]
pub struct FontState {
    catalog: Arc<Mutex<Vec<CatalogFont>>>,
    previews: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    installation: Arc<Mutex<()>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CatalogFont {
    pub id: String,
    pub family: String,
    pub license: String,
    category: String,
    #[serde(rename = "type")]
    source_type: String,
    weights: Vec<u16>,
    styles: Vec<String>,
    subsets: Vec<String>,
}

#[derive(Serialize)]
pub struct FontCatalog {
    fonts: Vec<CatalogFont>,
    stale: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontProgress {
    pub stage: &'static str,
    pub completed: u64,
    pub total: Option<u64>,
}

fn client() -> Result<Client, String> {
    // Match the updater's existing provider. The catalog can be used before
    // any update check initializes TLS, including with automatic checks off.
    let _ = rustls::crypto::ring::default_provider().install_default();
    Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        // Google returns complete TrueType fonts for this non-browser client.
        .user_agent(concat!(
            "ControlRoom/",
            env!("CARGO_PKG_VERSION"),
            " font installer"
        ))
        .build()
        .map_err(|e| format!("Could not start font download: {e}"))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn usable(font: &CatalogFont) -> bool {
    valid_id(&font.id)
        && !font.family.is_empty()
        && font.family.len() <= 100
        && font
            .family
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '-')
        && matches!(font.license.as_str(), "OFL-1.1" | "Apache-2.0" | "UFL-1.0")
        && font.category == "monospace"
        && font.source_type == "google"
        && font.weights.contains(&400)
        && font.styles.iter().any(|s| s == "normal")
        && font.subsets.len() <= 32
        && font.subsets.iter().all(|s| s.len() <= 32 && valid_id(s))
        && font.subsets.iter().any(|s| s == "latin")
}

fn download(
    client: &Client,
    url: &str,
    limit: usize,
    mut report: impl FnMut(u64, Option<u64>),
) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Font service unavailable. Check your connection and retry. {e}"))?;
    if response.status().is_redirection() {
        return Err("Font service redirected the download. Retry later.".into());
    }
    let total = response.content_length();
    if total.is_some_and(|n| n > limit as u64) {
        return Err("Font service returned a file that is too large.".into());
    }
    let mut bytes = Vec::new();
    let mut buffer = [0; 16 * 1024];
    report(0, total);
    loop {
        let count = response
            .read(&mut buffer)
            .map_err(|e| format!("Font download interrupted. Retry the download. {e}"))?;
        if count == 0 {
            break;
        }
        if bytes.len() + count > limit {
            return Err("Font service returned a file that is too large.".into());
        }
        bytes.extend_from_slice(&buffer[..count]);
        report(bytes.len() as u64, total);
    }
    if total.is_some_and(|n| n != bytes.len() as u64) {
        return Err("Font download was incomplete. Retry the download.".into());
    }
    Ok(bytes)
}

fn read_catalog(client: &Client) -> Result<Vec<CatalogFont>, String> {
    let data = download(client, CATALOG, 2 * 1024 * 1024, |_, _| {})?;
    let mut fonts: Vec<CatalogFont> = serde_json::from_slice(&data)
        .map_err(|e| format!("Could not read the font catalog: {e}"))?;
    fonts.retain(usable);
    fonts.sort_by(|a, b| a.family.cmp(&b.family));
    fonts.dedup_by(|a, b| a.id == b.id);
    if fonts.is_empty() {
        return Err(
            "The font catalog has no supported freely usable monospace fonts. Retry later.".into(),
        );
    }
    Ok(fonts)
}

fn catalog_font(state: &FontState, id: &str) -> Result<CatalogFont, String> {
    if !valid_id(id) {
        return Err("Invalid catalog font.".into());
    }
    if state.catalog.lock().is_empty() {
        *state.catalog.lock() = read_catalog(&client()?)?;
    }
    state
        .catalog
        .lock()
        .iter()
        .find(|f| f.id == id)
        .cloned()
        .ok_or_else(|| "This font is no longer in the catalog. Refresh and retry.".into())
}

// Ignore arbitrary URLs in catalog data. Only Google's fixed HTTPS font host
// can supply installable bytes; redirects, credentials, and query strings fail.
fn ttf_urls(css: &str) -> Result<Vec<String>, String> {
    static EXPRESSION: OnceLock<regex::Regex> = OnceLock::new();
    let expression = EXPRESSION.get_or_init(|| {
        regex::Regex::new(r"url\((https://fonts\.gstatic\.com/s/[A-Za-z0-9_./-]+\.ttf)\)").unwrap()
    });
    let urls: Vec<_> = expression
        .captures_iter(css)
        .map(|c| c[1].to_string())
        .collect();
    if urls.is_empty() {
        return Err(
            "The font service did not provide a Windows TrueType font. Retry later.".into(),
        );
    }
    Ok(urls)
}

fn validate_font(bytes: &[u8], family: &str, weight: u16) -> Result<(), String> {
    let face = ttf_parser::Face::parse(bytes, 0).map_err(|_| {
        "Downloaded file is not a valid TrueType font. Retry the download.".to_string()
    })?;
    if face.weight().to_number() != weight {
        return Err(
            "Downloaded font does not match the requested weight. Retry the download.".into(),
        );
    }
    let matches = face.names().into_iter().any(|n| {
        matches!(
            n.name_id,
            ttf_parser::name_id::FAMILY | ttf_parser::name_id::TYPOGRAPHIC_FAMILY
        ) && n.to_string().is_some_and(|s| s == family)
    });
    if !matches {
        return Err(
            "Downloaded font does not match the selected family. The current font was kept.".into(),
        );
    }
    Ok(())
}

fn font_bytes(
    client: &Client,
    font: &CatalogFont,
    weight: u16,
    report: impl FnMut(u64, Option<u64>),
) -> Result<Vec<u8>, String> {
    let mut url = reqwest::Url::parse("https://fonts.googleapis.com/css").unwrap();
    url.query_pairs_mut()
        .append_pair("family", &format!("{}:{weight}", font.family));
    url.query_pairs_mut()
        .append_pair("subset", &font.subsets.join(","));
    let css = download(client, url.as_str(), 64 * 1024, |_, _| {})?;
    let css =
        std::str::from_utf8(&css).map_err(|_| "Invalid font download metadata.".to_string())?;
    let urls = ttf_urls(css)?;
    if urls.len() != 1 {
        return Err("The font service returned an unsupported split font. Retry later.".into());
    }
    let bytes = download(client, &urls[0], MAX_DOWNLOAD, report)?;
    validate_font(&bytes, &font.family, weight)?;
    Ok(bytes)
}

async fn font_worker<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("Could not finish the font operation. Retry. {error}"))?
}

#[tauri::command]
pub async fn list_catalog_fonts(state: State<'_, FontState>) -> Result<FontCatalog, String> {
    let state = state.inner().clone();
    font_worker(move || list_fonts(&state)).await
}

fn list_fonts(state: &FontState) -> Result<FontCatalog, String> {
    match read_catalog(&client()?) {
        Ok(fonts) => {
            *state.catalog.lock() = fonts.clone();
            Ok(FontCatalog {
                fonts,
                stale: false,
            })
        }
        Err(error) => {
            let fonts = state.catalog.lock().clone();
            if fonts.is_empty() {
                Err(error)
            } else {
                Ok(FontCatalog { fonts, stale: true })
            }
        }
    }
}

#[tauri::command]
pub async fn preview_catalog_font(
    state: State<'_, FontState>,
    id: String,
) -> Result<Response, String> {
    let state = state.inner().clone();
    font_worker(move || preview_font(&state, id)).await
}

fn cache_preview(cache: &mut HashMap<String, Vec<u8>>, id: String, bytes: Vec<u8>) {
    cache.remove(&id);
    while cache.len() >= 16
        || cache.values().map(Vec::len).sum::<usize>() + bytes.len() > MAX_PREVIEW_CACHE
    {
        let Some(key) = cache.keys().next().cloned() else {
            break;
        };
        cache.remove(&key);
    }
    cache.insert(id, bytes);
}

fn preview_font(state: &FontState, id: String) -> Result<Response, String> {
    let font = catalog_font(state, &id)?;
    if let Some(bytes) = state.previews.lock().get(&id).cloned() {
        return Ok(Response::new(bytes));
    }
    let bytes = font_bytes(&client()?, &font, 400, |_, _| {})?;
    let mut cache = state.previews.lock();
    cache_preview(&mut cache, id, bytes.clone());
    Ok(Response::new(bytes))
}

struct InstalledFile {
    path: std::path::PathBuf,
    created: bool,
    registered: bool,
    key: String,
}

trait FontRegistration {
    // Returns true only when this call created a registry entry and resource.
    fn register(&self, path: &Path, key: &str) -> Result<bool, String>;
    fn unregister(&self, path: &Path, key: &str);
}

// Publish a fully synced staging file without replacing an existing font.
fn write_font_file(path: &Path, bytes: &[u8]) -> Result<bool, String> {
    use std::io::Write;
    let staging = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&staging)
            .map_err(|e| format!("Cannot write to your Windows font folder. Check folder permissions and retry. {e}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("Cannot write the font file. Check disk space and retry. {e}"))?;
        drop(file);
        match std::fs::hard_link(&staging, path) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if std::fs::read(path).map_err(|e| format!("Cannot read existing font: {e}"))?
                    != bytes
                {
                    return Err("A different version of this font already exists in your Windows font folder. Remove it through Windows Settings before retrying.".into());
                }
                Ok(false)
            }
            Err(e) => Err(format!(
                "Cannot publish the font file in your Windows font folder. Check folder permissions and retry. {e}"
            )),
        }
    })();
    let _ = std::fs::remove_file(&staging);
    result
}

fn install_files(
    directory: &Path,
    font: &CatalogFont,
    files: &[(u16, Vec<u8>)],
    registration: &impl FontRegistration,
    mut progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    std::fs::create_dir_all(directory).map_err(|e| {
        format!("Cannot create your Windows font folder. Check folder permissions and retry. {e}")
    })?;
    let mut installed: Vec<InstalledFile> = Vec::new();
    let result = (|| {
        for (index, (weight, bytes)) in files.iter().enumerate() {
            validate_font(bytes, &font.family, *weight)?;
            let path = directory.join(format!("ControlRoom-{}-{weight}.ttf", font.id));
            let created = write_font_file(&path, bytes)?;
            installed.push(InstalledFile {
                path,
                created,
                registered: false,
                key: format!("Control Room {} {weight} (TrueType)", font.id),
            });
            let entry = installed.last_mut().unwrap();
            entry.registered = registration.register(&entry.path, &entry.key)?;
            progress(index as u64 + 1, files.len() as u64);
        }
        Ok(())
    })();
    if result.is_err() {
        for entry in installed.iter().rev() {
            if entry.registered {
                registration.unregister(&entry.path, &entry.key);
            }
            if entry.created {
                let _ = std::fs::remove_file(&entry.path);
            }
        }
    }
    result
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::ptr;
    use windows_sys::Win32::{
        Graphics::Gdi::{AddFontResourceExW, RemoveFontResourceExW},
        System::Registry::*,
        UI::WindowsAndMessaging::*,
    };

    pub struct UserFonts;
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }
    struct Key(HKEY);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }
    fn open_key() -> Result<Key, String> {
        let mut key = ptr::null_mut();
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                wide("Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts").as_ptr(),
                0,
                ptr::null(),
                0,
                KEY_QUERY_VALUE | KEY_SET_VALUE,
                ptr::null(),
                &mut key,
                ptr::null_mut(),
            )
        };
        if status != 0 {
            return Err(format!(
                "Windows denied access to your account's font registry. Check account policy and retry. Windows error {status}."
            ));
        }
        Ok(Key(key))
    }
    pub fn notify() {
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_FONTCHANGE,
                0,
                0,
                SMTO_ABORTIFHUNG,
                1000,
                ptr::null_mut(),
            );
        }
    }
    impl FontRegistration for UserFonts {
        fn register(&self, path: &Path, name: &str) -> Result<bool, String> {
            let key = open_key()?;
            let name = wide(name);
            let path = wide(&path.to_string_lossy());
            let mut existing = [0_u16; 32768];
            let mut length = std::mem::size_of_val(&existing) as u32;
            let status = unsafe {
                RegGetValueW(
                    key.0,
                    ptr::null(),
                    name.as_ptr(),
                    RRF_RT_REG_SZ,
                    ptr::null_mut(),
                    existing.as_mut_ptr().cast(),
                    &mut length,
                )
            };
            let already_registered = status == 0;
            if already_registered && existing[..length as usize / 2] != path {
                return Err("An existing Windows font registration uses this name. Remove the conflicting font in Windows Settings before retrying.".into());
            }
            if status != 0 && status != 2 {
                return Err(format!(
                    "Cannot read the Windows font registration. Windows error {status}."
                ));
            }
            if !already_registered {
                let status = unsafe {
                    RegSetValueExW(
                        key.0,
                        name.as_ptr(),
                        0,
                        REG_SZ,
                        path.as_ptr().cast(),
                        (path.len() * 2) as u32,
                    )
                };
                if status != 0 {
                    return Err(format!(
                        "Cannot register the font for your Windows account. Check account policy and retry. Windows error {status}."
                    ));
                }
            }
            if unsafe { AddFontResourceExW(path.as_ptr(), 0, ptr::null()) } == 0 {
                if !already_registered {
                    unsafe {
                        RegDeleteValueW(key.0, name.as_ptr());
                    }
                }
                return Err("Windows could not load the downloaded font. Retry, or remove a conflicting font in Windows Settings.".into());
            }
            Ok(!already_registered)
        }
        fn unregister(&self, path: &Path, name: &str) {
            unsafe {
                RemoveFontResourceExW(wide(&path.to_string_lossy()).as_ptr(), 0, ptr::null());
            }
            if let Ok(key) = open_key() {
                unsafe {
                    RegDeleteValueW(key.0, wide(name).as_ptr());
                }
            }
            notify();
        }
    }
}

#[tauri::command]
pub async fn install_catalog_font(
    app: AppHandle,
    state: State<'_, FontState>,
    id: String,
    progress: Channel<FontProgress>,
) -> Result<String, String> {
    let state = state.inner().clone();
    font_worker(move || install_font(app, &state, id, progress)).await
}

fn install_font(
    app: AppHandle,
    state: &FontState,
    id: String,
    progress: Channel<FontProgress>,
) -> Result<String, String> {
    let font = catalog_font(state, &id)?;
    let client = client()?;
    let weights = if font.weights.contains(&700) {
        vec![400, 700]
    } else {
        vec![400]
    };
    let mut files = Vec::new();
    for weight in weights {
        let bytes = font_bytes(&client, &font, weight, |completed, total| {
            let _ = progress.send(FontProgress {
                stage: if weight == 400 {
                    "downloadingRegular"
                } else {
                    "downloadingBold"
                },
                completed,
                total,
            });
        })?;
        files.push((weight, bytes));
    }
    let _guard = state
        .installation
        .try_lock()
        .ok_or("A font installation is already running. Wait until it finishes.")?;
    let directory = app
        .path()
        .local_data_dir()
        .map_err(|e| e.to_string())?
        .join("Microsoft/Windows/Fonts");
    let _ = progress.send(FontProgress {
        stage: "installing",
        completed: 0,
        total: Some(files.len() as u64),
    });
    #[cfg(windows)]
    {
        install_files(
            &directory,
            &font,
            &files,
            &windows::UserFonts,
            |completed, total| {
                let _ = progress.send(FontProgress {
                    stage: "installing",
                    completed,
                    total: Some(total),
                });
            },
        )?;
        windows::notify();
        let mut cache = state.previews.lock();
        cache_preview(&mut cache, id, files[0].1.clone());
    }
    #[cfg(not(windows))]
    {
        let _ = directory;
        return Err("Font installation requires Windows.".into());
    }
    #[cfg(windows)]
    {
        let _ = progress.send(FontProgress {
            stage: "ready",
            completed: files.len() as u64,
            total: Some(files.len() as u64),
        });
        Ok(font.family)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn font_worker_builds_and_drops_http_clients_outside_the_async_runtime() {
        tauri::async_runtime::block_on(async {
            font_worker(|| {
                let _client = client()?;
                Ok(())
            })
            .await
            .unwrap();
        });
    }
    #[cfg(windows)]
    fn windows_font_fixture() -> (CatalogFont, Vec<u8>) {
        let directory = std::path::PathBuf::from(std::env::var_os("WINDIR").unwrap()).join("Fonts");
        let bytes = std::fs::read(directory.join("consola.ttf")).unwrap();
        let mut font = font();
        font.family = "Consolas".into();
        (font, bytes)
    }

    #[cfg(windows)]
    #[test]
    fn partial_install_rolls_back_new_files_and_registrations() {
        struct FailSecond(Mutex<Vec<String>>);
        impl FontRegistration for FailSecond {
            fn register(&self, _: &Path, key: &str) -> Result<bool, String> {
                if key.contains("700") {
                    return Err("Registry denied access".into());
                }
                self.0.lock().push(key.into());
                Ok(true)
            }
            fn unregister(&self, _: &Path, key: &str) {
                self.0.lock().retain(|entry| entry != key);
            }
        }
        let (font, bytes) = windows_font_fixture();
        let directory = tempfile::tempdir().unwrap();
        let registration = FailSecond(Mutex::new(Vec::new()));
        assert!(
            install_files(
                directory.path(),
                &font,
                &[
                    (400, bytes.clone()),
                    (
                        700,
                        std::fs::read(
                            std::path::PathBuf::from(std::env::var_os("WINDIR").unwrap())
                                .join("Fonts/consolab.ttf")
                        )
                        .unwrap()
                    )
                ],
                &registration,
                |_, _| {}
            )
            .is_err()
        );
        assert!(registration.0.lock().is_empty());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn retry_preserves_identical_and_conflicting_existing_files() {
        struct Fail;
        impl FontRegistration for Fail {
            fn register(&self, _: &Path, _: &str) -> Result<bool, String> {
                Err("Windows refused installation".into())
            }
            fn unregister(&self, _: &Path, _: &str) {
                panic!("no registration created");
            }
        }
        let (font, bytes) = windows_font_fixture();
        let directory = tempfile::tempdir().unwrap();
        let path = directory
            .path()
            .join(format!("ControlRoom-{}-400.ttf", font.id));
        std::fs::write(&path, &bytes).unwrap();
        assert!(
            install_files(
                directory.path(),
                &font,
                &[(400, bytes.clone())],
                &Fail,
                |_, _| {}
            )
            .is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        std::fs::write(&path, b"existing different font").unwrap();
        assert!(
            install_files(directory.path(), &font, &[(400, bytes)], &Fail, |_, _| {})
                .unwrap_err()
                .contains("different version")
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"existing different font");
    }

    #[cfg(windows)]
    #[test]
    fn valid_font_checks_family_and_reports_install_progress() {
        struct Accept;
        impl FontRegistration for Accept {
            fn register(&self, _: &Path, _: &str) -> Result<bool, String> {
                Ok(true)
            }
            fn unregister(&self, _: &Path, _: &str) {}
        }
        let (font, bytes) = windows_font_fixture();
        assert!(validate_font(&bytes, "Different family", 400).is_err());
        let directory = tempfile::tempdir().unwrap();
        let mut events = Vec::new();
        install_files(
            directory.path(),
            &font,
            &[
                (400, bytes.clone()),
                (
                    700,
                    std::fs::read(
                        std::path::PathBuf::from(std::env::var_os("WINDIR").unwrap())
                            .join("Fonts/consolab.ttf"),
                    )
                    .unwrap(),
                ),
            ],
            &Accept,
            |done, total| events.push((done, total)),
        )
        .unwrap();
        assert_eq!(events, [(1, 2), (2, 2)]);
    }

    #[test]
    #[ignore = "Requires the public Fontsource and Google font services"]
    fn live_catalog_downloads_complete_regular_and_bold_fonts() {
        let client = client().unwrap();
        let catalog = read_catalog(&client).unwrap();
        let font = catalog.iter().find(|f| f.id == "jetbrains-mono").unwrap();
        for weight in [400, 700] {
            let mut events = Vec::new();
            let bytes = font_bytes(&client, font, weight, |done, total| {
                events.push((done, total))
            })
            .unwrap();
            assert!(bytes.len() > 1000);
            assert_eq!(events.last().unwrap().0, bytes.len() as u64);
            let face = ttf_parser::Face::parse(&bytes, 0).unwrap();
            assert_eq!(face.weight().to_number(), weight);
            assert!(face.glyph_index('A').is_some());
            assert!(face.glyph_index('Ж').is_some());
        }
    }
    fn font() -> CatalogFont {
        serde_json::from_str(r#"{"id":"jetbrains-mono","family":"JetBrains Mono","license":"OFL-1.1","category":"monospace","type":"google","weights":[400,700],"styles":["normal"],"subsets":["latin"]}"#).unwrap()
    }
    #[test]
    fn catalog_rejects_unsafe_ids_names_and_nonfree_fonts() {
        assert!(usable(&font()));
        for id in ["../foo", "x/y", "https://foo", "", "foo?bar"] {
            let mut f = font();
            f.id = id.into();
            assert!(!usable(&f));
        }
        let mut f = font();
        f.license = "proprietary".into();
        assert!(!usable(&f));
        f = font();
        f.family = "bad\";font".into();
        assert!(!usable(&f));
        f = font();
        f.weights.clear();
        assert!(!usable(&f));
    }
    #[test]
    fn preview_cache_is_bounded_by_bytes_and_entry_count() {
        let mut cache = HashMap::new();
        for index in 0..20 {
            cache_preview(&mut cache, index.to_string(), vec![0; 16]);
        }
        assert_eq!(cache.len(), 16);
        for index in 0..3 {
            cache_preview(&mut cache, format!("large-{index}"), vec![0; MAX_DOWNLOAD]);
        }
        assert!(cache.values().map(Vec::len).sum::<usize>() <= MAX_PREVIEW_CACHE);
        assert!(cache.contains_key("large-2"));
    }
    #[test]
    fn redirects_report_an_explicit_failure_without_following() {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0; 1024];
            let read = stream.read(&mut buffer).unwrap();
            assert!(read > 0);
            stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: https://example.invalid/font.ttf\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let error = download(
            &client().unwrap(),
            &format!("http://{address}"),
            1024,
            |_, _| {},
        )
        .unwrap_err();
        server.join().unwrap();
        assert!(error.contains("redirected"), "{error}");
    }
    #[test]
    fn catalog_rejects_oversized_or_unsafe_subsets() {
        for subsets in [
            vec!["latin".into(), "../bad".into()],
            vec!["latin".into(); 33],
            vec!["latin".into(), "x".repeat(33)],
        ] {
            let mut font = font();
            font.subsets = subsets;
            assert!(!usable(&font));
        }
    }
    #[test]
    fn staging_never_exposes_a_partial_final_font() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("font.ttf");
        let orphan = path.with_extension("interrupted.tmp");
        std::fs::write(&orphan, b"partial").unwrap();
        assert!(write_font_file(&path, b"complete font").unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), b"complete font");
        assert!(!write_font_file(&path, b"complete font").unwrap());
        assert!(write_font_file(&path, b"different font").is_err());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
    }
    #[cfg(windows)]
    #[test]
    fn regular_font_cannot_be_installed_as_bold() {
        let (font, bytes) = windows_font_fixture();
        assert!(validate_font(&bytes, &font.family, 400).is_ok());
        assert!(
            validate_font(&bytes, &font.family, 700)
                .unwrap_err()
                .contains("weight")
        );
    }
    #[test]
    fn font_download_urls_are_restricted_to_google_truetype() {
        assert_eq!(
            ttf_urls("src: url(https://fonts.gstatic.com/s/test/v1/a.ttf)")
                .unwrap()
                .len(),
            1
        );
        for url in [
            "http://fonts.gstatic.com/s/a.ttf",
            "https://evil.example/a.ttf",
            "https://fonts.gstatic.com.evil/s/a.ttf",
            "https://fonts.gstatic.com/s/a.woff2",
            "https://fonts.gstatic.com/s/a.ttf?x=1",
        ] {
            assert!(ttf_urls(&format!("url({url})")).is_err());
        }
    }
    #[test]
    fn invalid_font_never_creates_install_files() {
        struct Never;
        impl FontRegistration for Never {
            fn register(&self, _: &Path, _: &str) -> Result<bool, String> {
                panic!("invalid font registered")
            }
            fn unregister(&self, _: &Path, _: &str) {
                panic!("invalid font removed")
            }
        }
        let temp = tempfile::tempdir().unwrap();
        assert!(
            install_files(
                temp.path(),
                &font(),
                &[(400, b"not a font".to_vec())],
                &Never,
                |_, _| {}
            )
            .is_err()
        );
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn native_registration_uses_current_user_registry_and_is_reversible() {
        use windows_sys::Win32::System::Registry::*;
        let (mut font, bytes) = windows_font_fixture();
        font.id = format!("test-{}", uuid::Uuid::new_v4());
        let directory = tempfile::tempdir().unwrap();
        let path = directory
            .path()
            .join(format!("ControlRoom-{}-400.ttf", font.id));
        let key_name = format!("Control Room {} 400 (TrueType)", font.id);
        struct Cleanup(std::path::PathBuf, String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                windows::UserFonts.unregister(&self.0, &self.1);
            }
        }
        let _cleanup = Cleanup(path.clone(), key_name.clone());
        install_files(
            directory.path(),
            &font,
            &[(400, bytes)],
            &windows::UserFonts,
            |_, _| {},
        )
        .unwrap();
        let key = "Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"
            .encode_utf16()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let name = key_name.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let mut stored = [0_u16; 32768];
        let mut length = std::mem::size_of_val(&stored) as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                stored.as_mut_ptr().cast(),
                &mut length,
            )
        };
        assert_eq!(status, 0);
        assert_eq!(
            String::from_utf16_lossy(&stored[..length as usize / 2 - 1]),
            path.to_string_lossy()
        );
    }
}
