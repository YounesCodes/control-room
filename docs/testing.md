# Testing

Control Room uses Rust and Vitest component tests for contracts and failure paths. Chromium journeys mount the real app with typed fixtures at the Tauri boundary and exercise navigation, keyboard input, layout, and accessibility. Native desktop tests cross React, real IPC, Rust, SQLite, and native processes. Ignored SSH tests and the local Ubuntu journeys provide read-only proof against a configured host.

| Layer                       | Command                           | Runs in pull request CI             |
| --------------------------- | --------------------------------- | ----------------------------------- |
| Frontend and tooling        | `npm test`                        | Yes                                 |
| Chromium components and axe | `npm run test:browser`            | Yes                                 |
| Rust unit tests             | `npm run check:rust`              | Yes, with fmt and Clippy            |
| Frontend coverage           | `npm run test:coverage`           | Manual coverage workflow            |
| Rust coverage               | `npm run test:rust-coverage`      | Manual coverage workflow            |
| Linux desktop E2E           | `bash scripts/test-linux-wdio.sh` | Yes, Ubuntu 24.04 with Xvfb/Openbox |
| Windows desktop E2E         | `npm run test:desktop`            | Yes, on a hosted Windows runner     |
| Debian SSH fixture          | `npm run test:live-ssh`           | Manual live fixture workflow        |
| Hosted Ubuntu SSH fixture   | `bash scripts/test-hosted-ssh.sh` | Yes, on a disposable Linux runner   |

Start with `npm ci`. The normal Windows CI still runs Prettier, ESLint, TypeScript and Vite builds, `cargo audit`, and the NSIS installer build. `src/ui-hierarchy.test.ts` keeps architecture and permission contracts; browser and desktop tests check user behavior. Neither normal test command needs an SSH host.

Development builds use `%APPDATA%\app.controlroom.desktop\development\control-room.db` and start with separate connections and settings. Installed release builds keep `%APPDATA%\app.controlroom.desktop\control-room.db`. Development builds never copy or migrate the installed database, so testing an unreleased schema cannot prevent the installed app from opening. Desktop E2E builds continue to use the runner's isolated data directory. Debug windows also self-identify: the title is the checkout's Git branch and the taskbar icon carries the dev badge from `src-tauri/icons/icon-dev.ico`, while release builds keep the plain Control Room title and icon.

## Windows SSH hosts

Run `powershell.exe -NoProfile -File scripts/test-windows-ssh-probe.ps1` for local discovery fixtures. They check installed shell paths, Windows Terminal JSON comments, custom profiles, and malformed profile files without changing the real host.

Run `powershell.exe -NoProfile -File scripts/test-windows-docker.ps1` for Windows PowerShell 5 Docker fixtures. They check list and Compose metadata, inspection, and stdout/stderr log streaming using a temporary fake executable. No Docker daemon is required.

For live Windows 10 or 11 SSH checks, set `CONTROL_ROOM_WINDOWS_TEST_HOST`, `CONTROL_ROOM_WINDOWS_TEST_USER`, and optionally `CONTROL_ROOM_WINDOWS_TEST_PORT`. Set `CONTROL_ROOM_WINDOWS_TEST_WSL` to an installed distribution name to include WSL. Keep these values outside tracked files. Build with `npm run test:desktop:build`, then run `npm run test:desktop -- --spec e2e/windows-ssh.spec.ts`.

The live journeys exercise PowerShell output, Windows host detection and navigation, Command Prompt reconnects, WSL restoration after an app restart, and Windows Ports, Services, and opt-in header readings. They use an isolated app database and normal OpenSSH key or agent authentication. The Windows suite is skipped when its host and user variables are absent.

With the same host and user variables, run the ignored Rust tests `fresh_shell_selection_avoids_a_second_discovery_round_trip` and `live_windows_inspection_returns_ports_peers_services_firewall_and_resources` with `cargo test --manifest-path src-tauri/Cargo.toml <test-name> -- --ignored --nocapture`. The first checks that a recent shell selection avoids another discovery round trip. The second checks read-only Windows networking, services, firewall profiles, and resource results.

## Coverage

