# Support Windows 11 and a bounded Linux baseline

The first release of Control Room will support Windows 11 on x64. Structured inspection will target Debian and Ubuntu family hosts with systemd, journald, Bash, and a standard POSIX userland; Docker is optional. Other Linux systems may use the terminal on a best-effort basis, but the first release will not promise structured inspection on them. This narrower contract makes terminal lifecycle and remote parser behavior reproducible before public distribution.
