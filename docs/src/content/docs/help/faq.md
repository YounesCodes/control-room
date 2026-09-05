---
title: FAQ
description: Short answers about scope, storage, permissions, and supported hosts.
---

### Does Control Room replace SSH?

No. It hosts the Windows OpenSSH client inside its own terminal and adds read-only views around the same Saved Connection.

### Does it change my Linux host?

Structured operations do not. They read bounded data only. Enabling or removing Enhanced History is an explicit exception because it changes the remote account's Bash startup configuration.

### Does it store my private key?

No. An identity-file field points to a key in its existing location. Control Room stores the path, not a copy of the key.

### Does it store terminal output or logs?

No. Terminal output, fetched logs, and Boot Diagnostic evidence stay in memory and are discarded with their session or view.

### Does it monitor hosts in the background?

No. Overview load sampling runs only while the Overview pane is mounted and visible. There is no agent, schedule, alert, or stored time series.

### Does it update itself?

Yes, on Windows. Control Room checks GitHub Releases and installs an update only after you confirm the restart. It never installs or updates packages on a Remote Host.

### Can I use local terminals?

Yes, if the profile is installed. Control Room supports PowerShell 7, Windows PowerShell, Command Prompt, and Git Bash. Local Workspaces are terminal-only and do not record History.

### Can I manage services or containers?

No. You can inspect them and open their logs. Start, stop, restart, create, and remove controls are outside Control Room's scope.

### Why is my port shown without an owner?

The account may not be allowed to read process ownership. Control Room keeps the socket fact and the owner fact separate. Retry with sudo if that is appropriate.