`npm run test:coverage` writes a text summary, `coverage/index.html`, and `coverage/lcov.info`. The report includes production frontend files, including `src/lib/api.ts`; it does not enforce a percentage. For Rust, install `llvm-tools-preview` with rustup and `cargo-llvm-cov`, then run `npm run test:rust-coverage`. It writes `src-tauri/target/llvm-cov/html/index.html`. Use `cargo llvm-cov report --manifest-path src-tauri/Cargo.toml --lcov --output-path src-tauri/target/llvm-cov/lcov.info` after the run for LCOV. The manual coverage workflow uploads both reports. The ignored SSH tests are absent from ordinary coverage.

The first Windows baseline (September 2026) is 70.15% frontend statements, 64.37% frontend branches, and 76.57% Rust lines. `commands.rs` is at 38.87% Rust lines, reflecting the command boundary this strategy targets. These are observations, not gates.

## Chromium components

Run `npx playwright install chromium` once, then `npm run test:browser`. Vitest Browser Mode uses Playwright Chromium; these tests use real keyboard, focus, layout, and axe checks without Tauri or network access. Layout checks cover long-dialog scrolling and wide Settings alignment rather than source or CSS syntax. The main `npm test` command still runs the existing jsdom suites. Browser screenshots on failure go to `.vitest/`.

## Headless UI review

Capture one synthetic React scenario without opening Tauri or a visible browser:

```bash
npm run ui:capture -- --list
npm run ui:capture -- --scenario settings
npm run ui:capture -- --scenario systemd --state overflow --viewport narrow
npm run ui:motion -- --scenario settings
```

Install Chromium with `npx playwright install chromium` first. On headless Ubuntu,
use `npx playwright install --with-deps chromium` to provision its OS libraries.
The same commands run on Windows. No SSH host, desktop session, MCP tool, or external
API is needed. They start a loopback-only ephemeral Vite server and one headless
Chromium session, then close both. Run commands serially; a lock prevents overlapping
captures. A session has a two-minute budget. Exit codes are 0 for success, 1 for a
capture failure, and 2 for invalid arguments. Use `--help` for available selections.

Normal 1440×900, narrow 960×640, and compact 520×480 viewports run by default.
Use `--viewport normal`, `--viewport narrow`, or `--viewport compact` for one size.
Compact covers the smaller window target from PR #188, even before that change
lands. Captures show the current branch's layout without scaling or hiding its
clipping. Settings starts on General & Monitoring. Systemd supports
`populated`, `empty`, `loading`, `error`,
`stale`, and `overflow`; populated states open the real unit inspector.
Scratchpad opens the popover on a remote terminal in `populated` and switches it
to the global note in `global`. Data is
synthetic and network requests outside the fixture server are blocked. No local
environment files are loaded. Every scenario renders the real `App`, including
its titlebar, rail, workspace tabs, and content constraints. Settings uses the
app's own full-window Settings layout. Manifests record measured shell and
pane bounds; captures fail if the fixture bypasses the expected shell geometry.

The CLI prints a JSON line identifying each manifest under the ignored directory
`test-results/ui-review/<scenario>/<state>/<viewport>/<capture|motion>/`.
`manifest.json` records the state, dimensions, result, relative
PNG paths, and verification limits. A failed capture writes its error there;
`test-results/ui-review/session.json` also records startup failures and links the
latest session's manifests.
Still captures finish animations before saving. Motion triggers the scenario's real
transition: the Settings category reveal or the Scratchpad note switch. It saves
before/start/midpoint/after PNGs with timeline
positions and computed poses, failing if no changing transition is found. The
animation is paused at each sample for reproducibility. These frames prove visible
poses, not frame pacing, dropped frames, or real-time performance.

Open the actual PNGs with an image viewer or a vision-capable agent. Check hierarchy,
readability, clipping, positioning, and responsive layout. For a layout change,
capture before editing and preserve those PNGs outside the selected output folder,
which is overwritten on recapture. Change the UI, capture the same states and widths,
inspect again, and repeat when needed. Inspect the motion sequence in order for
transition changes. A passing command or pixel comparison does not review UX.
Chromium evidence cannot verify native WebView2, Tauri window controls, ConPTY,
real SSH, or live terminal resizing. A native app or visible browser launch on the
Windows laptop requires explicit approval, including desktop E2E and the manual
`test:local-lab` / `test:local-gate` commands. Hosted CI can run its native suites.

