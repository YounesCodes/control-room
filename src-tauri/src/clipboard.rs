//! Native clipboard access for desktops whose webview cannot serve the
//! terminal's shifted copy and paste shortcuts on its own.

#[cfg(target_os = "linux")]
mod imp {
    use tauri::{AppHandle, async_runtime::channel};

    fn clipboard() -> Result<gtk::Clipboard, String> {
        gtk::gdk::Display::default()
            .and_then(|display| gtk::Clipboard::default(&display))
            .ok_or_else(|| "The desktop clipboard is unavailable.".into())
    }

    pub async fn read(app: AppHandle) -> Result<Option<String>, String> {
        let (sender, mut receiver) = channel(1);
        app.run_on_main_thread(move || match clipboard() {
            Ok(clipboard) => clipboard.request_text(move |_, text| {
                let _ = sender.try_send(Ok(text.map(str::to_owned)));
            }),
            Err(error) => {
                let _ = sender.try_send(Err(error));
            }
        })
        .map_err(|error| error.to_string())?;
        receiver
            .recv()
            .await
            .ok_or("The desktop clipboard closed.")?
    }

    pub async fn write(app: AppHandle, text: String) -> Result<(), String> {
        let (sender, mut receiver) = channel(1);
        app.run_on_main_thread(move || {
            let result = clipboard().map(|clipboard| clipboard.set_text(&text));
            let _ = sender.try_send(result);
        })
        .map_err(|error| error.to_string())?;
        receiver
            .recv()
            .await
            .ok_or("The desktop clipboard closed.")?
    }
}

/// WKWebView answers a scripted clipboard read with a Paste confirmation that
/// blocks the page. The system pasteboard tools read and write it directly.
#[cfg(target_os = "macos")]
mod imp {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    use tauri::AppHandle;

    // Without a UTF-8 locale both tools treat text as MacRoman.
    fn tool(program: &str) -> Command {
        let mut command = Command::new(program);
        command.env("LC_CTYPE", "UTF-8");
        command
    }

    pub async fn read(_app: AppHandle) -> Result<Option<String>, String> {
        tauri::async_runtime::spawn_blocking(|| {
            let output = tool("/usr/bin/pbpaste")
                .stdin(Stdio::null())
                .output()
                .map_err(|error| format!("Could not read the clipboard: {error}"))?;
            if !output.status.success() {
                return Err("Could not read the clipboard.".to_string());
            }
            let text = String::from_utf8_lossy(&output.stdout).into_owned();
            Ok((!text.is_empty()).then_some(text))
        })
        .await
        .map_err(|error| error.to_string())?
    }

    pub async fn write(_app: AppHandle, text: String) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            let mut child = tool("/usr/bin/pbcopy")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| format!("Could not write the clipboard: {error}"))?;
            child
                .stdin
                .take()
                .ok_or("Could not write the clipboard.")?
                .write_all(text.as_bytes())
                .map_err(|error| format!("Could not write the clipboard: {error}"))?;
            let status = child.wait().map_err(|error| error.to_string())?;
            if status.success() {
                Ok(())
            } else {
                Err("Could not write the clipboard.".to_string())
            }
        })
        .await
        .map_err(|error| error.to_string())?
    }
}

#[tauri::command]
pub async fn read_clipboard(app: tauri::AppHandle) -> Result<Option<String>, String> {
    imp::read(app).await
}

#[tauri::command]
pub async fn write_clipboard(app: tauri::AppHandle, text: String) -> Result<(), String> {
    imp::write(app, text).await
}
