# Control Room adversarial review

Review date: 2026-10-17. Baseline: `edb317d`, v0.8.6.
Dependency and input-order follow-up: 2026-10-18.
Branch: `codex/repository-adversarial-review`, in the existing checkout.

Ten application defects and two test setup issues were confirmed and
fixed. Eight dependency families received compatible security updates. Follow-up
work upgrades the desktop test stack, patches the docs selector parser, and
replaces the unmaintained font parser. Upstream platform warnings are listed
separately below. This review does not establish that the repository has
no other defects.

P1 means high priority because of data loss, blocked operations, or unsafe update
state. P2 means a reproducible correctness, reliability, or performance defect
with a narrower impact. Dependency advisory severity is reported separately from
demonstrated application impact.

## Resolved findings, in priority order

| ID  | Priority | Finding                                                                                | Exact location in this branch                                                                    |
| --- | -------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| R01 | P1       | Reversed history markers can remove unrelated shell configuration                      | `src-tauri/src/history.rs:12`, `:125`, `:147`                                                    |
| R02 | P1       | Update checks can replace the release during a download                                | `src-tauri/src/updater.rs:154`, `:202`; `src/hooks/use-app-updater.ts:59`                        |
| R03 | P1       | Sending SSH input can block before the timeout starts                                  | `src-tauri/src/remote.rs:947`, `:1041`                                                           |
| R04 | P1       | Unicode log trimming repeatedly encodes the same large string                          | `src/lib/log-buffer.ts:93`                                                                       |
| R12 | P1       | Concurrent terminal input requests can execute out of order                            | `src/lib/api.ts:67`                                                                              |
| R05 | P2       | Process exit can discard terminal output and race log completion                       | `src-tauri/src/session.rs:386`, `:493`; `src-tauri/src/remote.rs:2292`                           |
| R06 | P2       | Editing an SSH target reuses facts and inspection results from the old target          | `src-tauri/src/database.rs:126`, `:480`; `src/App.tsx:1263`; `src/lib/workspace-lifecycle.ts:68` |
| R07 | P2       | Late baseline reads can restore a comparison the user cleared or show the wrong detail | `src/pages/BaselinesPane.tsx:58`, `:87`, `:164`                                                  |
| R08 | P2       | Linux CPU sampling counts guest time twice and uses a limited integer format           | `src-tauri/src/remote.rs:346`                                                                    |
| R09 | P2       | Discovery can outlive the frontend's single-command timeout                            | `src/lib/api.ts:61`, `:115`, `:180`                                                              |
| R10 | P2       | Native rename test setup loses its transient hover state                               | `e2e/terminals.spec.ts:14`                                                                       |
| R11 | P2       | Scratchpad deletion test assumes autosave cannot finish during its clicks              | `src/pages/ScratchpadPane.test.tsx:77`                                                           |

### R01: reversed history markers

The scripts counted opening and closing markers but did not check their order.
With the closing marker first, uninstall kept deleting lines after the later
opening marker through the end of `.bashrc`. Install accepted the same damaged
file and replaced the integration script without repairing the block.

Install, uninstall, and status now reject reversed markers before changing shell
configuration. A real Git Bash fixture reproduced the old acceptance, returning
status 0 where status 2 was required. The expanded
`damaged_markers_stop_both_scripts_before_they_edit_anything` test now passes for
reversed, missing, and duplicated markers, including byte-for-byte preservation
of `.bashrc`. Existing reversible-install and opt-in tests also pass.

### R02: updater operation race

`begin_check` only excluded another check. While release A downloaded, a check
could replace the pending release with B. A's completion then stored A's bytes
beside B's metadata. A second installation could also obtain another copy of
the installer. The frontend's render-delayed state allowed duplicate operations
within one event turn.

