# Control Room

Control Room is a Windows desktop app for opening local shells and inspecting Linux systems over SSH.

The React frontend owns presentation and frontend state; the Rust/Tauri backend owns native processes, persistence, and remote operations.

## Repository guide

- `src/`: React UI, frontend state, and TypeScript tests.
- `src-tauri/`: Rust backend, Tauri commands, process management, and Rust tests.
- `docs/`: User-facing behavior and troubleshooting.
- Tests and implementation are the source of truth for exact feature behavior.

Read `DESIGN.md` before making UI changes.

Find nearby tests and existing implementation before changing a feature contract.

## Working agreements

- Inspect the current diff and preserve existing user changes. Avoid unrelated redesign or cleanup.
- Add or update focused tests for behavior changes, including parser, argument construction, persistence, and lifecycle regressions where relevant.
- Keep `DESIGN.md` and `docs/` accurate when behavior or project boundaries change.
- Avoid adding or upgrading dependencies unless required by the task.
- Do not modify `AGENTS.md` files unless explicitly asked to.
- Do not create additional `.md` file unless explicitly asked to.
- Always work in a dedicated branch unless explicitly asked not to.
- After completing and validating the task, commit and push all task-related changes to that branch, then open a PR against main.
- When opening a PR, correctly link all corresponding issues using GitHub issue links. Use closing references when merging the PR completes the issue; otherwise, link the issue without automatic closure.
- For releases, create a GitHub draft release for the next `vX.Y.Z` tag and write its release notes in the draft body before pushing the tag. Keep the release as a draft. The tag workflow builds the app, copies the GitHub body into `latest.json`, verifies that the notes match, and publishes the release. Release notes do not need a file or commit in this repository.
- Prefer self-explanatory layouts over instructional text; remove redundant labels and captions, but preserve concise explanations when they improve clarity or prevent mistakes.
- Optimize for task clarity, predictable behavior, maintainability, and reliable agent workflows; prefer simpler solutions unless added complexity provides measurable value.

## UI/UX quality gates

- Inspect the existing implementation and rendered UI before changing a screen. Understand the user task and usability problem. Keep `DESIGN.md` as the source of design decisions and `src/styles.css` as the source of exact tokens.
- Prefer the simplest coherent information hierarchy. Remove clutter and duplication before adding controls, cards, explanations, or animations. Reuse existing components, tokens, and interaction patterns; avoid one-off styling and unnecessary abstractions.
- Treat clarity, readability, alignment, keyboard access, accessibility, discoverability, stable layouts, and performance as acceptance criteria.
- For user-visible React UI changes, run a relevant focused headless scenario, such as `npm run ui:capture -- --scenario settings` or `npm run ui:capture -- --scenario systemd --state populated`. Use `--list` for supported scenarios/states and `--viewport normal` or `--viewport narrow` to select a size; the default captures both 1440×900 and 960×640. Find PNGs through `test-results/ui-review/<scenario>/<state>/<viewport>/capture/manifest.json`, then actually inspect readability, hierarchy, alignment, clipping, and consistency. See `docs/testing.md` for the capture workflow and limitations.
- For redesigned layouts, compare before/after captures at normal and narrow widths. Preserve the before images outside the selected output folder before recapturing. Exercise relevant loading, empty, populated, error, stale/unavailable, overflow, narrow-window, and reduced-motion states; fix problems and recapture as needed.
- For motion/timing changes, use `npm run ui:motion -- --scenario settings` when applicable and inspect the before/start/during/after PNG sequence listed in the `motion/manifest.json` at the same scenario/state/viewport path. Confirm the intended transition occurs with normal motion enabled. Sampled poses do not prove frame pacing or native behavior. If the needed scenario is missing, add it in a separately scoped follow-up or disclose the gap.
- Check impacted entry points and ways out, including toolbar/menu, command palette, shortcuts, Settings, navigation, split panes, and Focus Mode where applicable.
- Animate only to clarify an action or state. Avoid constant repaints, dropped frames, layout shifts, and motion that impedes work. Reserve stable space for live values, percentages, progress, and update indicators.
- Use small focused unit tests for behavior defects and visual evidence for cosmetic/layout defects; avoid brittle tests for styling trivia. Passing tests or E2E checks do not replace visual review. Suitable existing hosted CI artifacts or user-provided captures may replace local capture; download an existing `ui-review` artifact rather than repeating a heavy run. Never claim visual verification without inspecting rendered results. Report unavailable capture or vision review, native-only gaps, and remaining verification limits, and include available evidence in the PR description.