The existing hosted frontend CI job runs this small capture slice after browser
tests, without repeating the browser suite or desktop E2E. It uploads PNGs and
manifests as `ui-review` for seven days when present. Download an existing run with
`gh run download <run-id> --name ui-review --dir test-results/ui-review-ci`.
Capture failures fail the step; absent artifacts do not fail uploads.

To add a scenario, register its states and ready selector in
`src/test/ui-review/scenarios.json`, including focused preparation actions and
state-specific settled selectors. Actions click by default; `"wait": true` waits for
the target and `"fill"` types text into it. Configure synthetic native responses in
`src/test/ui-review/native.ts`, reusing `src/test/` fixture data. The capture
server aliases Tauri imports to that browser-only module; the product build does
not. Prefer the real App layout over duplicated shell markup. Keep ready
selectors tied to completed rendering, stub any new native reads with synthetic data,
and register a motion trigger and animated target only when that transition can
run headlessly. The harness lives outside the product entry point; it is not
included in the packaged app. Vitest browser tests stay independent.

## Linux desktop smoke test

The Ubuntu 24.04 CI job runs Clippy and Rust tests, builds the `.deb` and AppImage, then installs the `.deb` on the runner. WebKitWebDriver and Openbox exercise the installed app in Xvfb with a temporary XDG data directory. The separate hosted SSH job uses the system OpenSSH client and a loopback server to verify a Linux PTY and read-only inspection.

To build on Ubuntu 24.04, install the Tauri development packages (`libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`, `file`, and build tools), then run `npm ci` and `npm run tauri build`. Use a separate Linux desktop session for interactive verification.

## Windows desktop E2E

On Windows 11 with WebView2 and the Rust/Tauri build prerequisites, run:

```bash
npm run test:desktop:build
npm run test:desktop
```

PR and main CI run the desktop suite on a hosted Windows runner. The `Desktop E2E` workflow can also be started manually with an optional `spec` path for a single suite. Leave it empty to run all desktop tests. It reports the runner's elevation and installed WebView2/driver versions before testing.

This suite uses an external `tauri-driver` on Windows. WebdriverIO's helper plugin, permissions, and read-only `e2e_runtime_status` command load only with the debug `desktop-e2e` feature. The release build refuses that feature. The service installs a matching driver if needed; once provisioned, the deterministic tests need no external network. Offline connections use loopback port 1 and updater checks are disabled in each new test database. The debug test app passes the driver's debugging port and profile directly to WebView2, so session creation also works on elevated Windows runners.

Each test starts a fresh app process, SQLite database, and isolated webview data. Persistence tests explicitly restart with the same database. Mocha setup failures fail the test, and teardown closes owned sessions and streams even after assertion failures. Diagnostics expose the app PID and active session/stream IDs; cleanup waits for those resources and app processes to exit before removing temporary files. Tests run serially with no automatic test retries.

Run one feature suite with `npm run test:desktop -- --spec e2e/connections.spec.ts` (or `settings`, `terminals`, or `local-data`). Run each independently and the complete suite twice when changing isolation or process lifecycle. Failures save a screenshot, test name, DOM state, and runtime diagnostics under ignored `test-results/desktop/`, alongside driver/application logs. The manual `Desktop E2E` workflow uploads only sanitized text diagnostics. Screenshots stay local. If the shared launcher log contains NUL padding, its contents are omitted; sanitized per-spec logs remain available. Other sanitization failures block the upload. Live-host screenshots stay local and are never included in that workflow.

## Debian SSH fixture