Checks, downloads, and installations now exclude each other in Rust. A check
keeps its claim until it has committed its result. Installation consumes the
verified bytes once, and releases its claim if installation fails. Frontend
state is updated synchronously for operation eligibility. Signature verification
remains in the updater plugin. This was a release/bytes association defect, not
evidence that unsigned executables could be installed.

Validation: 11 updater Rust tests passed, including the new overlap regression.
Frontend tests verify that two immediate download requests and a concurrent
manual check produce only one download and preserve its completed state.
No real application update was installed during review.

### R03: SSH input outside the deadline

The executor called blocking `write_all` before starting output readers or
`wait_timeout`. If the peer stopped reading stdin, a script larger than the pipe
capacity could hold the operation and its limiter permit indefinitely. A peer
writing output before reading input could also deadlock the two pipes.

Input now runs on a worker while stdout and stderr drain, under the existing
process timeout. Temporary input copies use `Zeroizing`. Workers are joined on
success and failure. Log-stream password delivery uses the same worker, so the
start call returns a stream ID that the user can stop even if input is blocked.

Validation: a real PowerShell child that never reads a 1 MiB input is terminated
by a 250 ms test budget. A second child writes 128 KiB before reading 128 KiB of
input; both directions complete and the exact input length is verified.

### R04: Unicode log trimming

Trimming removed one UTF-16 unit at a time and re-encoded the entire remaining
string after every removal. Long Unicode lines caused quadratic CPU work on the
UI thread. Removing half a surrogate pair could also leave an invalid character
in the displayed log.

The replacement walks backward over complete code points once and counts their
UTF-8 widths. A release-baseline reproduction took about 897 ms to trim a 128 KiB
Unicode string to 32 KiB; the fixed version took about 1 ms in that same run.
These are illustrative local timings, not a general performance guarantee.
The old three-byte-cap reproduction retained an isolated low surrogate; the fix
retains no character when the final code point cannot fit.

Validation: tests cover the surrogate boundary and an 8 MiB emoji line trimmed
to the existing 5 MiB cap, alongside the existing sustained-stream buffer tests.

### R05: process exit before output drain

The terminal wait thread closed flow control as soon as the child exited. A
reader with bytes still buffered then failed its next reservation and discarded
them. It could also emit a connected event after the exit event. Log-stream
completion joined stderr but did not wait for stdout, allowing completion and
decoder flushing to race the last output.

Normal terminal exit now releases ConPTY's master, drains the output reader
while acknowledgements remain available, closes flow control, and emits the
final state. Explicit stop still unblocks a reader waiting for acknowledgements.
Log completion waits for stdout and stderr; the wait-error path kills, reaps,
and joins its workers.

Validation: a real ConPTY regression checks all 2,000 output markers, including
the last marker, through the production drain helper. Existing flow-control,
close, and session-exit tests remain part of the checkout's gate.

### R06: cached facts survive an SSH target edit

Capabilities were indexed only by Saved Connection ID. Changing that record
from a Windows host to a Linux host could leave Windows routing and old facts
active. Workspace lists and selected Windows shells survived the same change.
An old discovery finishing after the edit could repopulate the database cache.

Target edits now clear capabilities and the previous connection timestamp in
the update transaction. Capability writes compare the original SSH target with
the current saved target before accepting results. The frontend clears host
facts, inspection lists, container details, and target-specific shell choices,
remounts inspection panes, rejects old target detections, and discovers the new target. If an old detection is still running, the new read follows it. Overview refreshes
cannot publish after unmount. Metadata-only edits preserve valid caches.
Existing terminal sessions remain open until the user reconnects; the
Connections documentation now states this explicitly.

Validation: a real SQLite regression verifies rename preservation, target-change
invalidation, timestamp reset, and rejection of a late old-target write.
Workspace tests verify cache invalidation without restarting the terminal;
Overview tests verify rejection of a refresh after unmount. An App regression verifies that an edited target is discovered after an old read finishes, displays the new Windows identity, and keeps its terminal mounted.

### R07: stale baseline responses

