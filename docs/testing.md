# Testing

Control Room uses Rust and Vitest component tests for contracts and failure paths. Chromium journeys mount the real app with typed fixtures at the Tauri boundary and exercise navigation, keyboard input, layout, and accessibility. Native desktop tests cross React, real IPC, Rust, SQLite, and Windows processes. Ignored SSH tests and the local Ubuntu journeys provide read-only proof against a configured host.

| Layer                       | Command                      | Runs in pull request CI      |
| --------------------------- | ---------------------------- | ---------------------------- |
| Frontend and tooling        | `npm test`                   | Yes                          |
| Chromium components and axe | `npm run test:browser`       | Yes                          |
| Rust unit tests             | `npm run check:rust`         | Yes, with fmt and Clippy     |
| Frontend coverage           | `npm run test:coverage`      | Manual coverage workflow     |
| Rust coverage               | `npm run test:rust-coverage` | Manual coverage workflow     |
| Windows desktop E2E         | `npm run test:desktop`       | Manual desktop workflow      |
| Debian SSH fixture          | `npm run test:live-ssh`      | Manual live fixture workflow |

Start with `npm ci`. The normal Windows CI still runs Prettier, ESLint, TypeScript and Vite builds, `cargo audit`, and the NSIS installer build. `src/ui-hierarchy.test.ts` keeps architecture and permission contracts; browser and desktop tests check user behavior. Neither normal test command needs an SSH host.

## Coverage

`npm run test:coverage` writes a text summary, `coverage/index.html`, and `coverage/lcov.info`. The report includes production frontend files, including `src/lib/api.ts`; it does not enforce a percentage. For Rust, install `llvm-tools-preview` with rustup and `cargo-llvm-cov`, then run `npm run test:rust-coverage`. It writes `src-tauri/target/llvm-cov/html/index.html`. Use `cargo llvm-cov report --manifest-path src-tauri/Cargo.toml --lcov --output-path src-tauri/target/llvm-cov/lcov.info` after the run for LCOV. The manual coverage workflow uploads both reports. The ignored SSH tests are absent from ordinary coverage.

The first Windows baseline (September 2026) is 70.15% frontend statements, 64.37% frontend branches, and 76.57% Rust lines. `commands.rs` is at 38.87% Rust lines, reflecting the command boundary this strategy targets. These are observations, not gates.

## Chromium components

Run `npx playwright install chromium` once, then `npm run test:browser`. Vitest Browser Mode uses Playwright Chromium; these tests use real keyboard, focus, layout, and axe checks without Tauri or network access. Layout checks cover long-dialog scrolling and wide Settings alignment rather than source or CSS syntax. The main `npm test` command still runs the existing jsdom suites. Browser screenshots on failure go to `.vitest/`.

## Windows desktop E2E

On Windows 11 with WebView2 and the Rust/Tauri build prerequisites, run:

```bash
npm run test:desktop:build
npm run test:desktop
```

This suite uses an external `tauri-driver` on Windows. WebdriverIO's helper plugin, permissions, and read-only `e2e_runtime_status` command load only with the debug `desktop-e2e` feature. The release build refuses that feature. The service installs a matching driver if needed; once provisioned, the deterministic tests need no external network. Offline connections use loopback port 1 and updater checks are disabled in each new test database.

Each test starts a fresh app process, SQLite database, and WebView2 profile. Persistence tests explicitly restart with the same database. Mocha setup failures fail the test, and teardown closes owned sessions and streams even after assertion failures. Diagnostics expose the app PID and active session/stream IDs; cleanup waits for those resources and app processes to exit before removing temporary files. Tests run serially with no automatic test retries.

Run one feature suite with `npm run test:desktop -- --spec e2e/connections.spec.ts` (or `settings`, `terminals`, or `local-data`). Run each independently and the complete suite twice when changing isolation or process lifecycle. Failures save a screenshot, test name, DOM state, and runtime diagnostics under ignored `test-results/desktop/`, alongside driver/application logs. The manual `Desktop E2E` workflow sanitizes and uploads failure artifacts. Live-host screenshots stay local and are never included in that workflow.

