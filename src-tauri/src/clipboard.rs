use tauri::{AppHandle, async_runtime::channel};

fn clipboard() -> Result<gtk::Clipboard, String> {
    gtk::gdk::Display::default()
        .and_then(|display| gtk::Clipboard::default(&display))
        .ok_or_else(|| "The desktop clipboard is unavailable.".into())
}

#[tauri::command]
pub async fn read_clipboard(app: AppHandle) -> Result<Option<String>, String> {
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

#[tauri::command]
pub async fn write_clipboard(app: AppHandle, text: String) -> Result<(), String> {
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
