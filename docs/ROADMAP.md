# Control Room roadmap

## MVP

- [x] Repository foundation launches as a Tauri application
- [x] ConPTY terminal proof succeeds locally
- [x] Live ConPTY and OpenSSH fixture passes against the release candidate
- [x] Saved Connections persist in SQLite
- [x] Multiple Workspaces and Terminal Sessions remain independent, including explicit same-connection terminal spawning
- [x] Host capability discovery and Overview are accurate
- [x] systemd services are inspectable
- [x] journald tail and follow streams work
- [x] Docker containers are inspectable
- [x] Docker log streams work
- [x] Structured sudo retry does not persist credentials
- [x] Opt-in Bash Enhanced History is reversible and accurate
- [x] Black-and-white Docker Desktop-inspired application shell uses detected Debian and Ubuntu marks in host navigation, reserves state indicators for the Terminal view, and keeps one clear location per action, a bounded connection list above contextual Workspace navigation, per-connection overflow menus, in-window terminal tabs, integrated window controls, and centered resizable startup geometry
- [x] Automated frontend, Rust, migration, high-output, and accessibility gates pass
- [x] Windows CI and tagged unsigned release workflows are defined
- [x] Build the release-candidate NSIS package
- [ ] Install the package on a clean Windows user profile
- [ ] Complete the clean-profile manual acceptance checklist

## After MVP

- Public repository launch
- Windows code signing
- Automatic updates
- Imported-key threat model and encrypted storage, if still useful
- Additional shells and Linux families based on real demand
