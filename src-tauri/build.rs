fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.icns");
    tauri_build::build();
    // Tauri adds its Common Controls v6 manifest to application binaries only.
    // Tests that build a mock App also link TaskDialogIndirect and need it.
    #[cfg(windows)]
    println!(
        "cargo:rustc-link-arg-tests={}\\resource.lib",
        std::env::var("OUT_DIR").expect("Cargo supplies OUT_DIR")
    );
}