The live tests stay `#[ignore]` in ordinary `cargo test`. They require Windows for ConPTY and an explicitly configured Debian host with systemd, journald, Bash, and Docker. Set `CONTROL_ROOM_TEST_HOST` and `CONTROL_ROOM_TEST_USER`; set `CONTROL_ROOM_TEST_PORT` if it is not 22. Configure a key and pinned host key through the Windows OpenSSH client before running `npm run test:live-ssh`. To use an isolated OpenSSH config, set `CONTROL_ROOM_TEST_SSH_CONFIG` to its path; the preflight and Rust fixture tests pass it to SSH with `-F`. The command checks noninteractive SSH first, then runs only the three named ignored tests. The history test creates and removes its own remote temporary home.

The manual `Live SSH fixture` GitHub workflow reads host, user, optional port, a base64-encoded private key (`CONTROL_ROOM_TEST_KEY_B64`), and pinned OpenSSH `known_hosts` content (`CONTROL_ROOM_TEST_KNOWN_HOSTS`) from repository secrets. It fails before testing if required secrets are missing. The key, host key, and config live under the runner's temporary directory for that run; the workflow never replaces the runner's own SSH files. Pick `windows-latest` only if that runner can reach your fixture; select `self-hosted` for a private host. No fixture address, key, or host fingerprint belongs in the repository.

PR and main CI also start a temporary SSH server on the hosted Ubuntu runner's loopback interface with fresh keys. The history and structured-read tests connect to that runner, without using the local lab or repository secrets. This Linux-to-Linux check does not replace Windows OpenSSH, ConPTY, or the Ubuntu desktop journey in the local lab.

## Local Ubuntu VM gate

The development checkout can run a separate, local-only Ubuntu fixture. Put its address, user, and port in the ignored root `.env.local` file:

```dotenv
CONTROL_ROOM_TEST_HOST=your-vm-address-or-ssh-alias
CONTROL_ROOM_TEST_USER=your-user
CONTROL_ROOM_TEST_PORT=22
```

Use Windows OpenSSH with a key or agent and a pinned `known_hosts` entry. The local runner refuses password prompts and untrusted host keys. It reads only these three values from `.env.local`; never put a password or private key there. The file is ignored by Git across branch switches. The tracked test files contain no address, username, key, or fingerprint.

Run `npm run test:local-lab` to check Rust structured reads, a reversible Enhanced History install in a temporary remote home, SSH through ConPTY, and independent desktop journeys for access, reconnect, Systemd, Ports, Logs, and Docker. Each journey uses a temporary local database and verifies resource teardown.

The desktop journeys disable history integration for the real remote account and discover existing units and containers. They make no service, container, firewall, or remote-file changes. Ubuntu and Systemd are required. Missing Docker and inaccessible Docker/journal data are reported explicitly; unexpected errors fail. One-shot sudo cancellation and retry use browser fixtures, so live reads remain unelevated. Only the existing Rust history test installs integration, in its isolated temporary remote home.

Run `npm run test:local-gate` explicitly for the ordinary checks, Chromium tests, and the local VM suite together. Use it before a release and when changing Windows SSH, ConPTY, remote operations, or their lifecycle. The local VM and its desktop windows are no longer part of ordinary commits and pushes.

Run `npm run install:dev-hooks` to install the fast pre-commit check. It checks whitespace and formatting of the staged content, including partially staged files, without rewriting files. The installer backs up the old managed Control Room hooks and removes their duplicate pre-push gate. It refuses to replace unrelated hooks or a custom `core.hooksPath`. The old `install:local-lab-hooks` command now installs the same fast hooks. Hooks remain in this checkout across branch switches.

Run focused tests while implementing changes. Required PR checks run the full frontend, Rust, Chromium, Windows desktop, hosted SSH, and installer checks on GitHub. The release workflow also requires the Linux desktop job. It attaches the Windows and Linux packages to the existing draft, verifies the signed NSIS and AppImage assets against the updater feed, and then publishes it. An incomplete or failed validation leaves the release unpublished.

This fixture proves behavior against this one Ubuntu VM at the time it runs. It cannot prove that every Linux distribution, permission state, network failure, or production desktop environment behaves the same way. Existing deterministic tests cover those branches; add a disposable fixture when a new host-specific behavior needs live proof.

## Native input and keyboard layouts

