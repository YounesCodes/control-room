---
name: control-room-release
description: Prepare and publish a new Control Room version when asked to release the app. Write concise user-facing release notes and provide them to the release workflow.
---

# Release Control Room

Use this skill when asked to release a new Control Room version. Follow the repository instructions and the existing version, validation, tag, and release workflow. Do not publish a release unless the user has asked for one.

Before creating the release tag:

1. Identify the previous published release and inspect the changes through the intended release commit. Read the relevant implementation and PRs when needed to understand what actually changed. Include direct commits as well as merged PRs.
2. Write `release-notes/v<version>.txt` in the release commit, using the exact version of the tag, such as `release-notes/v1.2.3.txt` for `v1.2.3`. The release workflow requires this file and copies its contents to the GitHub release and the in-app updater.
3. Describe the changes that matter to people using Control Room in a short paragraph or concise bullets. Explain new capabilities and meaningful fixes in plain language. Combine related changes, avoid jargon and PR numbers, and omit test-only work, internal refactoring, routine dependency updates, and other implementation details unless they have a meaningful user impact. Do not invent benefits or claim behavior that has not been verified. If there are no visible changes, say so honestly and briefly.
4. Make sure the notes are committed in the exact commit being tagged, and verify the version manifests and relevant checks before publishing. After the release workflow finishes, check that the published release and `latest.json` contain the same notes and that the expected updater artifacts are present.
