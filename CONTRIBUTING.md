# Contributing

Control Room is being polished privately before its public launch. Issues and pull requests can follow this process once the repository is opened.

## Development

Use Windows 11 x64 with the prerequisites in the README. Install locked dependencies with `npm ci`, then run the desktop development build with `npm run tauri dev`.

Before opening a pull request, run:

```bash
npm run check
npm run tauri build
```

Keep remote operations read-only. Rust must own SSH arguments, process lifecycle, SQLite, and remote command construction. Do not add private-key import, terminal or log persistence, destructive service or container actions, or arbitrary remote shell commands outside the terminal byte stream.

Live SSH fixture tests must use a host and account you control. They are ignored by default and documented in `docs/TESTING.md`.
