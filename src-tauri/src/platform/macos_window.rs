//! Keep AppKit's real window buttons centered on the overlay header.
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    ptr::NonNull,
};

use block2::RcBlock;
use objc2::{
    rc::Retained,
    runtime::{NSObjectProtocol, ProtocolObject},
};
use objc2_app_kit::{
    NSView, NSViewBoundsDidChangeNotification, NSViewFrameDidChangeNotification, NSWindow,
    NSWindowButton, NSWindowStyleMask, NSWindowWillCloseNotification,
};
use objc2_foundation::{NSNotification, NSNotificationCenter};

type ObserverToken = Retained<ProtocolObject<dyn NSObjectProtocol>>;

thread_local! {
    // Cocoa tokens are confined to the main thread and removed before the
    // window's view hierarchy is torn down.
    static OBSERVERS: RefCell<HashMap<String, Vec<ObserverToken>>> =
        RefCell::new(HashMap::new());
    static ALIGNING: Cell<bool> = const { Cell::new(false) };
}

// The webview has a one-point border and a 42-point header whose bottom border
// leaves 41 points of content. The native desktop test compares this center
// with the rendered header in normal, Settings, and Focus modes.
const HEADER_CENTER_Y: f64 = 21.5;

pub(crate) fn watch(window: &tauri::Window) {
    if window.label() != "main" {
        return;
    }
    let native_window = window.clone();
    if let Err(error) = window.run_on_main_thread(move || {
        if let Err(error) = watch_on_main_thread(&native_window) {
            eprintln!("Could not watch native window button layout: {error}");
        }
    }) {
        eprintln!("Could not schedule native window button observation: {error}");
    }
}

fn remove_observers(label: &str) {
    if let Some(observers) = OBSERVERS.with(|observers| observers.borrow_mut().remove(label)) {
        for observer in observers {
            let object: &objc2::runtime::AnyObject = (*observer).as_ref();
            // SAFETY: This token was returned by this notification center.
            unsafe { NSNotificationCenter::defaultCenter().removeObserver(object) };
        }
    }
}

fn watch_on_main_thread(window: &tauri::Window) -> Result<(), String> {
    let _main_thread = objc2::MainThreadMarker::new().ok_or("AppKit requires the main thread")?;
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    // SAFETY: Tauri owns this live window; registration is on the main thread.
    let native = unsafe { &*pointer.cast::<NSWindow>() };
    watch_native(window.label(), native)
}

fn watch_native(label: &str, native: &NSWindow) -> Result<(), String> {
    let _main_thread = objc2::MainThreadMarker::new().ok_or("AppKit requires the main thread")?;
    if OBSERVERS.with(|observers| observers.borrow().contains_key(label)) {
        return Ok(());
    }
    let mut views: Vec<Retained<NSView>> = Vec::new();
    for kind in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        let button = native
            .standardWindowButton(kind)
            .ok_or("Missing native button")?;
        views.push(button.into_super().into_super());
    }
    // SAFETY: The live NSWindow retains its standard button view hierarchy.
    let parent = unsafe { views[0].superview() }.ok_or("Missing titlebar view")?;
    // Tauri changes this container's frame during its draw pass.
    // SAFETY: The same live window owns the parent and its container.
    let container = unsafe { parent.superview() }.ok_or("Missing titlebar container")?;
    views.push(parent);
    views.push(container);
    views.push(native.contentView().ok_or("Missing native content view")?);
    let address = native as *const NSWindow as usize;
    let block = RcBlock::new(move |_: NonNull<NSNotification>| realign(address));
    let mut observers = Vec::new();
    for view in views {
        view.setPostsFrameChangedNotifications(true);
        view.setPostsBoundsChangedNotifications(true);
        // SAFETY: These are AppKit's immutable notification-name constants.
        for name in unsafe {
            [
                NSViewFrameDidChangeNotification,
                NSViewBoundsDidChangeNotification,
            ]
        } {
            // SAFETY: The filter is a live NSView owned by this window. Its
            // layout changes occur on the main thread. The captured address
            // is dereferenced only there, while the window is alive; the
            // will-close observer below removes all callbacks before teardown.
            observers.push(unsafe {
                NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                    Some(name),
                    Some(&view),
                    None,
                    &block,
                )
            });
        }
    }
    let closing_label = label.to_owned();
    let closing = RcBlock::new(move |_: NonNull<NSNotification>| remove_observers(&closing_label));
    // SAFETY: The filter is this live NSWindow, and AppKit posts will-close on
    // the main thread before tearing down the observed view hierarchy. Both
    // blocks capture only sendable values and all tokens are removed together.
    observers.push(unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(NSWindowWillCloseNotification),
            Some(native),
            None,
            &closing,
        )
    });
    OBSERVERS.with(|registered| registered.borrow_mut().insert(label.to_owned(), observers));
    realign(address);
    Ok(())
}

#[cfg(feature = "desktop-e2e")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleProbe {
    windows_before: usize,
    windows_observed: usize,
    windows_after_close: usize,
    centers_after_container_change: Vec<f64>,
    centers_after_button_change: Vec<f64>,
    unobserved_delta: f64,
}

