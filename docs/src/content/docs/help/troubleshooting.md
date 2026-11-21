---
title: Troubleshooting
description: Fix common SSH, host view, Docker, and local shell problems.
---

**The terminal works, but the host views fail.** The views can't type a password. Set up an SSH key or ssh-agent for the host. Then open **Edit connection** and select **Test structured access** to check.

**SSH is missing.** On Windows, turn on **OpenSSH Client** in Windows optional features. On Ubuntu, install `openssh-client`. Then restart Control Room.

**A view says it needs permission.** Some Docker, port, and firewall details need more access. Use **Retry with sudo** in the view, or allow sudo for that host in Settings. See [Security](/control-room/reference/security/#sudo).

**Docker is unavailable.** Open Docker to read why. Docker may not be installed or running, or your account may not be allowed to use it.

**Some information is missing.** A tool may be missing on the host, or the account may not have access. The view says which. See [What the host needs](/control-room/start-here/installation/#what-the-host-needs).

**A local shell is missing.** Install it, then check **Settings > Terminal > Local shells** in case you hid it. Git Bash comes from Git for Windows.

**The window shows an error.** Select **Reload**. Your saved hosts, settings, and notes are kept.
