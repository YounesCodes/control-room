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
- Always work in a dedicated branch and worktree unless explicitly asked not to.
- After completing and validating the task, commit and push all task-related changes to that branch, then open a PR against main.

## Validation

Start with the smallest relevant validation, then expand according to the surface area of the change.

- **Frontend-only changes:** Run the relevant frontend tests and static checks.
- **Rust/backend changes:** Run the relevant Rust tests and checks.
- **Changes crossing the Tauri boundary:** Validate both frontend and Rust layers.
- **Persistence, process, terminal, or native-window changes:** Run their dedicated integration/desktop tests where available.
- **UI behavior changes:** Run the relevant browser/accessibility tests when applicable.
- **Build/package changes:** Perform the appropriate Windows application build.
- **Local SSH validation:** When this checkout has `.env.local`, run `npm run test:local-gate` before any commit or push. It uses the ignored Ubuntu fixture and real Windows SSH, so keep it out of CI. Checkout-local Git hooks run the same gate. Do not bypass them or stage `.env.local`.

Fix failures introduced by the requested change and rerun the affected checks.

## Completion

Before finishing:

- Review the final diff for accidental or unrelated changes.
- Confirm the requested behavior is covered by focused tests.
- Run the validation appropriate to the affected layers.
- Update documentation only when the documented behavior changed. See `docs/AGENTS.md` for documentation guidelines.
- Report what changed, what was validated, what could not be validated, and any remaining risks or follow-up work.
