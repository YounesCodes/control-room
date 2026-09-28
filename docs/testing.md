# Testing

Control Room keeps most checks in fast Rust unit tests and Vitest jsdom component tests. A small Chromium suite checks browser focus and accessibility behavior. Separate desktop tests cross React, Tauri IPC, Rust, SQLite, and Windows APIs. Three ignored Rust tests use a real Debian SSH fixture.

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

The [Tauri 2 WebDriver guidance](https://v2.tauri.app/develop/tests/webdriver/) recommends WebdriverIO with its Tauri service. This suite uses an external `tauri-driver` on Windows. WebdriverIO's helper plugin and its permission load only in the debug E2E build; production builds select only the default capability and omit the plugin. The service installs `tauri-driver` and a matching Edge WebDriver if needed. The `desktop-e2e` Cargo feature requires the runner's temporary `CONTROL_ROOM_E2E_DATA_DIR`; the WDIO configuration creates and removes that directory. The tests use real IPC and SQLite, assert output from a Command Prompt ConPTY session, and read native maximize state and dimensions. The Saved Connection points at `example.invalid` without connecting. Run the optional `Desktop E2E` GitHub workflow on an interactive Windows runner for CI.

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

Run `npm run test:local-lab` to check the real Rust structured reads, an in-memory Host Baseline, a reversible Enhanced History install in a temporary remote home, SSH through ConPTY, and a desktop UI connection. The UI test uses the E2E app's temporary local database, opens Overview and Systemd, then deletes its Saved Connection. It does not change the VM's services, containers, firewall, or saved user files. Docker details run only when the account can access Docker without sudo. Firewall reads stay unelevated; permission denial is checked as a valid result.

Run `npm run test:local-gate` for the ordinary checks, Chromium tests, and the local VM suite together. `npm run install:local-lab-hooks` installs checkout-only pre-commit and pre-push hooks that run this gate. The installer refuses to replace existing hooks. These hooks remain under `.git/hooks` when branches change, and they never enter a commit. If the VM is down or SSH fails, the gate fails before a commit or push. Keep ordinary CI and the existing Debian fixture workflow separate; neither reads `.env.local`.

This fixture proves behavior against this one Ubuntu VM at the time it runs. It cannot prove that every Linux distribution, permission state, network failure, or production desktop environment behaves the same way. Existing deterministic tests cover those branches; add a disposable fixture when a new host-specific behavior needs live proof.