`native-clipboard.spec.ts` reads and writes the real OS clipboard. It double-clicks
terminal output with the OS pointer, copies with the platform shortcut, and checks
the actual clipboard contents. A raw Node PTY collector verifies multiline Unicode
and the exact bracketed-paste delimiters. Separate raw-input cases verify shell
Ctrl+C and Ctrl+W. The clipboard is restored after each case.

`native-shortcuts.spec.ts` sends native keys for the command palette, workspace
reordering, restart, terminal search and close confirmation, Settings categories,
and Settings tabs. It also checks that arrows in a text field still edit the
caret. `native-inspection-shortcuts.live.ts` covers Logs search, returning to
Terminal, Systemd inventory and dependency navigation, Ports and Docker graph
navigation, refocusing, and Escape dismissal against a real SSH host. Select that
file explicitly with `--spec` and configure `CONTROL_ROOM_TEST_HOST`,
`CONTROL_ROOM_TEST_USER`, and optionally `CONTROL_ROOM_TEST_PORT`. Missing access,
journald, Docker, or usable graph data fails the fixture instead of skipping it.
History integration stays disabled for this account. Debug `desktop-e2e` builds
accept `CONTROL_ROOM_TEST_SSH_CONFIG` for an isolated pinned SSH configuration;
ordinary application builds ignore it.

`italian-keyboard.spec.ts` selects an actual Italian input source and restores it
in `finally`. Linux uses XKB with a dead acute followed by e; macOS discovers the
Italian source's dead-key mapping through Carbon. Windows uses the standard
Italian layout's direct è/é keys; Windows dead-key composition is not covered.
The assertions check both a text field and the UTF-8 bytes received by the PTY.
Linux requires `xdotool`, `xclip`, and the XKB utilities on the private Xvfb
display. macOS requires the command-line tools plus Accessibility and Automation
permission for `osascript` to control System Events. Missing permission fails the
test and must be reported as unvalidated, not a successful native-input check.

`windows-scaling.spec.ts` changes the real Windows Display Scale control through
UI Automation to 125% and 150%, verifies the WebView's devicePixelRatio, and checks
maximize/restore geometry and a live shell. It restores the original OS scale in
`finally`. Its two cases skip on Linux/macOS because they exercise Windows display
settings. Run them only on a disposable desktop with no concurrent test run.

The native suites use Cmd on macOS and Ctrl elsewhere for application shortcuts;
shell Ctrl+C and Ctrl+W always retain Ctrl. macOS execution depends on the native
support branch. Compact workspace and focus-motion specs have no blanket macOS
skip. macOS minimum-width checks start at its native 960-pixel minimum and use
fullscreen/restore in place of the Windows maximize control. The lab currently
cannot validate these cases: its automated window reports a hidden document, and
System Events automation is not permitted. ARM macOS is not in the lab.

Linux lab validation: four clipboard/control-key cases, two Italian-layout cases,
and four application-shortcut cases passed on the Linux integration build. These
are native X11/WebKit results; the existing Chromium fixtures do not replace them.

## Feature-to-test matrix

Browser fixtures prove user interactions against controlled results; they do not prove SSH, SQLite, or Windows process behavior. Native and live columns identify where those boundaries are exercised. Component and Rust tests cover branches that are difficult to trigger safely in a live journey.

