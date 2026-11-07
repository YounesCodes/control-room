fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon-dev.ico");
    // Debug exes wear the dev-marked icon so a taskbar button cannot be
    // mistaken for the installed app. Release keeps the shipped icon.
    let attributes = if std::env::var("PROFILE").as_deref() == Ok("debug") {
        tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new().window_icon_path("icons/icon-dev.ico"),
        )
    } else {
        tauri_build::Attributes::new()
    };
    emit_branch();
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
    // Tauri adds its Common Controls v6 manifest to application binaries only.
    // Tests that build a mock App also link TaskDialogIndirect and need it.
    #[cfg(windows)]
    println!(
        "cargo:rustc-link-arg-tests={}\\resource.lib",
        std::env::var("OUT_DIR").expect("Cargo supplies OUT_DIR")
    );
}

// Debug windows are titled with the checkout's branch, so the compile-time
// value must follow branch switches. The title fn falls back to "dev" when
// Git cannot name the branch.
fn emit_branch() {
    let branch = std::process::Command::new("git")
        .args(["branch", "--show-current"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_default();
    println!("cargo:rustc-env=CONTROL_ROOM_BRANCH={branch}");
    if let Ok(head) = std::process::Command::new("git")
        .args(["rev-parse", "--git-path", "HEAD"])
        .output()
    {
        let path = String::from_utf8_lossy(&head.stdout).trim().to_string();
        if head.status.success() && !path.is_empty() && std::path::Path::new(&path).exists() {
            println!("cargo:rerun-if-changed={path}");
        }
    }
}