Selecting No comparison did not invalidate an in-flight comparison. Its late
response could display results under an empty selector. Changing the selected
baseline left the previous detail in memory, so a failed new read could display
the old capture's sections under the new capture's heading. Selecting nothing
also failed to invalidate the previous detail request.

Detail and comparison reads now have request generations. Clearing or changing
selection invalidates old results and errors, clears old detail, and resets the
loading state. Live-comparison progress and results follow the same rule.

Validation: deferred-response tests cover clearing an in-flight comparison and
a failed detail read after selection changes. Existing baseline tests also pass.

### R08: CPU accounting

The probe summed every `/proc/stat` CPU column, including guest and guest_nice.
Linux already includes these in user and nice, as shown in
[account_guest_time](https://github.com/torvalds/linux/blob/master/kernel/sched/cputime.c).
The extra terms inflated busy percentages on virtualization hosts. `%d` also
depends on the awk implementation's integer formatting range.

The total now sums only user through steal, and prints counters using `%.0f`.
Validation executes the actual production probe against a fixture with guest
time and counters exceeding 32 bits. Both samples return the exact expected
total and idle values. Existing percentage parsing tests remain unchanged.
The first push gate exposed an overly short five-second budget in this new
Git Bash fixture during parallel Rust tests: it timed out before any output.
The same fixture passed alone in 1.71 seconds. It now uses the existing
20-second process budget while preserving the exact counter assertions; this
regression tests arithmetic, not shell startup speed.

### R09: discovery timeout mismatch

Capability discovery can try Linux and Windows sequentially. Each subprocess
has a 20-second budget, but the frontend abandoned the operation after 30
seconds. A valid second result or a classified error could therefore arrive
after the UI had already reported failure.

Capability refresh and connection testing now share the existing 60-second
platform-discovery allowance. Ordinary one-command inspections retain their
30-second backstop. Validation checks the two-command budget against the Rust
constants and verifies that discovery remains pending at 30 seconds and reports
its own timeout at 60 seconds. All nine API timeout tests pass.

### R10: native rename test setup

The native terminal suite passed 10 cases but failed two rename journeys because
the helper's Rename button was no longer clickable after moving over the tab.
Those controls depend on hover or focus. A diagnostic run at 150% Windows
scaling found correct button geometry and hit targets, and passed with the
extra timing introduced by the probe. This establishes timing-sensitive test
setup; it does not establish a persistent product hit-target defect.

The helper now clicks the active tab before approaching Rename. The existing
focus-within behavior keeps its actions revealed while layout changes. The
test still uses native clicks and checks that terminal process IDs survive the
actions. No product CSS or interaction behavior changed, and browser hover
coverage remains in place. All 12 native terminal cases passed after the change.
Temporary diagnostic instrumentation was removed.

### R11: Scratchpad deletion test races autosave

The original regression expected a recovery draft after a failed deletion, but
used two asynchronous clicks before checking it. Under load those clicks can
cross the 600 ms autosave delay. Successful persistence correctly removes the
recovery draft, making the assertion fail even though the editor and saved note
retain the latest text. This blocked the second push attempt. Waiting explicitly
for autosave reproduced the same failure in isolation.

The test now covers two explicit states. Pending-save deletion is triggered in
one event turn and verifies that the save never started and the draft survives.
The saved case waits for persistence and correctly expects no recovery draft.
Both verify that failed deletion preserves editor text and that retrying deletion
succeeds. All eight Scratchpad tests pass. No Scratchpad product code changed;
this finding concerns a false failure in the test, not demonstrated data loss.

### R12: terminal input ordering

The upgraded native runner exposed a command received as `ecoh` instead of
`echo`. The input API submitted each keyboard chunk independently, without
waiting for the preceding IPC operation. The backend writer mutex prevents
simultaneous writes, but cannot impose the frontend's intended order on
independent requests. Reordered input can change a command's meaning.

Input writes now wait for the preceding write to that session. Separate
terminals remain independent. Queued bytes are copied at submission, individual
failures still reach callers, and the queue entry is removed after its final
operation. A failed operation does not permanently block later writes.

The regression failed on the original API because a second invocation started
while the first was blocked. All three new input-order tests and 34 focused
terminal/API tests pass after the fix. All 12 native terminal/workspace cases
passed using the rebuilt app and WebdriverIO 10, including the previously
failing horizontal split input case.

## Dependency findings and remaining work

Compatible lockfile updates were applied without changing direct dependency
ranges or adding dependencies:

| Dependency family                    | Previous | Fixed  |
| ------------------------------------ | -------- | ------ |
| Application tooling: brace-expansion | 5.0.9    | 5.0.12 |
| Application tooling: undici          | 7.29.0   | 7.30.1 |
| Docs: devalue                        | 5.9.2    | 5.9.4  |
| Docs: fast-uri                       | 3.1.7    | 3.1.8  |
| Docs: http-cache-semantics           | 4.2.0    | 4.3.0  |
| Docs: sharp and platform binaries    | 0.35.4   | 0.35.5 |
| Docs: smol-toml                      | 1.8.0    | 1.9.1  |
| Docs: source-map-js                  | 1.2.1    | 1.2.2  |

The initially remaining dependency findings were addressed in follow-up work:

- D01, high advisory severity, development tooling. Root npm audit initially
  reported 21 affected entries in chains rooted in basic-ftp, braces,
  extract-zip, and serialize-javascript.
  Relevant advisories include
  [basic-ftp](https://github.com/advisories/GHSA-c475-qrg2-pj4r),
  [braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
  [extract-zip traversal](https://github.com/advisories/GHSA-jmr9-qjv8-65gv),
  [extract-zip writes](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3), and
  [serialize-javascript](https://github.com/advisories/GHSA-5c6j-r48x-rmvq).
  `package.json` and `package-lock.json` now use WebdriverIO 10, Mocha 12,
  Puppeteer Browsers 3, and serialize-javascript 7.1.2. The other three vulnerable
  families are removed. Scoped overrides align Tauri service 1.5's WebdriverIO
  and globals with the root packages. Its removed callback helper is supplied
  by `e2e/async-script-service.ts` through the retained W3C async-script endpoint,
  including session reload setup in `wdio.conf.ts`. Two compatibility tests
  cover function/string callbacks, repeated setup, and protocol errors.
  The initial npm transition required peer-set resolution with `--force`;
  the resulting lockfile then passed a clean `npm ci --ignore-scripts` without
  peer bypass flags and `npm ls --all` reported no invalid dependencies. Root
  audit now reports zero advisories, including development dependencies.
- D02, moderate advisory severity, docs build tooling. Ten remaining entries
  were inherited from
  [postcss-selector-parser](https://github.com/advisories/GHSA-rj75-hqrm-r3gf).
  `docs/package.json` scopes an override to postcss-nested's selector parser,
  upgrading 6.1.4 to patched 7.1.6 without downgrading Starlight or changing the
  site's authored CSS. Docs audit now reports zero advisories. The docs check,
  24-page build, and all 38 desktop/mobile browser tests passed using installed
  Chrome. The first browser attempt lacked its Playwright browser binary;
  that was an environment prerequisite, not a docs assertion failure.
- D03, maintenance warning in the shipped font path. `src-tauri/Cargo.toml`
  replaces ttf-parser 0.25.1 with maintained Skrifa 0.48.0. The parser migration
  in `src-tauri/src/fonts.rs` preserves mandatory header validation, family and
  weight checks, and registration rollback. A new malformed-header regression
  covers absent tables, invalid units/location format, and zero glyphs.
  All 14 focused font tests passed. The opt-in public-service test also passed,
  downloading regular/bold fonts and checking Latin/Cyrillic character mappings.
  Cargo audit no longer reports the ttf-parser warning.

Two upstream warnings remain in the complete cross-platform Cargo lockfile:
unmaintained proc-macro-error and glib iterator unsoundness. Both are pulled in
by Tauri's Linux GTK3 dependencies. The Windows target dependency graph contains
neither crate. They have not been hidden with advisory ignores or removed from
the lockfile by hand. Replacing Tauri's Linux GUI stack is outside this Windows
application's dependency contract. Cargo audit still reports zero vulnerability
entries; these two full-lock warnings remain visible.

Root and docs `npm audit` both report zero advisories. These results do not cover
unknown vulnerabilities, compromised upstream releases, or flaws in Windows,
OpenSSH, WebView2, or the updater plugin itself.

## Review coverage and validation limits

The review traced the application lifecycle, local and remote terminal launch,
SSH argument construction and validation, privilege input, process timeouts,
output flow control, stream cleanup, Windows shell discovery and inspection,
SQLite migrations and ownership, settings and workspace persistence, scratchpad
autosave, history integration, baseline capture/comparison, CPU/header metrics,
font downloading/installation, updater state, IPC contracts, pane request
lifecycle, accessibility primitives, driver cleanup, artifact sanitization,
release workflows, docs, and dependency locks. Existing tests were read beside
the implementations; the regression tests above exercise previously missed
paths. This was code-path and risk-based review, not formal verification of
every line or exhaustive enumeration of thread schedules.

Focused frontend, SQLite, PowerShell pipe, ConPTY, shell-integration, updater,
CPU-fixture, and API timeout regressions passed. Windows shell-discovery and
Docker command fixtures passed. The checkout's pre-commit and pre-push hooks run
`test:local-gate`, including static checks, frontend/Rust/browser suites, live
Linux SSH checks, the native desktop build, and live SSH desktop tests. The
completed application-fix gate passed with the following results:

| Validation                                               | Result                                                 |
| -------------------------------------------------------- | ------------------------------------------------------ |
| Frontend unit/component/tooling tests                    | 584 passed across 72 files                             |
| Rust tests                                               | 277 passed; 11 opt-in tests ignored in the default run |
| Browser/accessibility tests                              | 98 passed across 10 files                              |
| Live Linux SSH Rust integration tests                    | 4 passed, explicitly running opt-in tests              |
| Live Windows SSH inspection and shell selection          | 2 passed against the user-selected Gaming PC           |
| Public font catalog/download integration                 | 1 passed for regular/bold and Latin/Cyrillic glyphs    |
| Live Linux SSH desktop journeys                          | 9 passed                                               |
| Dedicated native terminal/workspace suite                | 12 passed with WDIO 10 and ordered terminal input      |
| Formatting, lint, TypeScript/Vite build, Rust fmt/clippy | Passed                                                 |
| Windows native desktop test build                        | Passed                                                 |

The remaining opt-in tests and platform limits are not represented as passing.
Git hooks enforce the gate again for the final test changes and push;
delivery results are recorded in the PR and handoff.

The docs check passed with zero errors, warnings, or hints, and the updated docs
lockfile built all 24 static pages successfully. All 38 docs browser checks
passed. The Windows release build produced an NSIS installer with the new font
parser; the final input-order change also receives a rebuilt native app.

No real updater installation or end-to-end catalog font installation was
performed. The Rust suite exercised reversible native font registration with a
temporary fixture. The selected installed-app Gaming PC connection initially
timed out while Tailscale was unavailable. After the user made it reachable,
both existing Windows SSH tests passed. They verified 60 listening sockets,
295 services, connection/firewall/resource evidence, shell discovery, and cached
PowerShell selection without a second discovery round trip.
The optional Docker distribution matrix and every possible network
failure/interleaving were not independently exercised by this review.
No claim of complete security, race freedom, or universal OS compatibility is
made. Local audit snapshots and reproduction output are in ignored
`test-results/review-*` files; machine-specific SSH configuration is not included
in the commit.