/// Exercise the real observer and will-close paths on an owned hidden Cocoa
/// window, without closing the automation session's main webview.
#[cfg(feature = "desktop-e2e")]
pub(crate) fn lifecycle_probe(window: &tauri::Window) -> Result<LifecycleProbe, String> {
    use objc2::MainThreadOnly;
    use objc2_app_kit::NSBackingStoreType;

    let mtm = objc2::MainThreadMarker::new().ok_or("AppKit requires the main thread")?;
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    // SAFETY: The command owns a live Tauri window and runs on the main thread.
    let main = unsafe { &*pointer.cast::<NSWindow>() };
    // SAFETY: This hidden window uses the live main window's valid rectangle
    // and style. Rust retains it through close, so AppKit must not release it.
    let probe = unsafe {
        let probe = NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            main.contentView()
                .ok_or("Missing native content view")?
                .bounds(),
            main.styleMask(),
            NSBackingStoreType::Buffered,
            false,
        );
        probe.setReleasedWhenClosed(false);
        probe
    };
    let windows_before = OBSERVERS.with(|observers| observers.borrow().len());
    let result: Result<_, String> = (|| {
        let close = probe
            .standardWindowButton(NSWindowButton::CloseButton)
            .ok_or("Missing probe button")?;
        // SAFETY: The retained probe window owns the standard view hierarchy.
        let parent = unsafe { close.superview() }.ok_or("Missing probe titlebar")?;
        // SAFETY: The retained parent belongs to the same live probe window.
        let container = unsafe { parent.superview() }.ok_or("Missing probe container")?;
        let mut frame = container.frame();
        frame.size.height = 42.0;
        frame.origin.y = probe.frame().size.height - frame.size.height;
        container.setFrame(frame);
        watch_native("native-chrome-lifecycle-probe", &probe)?;
        let windows_observed = OBSERVERS.with(|observers| observers.borrow().len());
        frame.origin.y -= 4.0;
        frame.size.height += 4.0;
        container.setFrame(frame);
        let centers_after_container_change = probe_centers(&probe)?;
        for kind in [
            NSWindowButton::CloseButton,
            NSWindowButton::MiniaturizeButton,
            NSWindowButton::ZoomButton,
        ] {
            let button = probe
                .standardWindowButton(kind)
                .ok_or("Missing probe button")?;
            let mut origin = button.frame().origin;
            origin.y += 7.0;
            button.setFrameOrigin(origin);
        }
        Ok((
            windows_observed,
            centers_after_container_change,
            probe_centers(&probe)?,
        ))
    })();
    probe.close();
    let windows_after_close = OBSERVERS.with(|observers| observers.borrow().len());
    let (windows_observed, centers_after_container_change, centers_after_button_change) =
        match result {
            Ok(values) => values,
            Err(error) => {
                remove_observers("native-chrome-lifecycle-probe");
                return Err(error);
            }
        };
    let close = probe
        .standardWindowButton(NSWindowButton::CloseButton)
        .ok_or("Missing retained probe button")?;
    let before = close.frame().origin;
    let mut after = before;
    after.y += 7.0;
    close.setFrameOrigin(after);
    let unobserved_delta = close.frame().origin.y - before.y;
    // Keep the hidden test window safe even if a close-notification regression
    // leaves tokens behind. The measurements above still expose that failure.
    remove_observers("native-chrome-lifecycle-probe");
    Ok(LifecycleProbe {
        windows_before,
        windows_observed,
        windows_after_close,
        centers_after_container_change,
        centers_after_button_change,
        unobserved_delta,
    })
}

#[cfg(feature = "desktop-e2e")]
fn probe_centers(window: &NSWindow) -> Result<Vec<f64>, String> {
    let content = window.contentView().ok_or("Missing probe content")?;
    [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .into_iter()
    .map(|kind| {
        let button = window
            .standardWindowButton(kind)
            .ok_or("Missing probe button")?;
        let rect = button.convertRect_toView(button.bounds(), Some(&content));
        let middle = rect.origin.y + rect.size.height / 2.0;
        Ok(if content.isFlipped() {
            middle - content.bounds().origin.y
        } else {
            content.bounds().origin.y + content.bounds().size.height - middle
        })
    })
    .collect()
}

fn realign(address: usize) {
    ALIGNING.with(|aligning| {
        // Updating a button emits another frame notification synchronously.
        if aligning.replace(true) {
            return;
        }
        let result = align_on_main_thread(address);
        aligning.set(false);
        if let Err(error) = result {
            eprintln!("Could not align native window buttons: {error}");
        }
    });
}

fn align_on_main_thread(address: usize) -> Result<(), String> {
    let _main_thread = objc2::MainThreadMarker::new().ok_or("AppKit requires the main thread")?;
    // SAFETY: Registration captures the live NSWindow's address. The callback
    // runs only on the main thread and will-close removes it before teardown.
    let native = unsafe { &*(address as *const NSWindow) };
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
