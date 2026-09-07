---
title: Release process
description: Maintainer requirements for signed Windows and macOS release packages.
---

The release workflow builds one version for both supported client platforms before it makes the GitHub release public:

- Windows 11 x64: per-user NSIS installer, updater signature, and SHA-256 checksum
- macOS 12 or later on Apple silicon: signed and notarized `.app`, `.dmg`, updater archive, updater signature, and SHA-256 checksum
- one updater manifest containing `windows-x86_64` and `darwin-aarch64`

The macOS job runs first and creates a draft release. The Windows job adds its artifacts to that same draft. A final job verifies every expected artifact and updater-manifest entry before publishing it. A failed build, signing step, notarization, signature check, checksum check, or manifest check leaves the release unpublished.

## Repository secrets

The repository owner must configure these GitHub Actions secrets:

| Secret                               | Purpose                                                                |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Signs Tauri updater artifacts for both platforms                       |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Unlocks the updater signing key when the key has a password            |
| `APPLE_CERTIFICATE`                  | Base64-encoded Developer ID Application certificate in PKCS #12 format |
| `APPLE_CERTIFICATE_PASSWORD`         | Unlocks the PKCS #12 certificate                                       |
| `APPLE_SIGNING_IDENTITY`             | Exact Developer ID Application identity used for code signing          |
| `APPLE_ID`                           | Apple account used to submit the package for notarization              |
| `APPLE_PASSWORD`                     | App-specific password for that Apple account                           |
| `APPLE_TEAM_ID`                      | Apple Developer team identifier                                        |

The updater public key remains in `src-tauri/tauri.conf.json`. Certificates, private keys, passwords, and Apple credentials must never be committed.

## Before the first macOS release

The owner must complete these steps on the repository and Apple Developer account:

1. Create or obtain a Developer ID Application certificate and export it as a password-protected PKCS #12 file.
2. Add every secret listed above to the GitHub repository.
3. Run CI and the release workflow on the feature branch or a test tag, then confirm the macOS bundle compiles and notarization succeeds on GitHub's Apple silicon runner.
4. Install the resulting disk image on an Apple silicon Mac and verify launch, native window controls, SSH, ssh-agent, SSH config discovery, zsh, Bash, fish when installed, terminal resize and exit, local persistence, remote Workspace persistence, and in-app update behavior.
5. Confirm Gatekeeper accepts the downloaded app and that `spctl` reports the packaged app as accepted and notarized.

Intel macOS is source-compatible but is not built or published by the current workflow. Shipping Intel packages requires adding an x86_64 macOS runner or target, producing its app and disk image, and adding `darwin-x86_64` to the updater manifest verification.
