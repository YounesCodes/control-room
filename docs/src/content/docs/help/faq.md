---
title: FAQ
description: Quick answers about SSH, local shells, and saved data.
---

**Does it use my usual SSH setup?** Yes. The terminal uses Windows OpenSSH, including your SSH config and agent.

**Does it save passwords or keys?** No. It can save the path to an existing private key, but never copies the key or stores SSH or sudo passwords.

**Can I use a local shell?** Yes. Installed PowerShell, Command Prompt, and Git Bash shells can open in tabs and splits.

**Does it change the Linux host?** The inspection views only read. Commands you type in the terminal have their normal effects. Optional Enhanced History changes the remote account's Bash startup files when you enable or remove it.

**Does it save terminal output or logs?** No. It keeps fetched output in memory while you view it. See [Security and storage](/control-room/reference/security/) for what is saved.