## Debian SSH fixture

The live tests stay `#[ignore]` in ordinary `cargo test`. They require Windows for ConPTY and an explicitly configured Debian host with systemd, journald, Bash, and Docker. Set `CONTROL_ROOM_TEST_HOST` and `CONTROL_ROOM_TEST_USER`; set `CONTROL_ROOM_TEST_PORT` if it is not 22. Configure a key and pinned host key through the Windows OpenSSH client before running `npm run test:live-ssh`. To use an isolated OpenSSH config, set `CONTROL_ROOM_TEST_SSH_CONFIG` to its path; the preflight and Rust fixture tests pass it to SSH with `-F`. The command checks noninteractive SSH first, then runs only the three named ignored tests. The history test creates and removes its own remote temporary home.

The manual `Live SSH fixture` GitHub workflow reads host, user, optional port, a base64-encoded private key (`CONTROL_ROOM_TEST_KEY_B64`), and pinned OpenSSH `known_hosts` content (`CONTROL_ROOM_TEST_KNOWN_HOSTS`) from repository secrets. It fails before testing if required secrets are missing. The key, host key, and config live under the runner's temporary directory for that run; the workflow never replaces the runner's own SSH files. Pick `windows-latest` only if that runner can reach your fixture; select `self-hosted` for a private host. No fixture address, key, or host fingerprint belongs in the repository.

## Local Ubuntu VM gate

The development checkout can run a separate, local-only Ubuntu fixture. Put its address, user, and port in the ignored root `.env.local` file:

```dotenv
CONTROL_ROOM_TEST_HOST=your-vm-address-or-ssh-alias
CONTROL_ROOM_TEST_USER=your-user
CONTROL_ROOM_TEST_PORT=22
```

Use Windows OpenSSH with a key or agent and a pinned `known_hosts` entry. The local runner refuses password prompts and untrusted host keys. It reads only these three values from `.env.local`; never put a password or private key there. The file is ignored by Git across branch switches. The tracked test files contain no address, username, key, or fingerprint.

Run `npm run test:local-lab` to check Rust structured reads, baseline collection, a reversible Enhanced History install in a temporary remote home, SSH through ConPTY, and independent desktop journeys for access, reconnect, Overview, Systemd, Ports, Boot, Logs, Docker, and Baselines. Each journey uses a temporary local database and verifies resource teardown. Baselines are saved locally and survive an app restart; live comparisons do not create another stored capture.

The desktop journeys disable history integration for the real remote account and discover existing units, containers, and previous boots. They make no service, container, firewall, or remote-file changes. Ubuntu and Systemd are required. Missing Docker, inaccessible Docker/journal data, and absent retained previous boots are reported explicitly; unexpected errors fail. One-shot sudo cancellation and retry use browser fixtures, so live reads remain unelevated. Only the existing Rust history test installs integration, in its isolated temporary remote home.

Run `npm run test:local-gate` for the ordinary checks, Chromium tests, and the local VM suite together. `npm run install:local-lab-hooks` installs checkout-only pre-commit and pre-push hooks that run this gate. The installer refuses to replace existing hooks. These hooks remain under `.git/hooks` when branches change, and they never enter a commit. If the VM is down or SSH fails, the gate fails before a commit or push. Keep ordinary CI and the existing Debian fixture workflow separate; neither reads `.env.local`.

This fixture proves behavior against this one Ubuntu VM at the time it runs. It cannot prove that every Linux distribution, permission state, network failure, or production desktop environment behaves the same way. Existing deterministic tests cover those branches; add a disposable fixture when a new host-specific behavior needs live proof.

## Feature-to-test matrix

Browser fixtures prove user interactions against controlled results; they do not prove SSH, SQLite, or Windows process behavior. Native and live columns identify where those boundaries are exercised. Component and Rust tests cover branches that are difficult to trigger safely in a live journey.