| Feature                   | Browser / component proof                                                                                                                                                         | Native desktop proof                                                                                                               | Live SSH / Rust proof                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Saved connections         | `ConnectionDialog.test.tsx`, `connection-organization.test.ts`: validation and organization                                                                                       | `connections.spec.ts`: create/edit/cancel/delete, search, groups/tags/order/collapse, restart                                      | Database organization and migration tests                                                             |
| Settings                  | `SettingsPane.test.tsx`, `app-journeys.browser.test.tsx`: defaults, save errors/retry, shell visibility across launchers, minimum size                                            | `settings.spec.ts`: save/restart, discard/cancel, shell visibility, native maximize                                                | Settings validation, legacy settings, hidden shell persistence                                        |
| Workspaces                | Workspace target/persistence tests; real App navigation keeps its terminal                                                                                                        | `terminals.spec.ts`, `local-data.spec.ts`: independent sessions, switching/rename, close cancellation, restart, deleting one owner | ConPTY and database ownership/reopen tests                                                            |
| Focus and splits          | `critical-ui.browser.test.tsx`: overflow; terminal groups/layout tests: pruning and restoration                                                                                   | `terminals.spec.ts`: both directions, input routing, groups/select/delete, close/prune, restored layout                            | Rust split-state validation and persistence                                                           |
| Terminals                 | `terminal-surface.browser.test.tsx`: real xterm search, Unicode/multiline clipboard input, selection copy; clipboard boundary is a fixture                                        | `terminals.spec.ts`: ConPTY output, Unicode/multiline input, background activity, natural exit/restart, cleanup                    | ConPTY process shutdown/output flow tests; live reconnect journey                                     |
| Scratchpad                | `ScratchpadPane.test.tsx`, `scratchpad-draft.test.ts`: failed load/save/retry, pending-save/delete coordination, undo/redo                                                        | `local-data.spec.ts`: scope isolation, autosave/restart, clear/delete cancellation                                                 | SQLite note ownership, migration, and cascade tests                                                   |
| History                   | `HistoryPane.test.tsx`, real App paste journey: search, integration errors, pause/capture controls, clear errors/cancel, exact paste without Enter, late responses                | `local-data.spec.ts`: real SQLite history/search/clear and offline paste disabled                                                  | History parsing/security tests and isolated-home integration fixture                                  |
| Systemd, Docker           | Real App navigation, Systemd filtering/stale refresh/retry, Docker filtered details and Logs links; pane tests cover late selection                                               | —                                                                                                                                  | Separate live Systemd/Docker journeys and malformed-output parsers                                    |
| Ports                     | Real App owner links, table/connections views, one-shot sudo cancel/retry; pane tests cover graph and firewall uncertainty                                                        | —                                                                                                                                  | Separate live Ports journey; read-only command and parser tests                                       |
| Logs                      | `LogsPane.test.tsx`, real App journeys: early events, delayed start cancellation, source changes, pause/resume, unread scroll/search/wrap, stream error/retry, navigation cleanup | Runtime diagnostics verify no remaining stream IDs after each test                                                                 | Separate journal/Docker journeys; stream exit/diagnostic tests                                        |
| Updates and accessibility | Real App manual check/download retry/progress; updater fixtures; release-note safety, palette/keyboard, dialog focus, axe, minimum-size layout                                    | Settings and native window journey                                                                                                 | Updater endpoint, signature, installer and restart safeguards; E2E feature rejected in release builds |

Coverage reports support this matrix; there is no arbitrary percentage target. PR checks run unit, Chromium, desktop, and hosted SSH tests. Local Ubuntu and Windows SSH journeys remain explicit.

## Linux native WebDriver

The Linux suite requires native Linux support from PR #227. The shared platform helper
is adapted from macOS PR #65. Build with `npm run test:desktop:build`, then run
`bash scripts/test-linux-wdio.sh`. Install `webkit2gtk-driver`, Xvfb, Openbox,
`x11-utils`, `dbus-x11`, and the Tauri GTK development libraries first. The service
starts tauri-driver and WebKitWebDriver. The runner owns its X11 display and window
manager and waits for the WM before exercising maximize and restore.

Install `scripts/e2e-linux-lab.sh` as `~/e2e-linux.sh` on the Linux lab VM. It builds
the debug automation binary and runs the full suite, with an optional spec argument.
A lock prevents concurrent runs. This replaces the installed-package smoke runner;
installed-package behavior needs separate lifecycle checks.

All deterministic specs run on Linux, including compact workspaces, focus motion,
and shell-reported titles. Linux uses Bash and PTYs, Windows uses Command Prompt
and ConPTY, and macOS uses zsh. Process cleanup on Linux checks executable paths and
`/proc` start times before removing temporary app data or stopping owned drivers.
The live font catalog requires `CONTROL_ROOM_LIVE_FONTS=1` and network access.
Live Linux and Windows SSH suites still require their explicit fixture variables.
The Linux lab fixture must provide readable journald and accessible Docker with a
container; missing fixture capabilities fail the live tests.
