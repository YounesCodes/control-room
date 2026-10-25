//! Keep AppKit's real window buttons centered on the overlay header.
use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask};

// The webview has a one-point border and a 42-point header whose bottom border
// leaves 41 points of content. The native desktop test compares this center
// with the rendered header in normal, Settings, and Focus modes.
const HEADER_CENTER_Y: f64 = 21.5;

pub(crate) fn align(window: &tauri::Window) {
    if window.label() != "main" {
        return;
    }
    let native_window = window.clone();
    if let Err(error) = window.run_on_main_thread(move || {
        if let Err(error) = align_on_main_thread(&native_window) {
            eprintln!("Could not align native window buttons: {error}");
        }
    }) {
        eprintln!("Could not schedule native window button alignment: {error}");
    }
}

fn align_on_main_thread(window: &tauri::Window) -> Result<(), String> {
    let _main_thread = objc2::MainThreadMarker::new().ok_or("AppKit requires the main thread")?;
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    // SAFETY: Tauri owns this live NSWindow, and all AppKit access stays on
    // the main thread within the lifetime of the owning Window handle.
    let native = unsafe { &*pointer.cast::<NSWindow>() };
    if native.styleMask().contains(NSWindowStyleMask::FullScreen) {
        // AppKit owns the separate fullscreen titlebar. Align again on restore.
        return Ok(());
    }
    let content = native.contentView().ok_or("Missing native content view")?;
    let content_bounds = content.bounds();
    for kind in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        let button = native
            .standardWindowButton(kind)
            .ok_or("Missing native button")?;
        if button
            .window()
            .is_none_or(|owner| !std::ptr::eq(&*owner, native))
        {
            // Fullscreen transitions can temporarily reparent the buttons.
            continue;
        }
        let bounds = button.convertRect_toView(button.bounds(), Some(&content));
        let middle = bounds.origin.y + bounds.size.height / 2.0;
        let center = if content.isFlipped() {
            middle - content_bounds.origin.y
        } else {
            content_bounds.origin.y + content_bounds.size.height - middle
        };
        let delta = center - HEADER_CENTER_Y;
        if delta.abs() < 0.01 {
            continue;
        }
        // Tauri's inset preserves each button's current Y. Correct that native
        // frame, which differs between macOS releases, without replacing its
        // size, horizontal spacing, action, or hover/hit behavior.
        // SAFETY: AppKit's standard window button has an NSView parent; both
        // views stay retained and all access is on the main thread.
        let parent = unsafe { button.superview() }.ok_or("Missing native button parent")?;
        let mut origin = button.frame().origin;
        origin.y += if parent.isFlipped() { -delta } else { delta };
        button.setFrameOrigin(origin);
    }
    Ok(())
}