| Feature                   | Browser / component proof                                                                                                                                                                      | Native desktop proof                                                                                                               | Live SSH / Rust proof                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Saved connections         | `ConnectionDialog.test.tsx`, `connection-organization.test.ts`: validation and organization                                                                                                    | `connections.spec.ts`: create/edit/cancel/delete, search, groups/tags/order/collapse, restart                                      | Database organization and migration tests                                                             |
| Settings                  | `SettingsPane.test.tsx`, `app-journeys.browser.test.tsx`: defaults, save errors/retry, shell visibility across launchers, minimum size                                                         | `settings.spec.ts`: save/restart, discard/cancel, shell visibility, native maximize                                                | Settings validation, legacy settings, hidden shell persistence                                        |
| Workspaces                | Workspace target/persistence tests; real App navigation keeps its terminal                                                                                                                     | `terminals.spec.ts`, `local-data.spec.ts`: independent sessions, switching/rename, close cancellation, restart, deleting one owner | ConPTY and database ownership/reopen tests                                                            |
| Focus and splits          | `critical-ui.browser.test.tsx`: overflow; terminal groups/layout tests: pruning and restoration                                                                                                | `terminals.spec.ts`: both directions, input routing, groups/select/delete, close/prune, restored layout                            | Rust split-state validation and persistence                                                           |
| Terminals                 | `terminal-surface.browser.test.tsx`: real xterm search, Unicode/multiline clipboard input, selection copy; clipboard boundary is a fixture                                                     | `terminals.spec.ts`: ConPTY output, Unicode/multiline input, background activity, natural exit/restart, cleanup                    | ConPTY process shutdown/output flow tests; live reconnect journey                                     |
| Scratchpad                | `ScratchpadPane.test.tsx`, `scratchpad-draft.test.ts`: failed load/save/retry, pending-save/delete coordination, undo/redo                                                                     | `local-data.spec.ts`: scope isolation, autosave/restart, clear/delete cancellation                                                 | SQLite note ownership, migration, and cascade tests                                                   |
| History                   | `HistoryPane.test.tsx`, real App paste journey: search, integration errors, pause/capture controls, clear errors/cancel, exact paste without Enter, late responses                             | `local-data.spec.ts`: real SQLite history/search/clear and offline paste disabled                                                  | History parsing/security tests and isolated-home integration fixture                                  |
| Overview, Systemd, Docker | Real App navigation, Systemd filtering/stale refresh/retry, Docker filtered details and Logs links; pane tests cover late selection and sampling                                               | —                                                                                                                                  | Separate live Overview/Systemd/Docker journeys and malformed-output parsers                           |
| Ports and Boot            | Real App owner links, table/connections views, previous/current boot, limited evidence, one-shot sudo cancel/retry; pane tests cover graph and firewall uncertainty                            | —                                                                                                                                  | Separate live Ports/Boot journeys; read-only command and parser tests                                 |
| Logs                      | `LogsPane.test.tsx`, real App journeys: early events, delayed start cancellation, source changes, pause/resume, unread scroll/search/wrap, stream error/retry, navigation cleanup              | Runtime diagnostics verify no remaining stream IDs after each test                                                                 | Separate journal/Docker journeys; stream exit/diagnostic tests                                        |
| Baselines                 | `BaselinesPane.test.tsx`, real App capture/rename/retry/pin/delete/live comparison; `BaselineComparisonView.test.tsx`: Markdown/JSON success, cancel, failure, volatile filtering; trace tests | Local persistence in the live desktop journey                                                                                      | Live capture/restart/stored/live comparison; Rust capture/cancel/diff/retention tests                 |
| Updates and accessibility | Real App manual check/download retry/progress; updater fixtures; release-note safety, palette/keyboard, dialog focus, axe, reduced motion, minimum-size layout                                 | Settings and native window journey                                                                                                 | Updater endpoint, signature, installer and restart safeguards; E2E feature rejected in release builds |

Coverage reports support this matrix; there is no arbitrary percentage target. Normal PR checks remain automatic for unit and Chromium tests. Full desktop and SSH workflows remain explicit.