## Validation

Start with the smallest relevant validation, then expand according to the surface area of the change.

Run only tests relevant to the changes; skip validation for trivial or documentation-only edits. Avoid rerunning checks already passed for unchanged code or enforced by Git hooks/CI. Run the full suite only when explicitly requested or when changes affect multiple independent subsystems.

Focused unit/static checks, background/headless Playwright/Vitest tests and captures on the Windows laptop or headless Ubuntu server, and scoped nondestructive SSH fixture tests are allowed without separate approval. Use the Ubuntu server when useful; it is not required. Respect the fixture's documented permissions and scope. Avoid repeated heavy builds or parallel workloads that degrade the laptop.

Launching a native Control Room/Tauri app, a visible browser, or desktop E2E that spawns them on the Windows laptop requires explicit approval. Do not manipulate the user's live session or steal focus. Detached/background execution does not make a native desktop launch safe. If verification requires such a launch, obtain approval or report the limitation. Headless Chromium does not verify native WebView2/Tauri behavior. GitHub-hosted CI is isolated from the laptop and may run its established desktop suites.

- If you lack vision capabilities, delegate UI/UX visual verification to an available vision-capable subagent. This is the only permitted use of subagents; otherwise, do not use subagents at all.
- **Frontend-only changes:** Run the relevant frontend tests and static checks.
- **Rust/backend changes:** Run the relevant Rust tests and checks.
- **Changes crossing the Tauri boundary:** Validate both frontend and Rust layers.
- **Persistence, process, terminal, or native-window changes:** Run relevant dedicated headless/integration tests; defer native desktop tests to hosted CI or obtain explicit approval for a local launch.
- **UI behavior changes:** Run relevant headless browser/accessibility tests and apply the visual gates above. Any visual-review subagent follows the same desktop/session boundaries.
- **Build/package changes:** Perform the appropriate Windows application build without launching it. Native runtime checks belong in hosted CI or an explicitly approved local run.
- **Local SSH validation and hooks:** The managed pre-commit hook runs only `npm run check:staged`; no full pre-push gate is installed. Never stage `.env.local` or weaken/bypass checks. For justified non-GUI checks against the configured Ubuntu fixture, use `npm run test:live-ssh` with established credentials and scope. `npm run test:local-lab` and the separate manual Windows-only `npm run test:local-gate` both launch desktop E2E and require explicit approval on the laptop. Keep `test:local-gate` available for pre-release or high-risk integration checks. Ordinary PR CI independently runs frontend, browser, Rust, desktop, hosted SSH, and installer jobs; it does not invoke `test:local-gate` or use the developer's private fixture. Do not start laptop desktop E2E merely to test SSH.

Fix failures introduced by the requested change and rerun the affected checks.

## Completion

- After related PRs are merged or closed, reconcile the linked issue: close it if resolved; otherwise leave it open.
- Review the final diff for accidental or unrelated changes.
- Confirm behavior changes are covered by focused tests where appropriate.
- Update documentation only when the documented behavior changed. See `docs/AGENTS.md` for documentation guidelines.
- Report what changed, what was validated, what could not be validated, and any remaining risks or follow-up work.
- After a PR is merged or closed, clean up its local and remote branches and unused worktree, preserving any needed unmerged work.
