# Security

## Reporting

Before the repository is public, report security issues privately to the repository owner. Do not open a public issue for a vulnerability that could expose credentials, command history, host details, or remote access.

## Security boundaries

Control Room uses the installed Windows OpenSSH client and the user's existing OpenSSH configuration, known-hosts database, agent, and identity files. It does not copy or store private keys.

Interactive terminal bytes and fetched logs are kept in memory and are not written to SQLite. Sudo passwords are cleared by the frontend after submission and held in zeroizing Rust buffers where practical. Enhanced History is optional and stores command text, which may contain secrets, in the local application database.

Structured operations use fixed read-only command specifications and noninteractive OpenSSH authentication. They do not accept arbitrary shell commands from the frontend.

Installers are unsigned until public code signing is introduced. Windows may show an unrecognized-publisher warning.
