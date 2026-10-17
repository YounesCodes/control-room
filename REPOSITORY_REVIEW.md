# Control Room adversarial review

Review date: 2026-10-17. Baseline: `edb317d`, v0.8.6.
Branch: `codex/repository-adversarial-review`, in the existing checkout.

Nine first-party defects were confirmed and fixed. Eight dependency families
received compatible security updates. Third-party advisories that remain are
listed separately below. This review does not establish that the repository has
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
| R05 | P2       | Process exit can discard terminal output and race log completion                       | `src-tauri/src/session.rs:386`, `:493`; `src-tauri/src/remote.rs:2292`                           |
| R06 | P2       | Editing an SSH target reuses facts and inspection results from the old target          | `src-tauri/src/database.rs:126`, `:480`; `src/App.tsx:1257`; `src/lib/workspace-lifecycle.ts:68` |
| R07 | P2       | Late baseline reads can restore a comparison the user cleared or show the wrong detail | `src/pages/BaselinesPane.tsx:58`, `:87`, `:164`                                                  |
| R08 | P2       | Linux CPU sampling counts guest time twice and uses a limited integer format           | `src-tauri/src/remote.rs:346`                                                                    |
| R09 | P2       | Discovery can outlive the frontend's single-command timeout                            | `src/lib/api.ts:61`, `:99`, `:165`                                                               |

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
remounts inspection panes, and rejects old target detections. Overview refreshes
cannot publish after unmount. Metadata-only edits preserve valid caches.
Existing terminal sessions remain open until the user reconnects; the
Connections documentation now states this explicitly.

Validation: a real SQLite regression verifies rename preservation, target-change
invalidation, timestamp reset, and rejection of a late old-target write.
Workspace tests verify cache invalidation without restarting the terminal;
Overview tests verify rejection of a refresh after unmount.

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

Remaining findings are not resolved by this branch:

- Root npm audit reports 21 high-severity affected package entries, all in dev
  dependencies. These are dependency chains rooted in basic-ftp, braces,
  extract-zip, and serialize-javascript, not 21 independent application bugs.
  Relevant advisories include
  [basic-ftp](https://github.com/advisories/GHSA-c475-qrg2-pj4r),
  [braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
  [extract-zip traversal](https://github.com/advisories/GHSA-jmr9-qjv8-65gv),
  [extract-zip writes](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3), and
  [serialize-javascript](https://github.com/advisories/GHSA-5c6j-r48x-rmvq).
  The installed WDIO/Mocha/Tauri service dependency ranges do not admit the
  patched versions through a compatible audit fix. Forced ecosystem upgrades
  or overriding incompatible dependency ranges were not applied. Desktop test
  tooling still downloads and extracts external driver archives, so this remains
  a developer/CI supply-chain concern. A working exploit against this repository
  was not demonstrated.
- Docs npm audit reports 10 moderate entries, inherited from
  [postcss-selector-parser](https://github.com/advisories/GHSA-rj75-hqrm-r3gf).
  The compatible updates removed all four high-severity docs entries. npm's
  proposed direct-package change for the remaining chain is a Starlight
  downgrade from 0.41 to 0.21. That downgrade was not applied. The current site is
  built from repository content as static files; no attacker-controlled CSS
  parser input was demonstrated.
- Cargo audit reports zero vulnerability entries and informational warnings for
  unmaintained ttf-parser and proc-macro-error, plus glib iterator unsoundness.
  The Windows target dependency tree contains neither glib nor proc-macro-error.
  ttf-parser is used directly for font validation and remains an upstream
  maintenance concern. No replacement parser or unrelated dependency migration
  was introduced.

Root `npm audit --omit=dev` reports zero advisories. These results do not cover
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
Linux SSH checks, the native desktop build, and live SSH desktop tests. Final
gate counts and delivery results are recorded in the PR and handoff.

The docs check passed with zero errors, warnings, or hints, and the updated docs
lockfile built all 24 static pages successfully.

No real updater installation or real font installation was performed. A live
Windows SSH host, the optional Docker distribution matrix, and every possible
network failure/interleaving were not independently exercised by this review.
No claim of complete security, race freedom, or universal OS compatibility is
made. Local audit snapshots and reproduction output are in ignored
`test-results/review-*` files; machine-specific SSH configuration is not included
in the commit.
