# Control Room agent rules

Read `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, `CONTEXT.md`, and the ADRs before changing architecture or scope.

1. Do not add features listed under Non-goals.
2. Do not replace system OpenSSH and ConPTY without an explicit ADR.
3. Do not expose arbitrary shell execution to React.
4. Keep native process management, SQL, SSH argument construction, and remote command construction in Rust.
5. Do not persist terminal output, fetched logs, SSH passwords, sudo passwords, or imported private keys.
6. Use IDs for every Saved Connection, Workspace, Terminal Session, Structured Operation, and Log Stream.
7. Preserve multiple simultaneous Workspaces, including several for one Saved Connection.
8. Structured Operations are read-only and require noninteractive OpenSSH authentication.
9. Enhanced History is opt-in, Bash-only, reversible, and limited to commands reported by Control Room's shell integration.
10. Do not guess commands from terminal keystrokes.
11. Add tests for parsers, argument builders, lifecycle changes, and regressions.
12. Keep documentation current in the same change as behavior.
13. Do not redesign unrelated UI while implementing backend behavior.
14. Do not commit or push unless the user asks.
