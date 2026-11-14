//! The undecorated Linux window is transparent so the frontend can round its
//! corners like Windows 11 does. Without a compositor the transparent corners
//! paint black, so the frontend rounds them only while the screen composites.
use tauri::{AppHandle, Emitter, async_runtime::channel};

pub const COMPOSITING_CHANGED: &str = "window-compositing-changed";

fn composited() -> bool {
    gtk::gdk::Screen::default().is_some_and(|screen| screen.is_composited())
}

/// Report compositor starts and stops, such as toggling Xfce's compositor.
pub fn watch(app: &AppHandle) {
    let Some(screen) = gtk::gdk::Screen::default() else {
        return;
    };
    let app = app.clone();
    screen.connect_composited_changed(move |screen| {
        let _ = app.emit(COMPOSITING_CHANGED, screen.is_composited());
    });
}

#[tauri::command]
pub async fn window_compositing(app: AppHandle) -> Result<bool, String> {
    let (sender, mut receiver) = channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.try_send(composited());
    })
    .map_err(|error| error.to_string())?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "The window compositor state is unavailable.".into())
}
