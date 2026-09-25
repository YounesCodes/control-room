---
title: Settings
description: Configure terminal display, logs, Enhanced History, sudo reads, Control Room updates, and SSH environment details.
---

Open Settings from the top bar. Changes apply after you save them.

## Terminal

Configure:

- terminal font family
- font size from 9 to 32
- scrollback from 100 to 100,000 lines
- default text and cursor color, plus ANSI color slots 1–6

Pick a swatch to change a color. **Default text and cursor** sets the terminal's foreground and cursor color. In the preview, the sample command and output use that foreground, while the generic prompt uses ANSI 2. ANSI slots 1–6 are the standard red, green, yellow, blue, magenta, and cyan slots; their numbers stay fixed when you change their shades. The hints beside the slots show common uses, such as errors and directories. Actual use depends on the shell or program. The preview and any readability warning update after you close the picker. Colors that are hard to read against the black terminal background get a warning, but you can still save them. **Reset colors** returns the palette to the app defaults. Save to apply the palette to local and SSH terminals. Right-click behavior is built in and is not listed here; see [SSH terminal](/control-room/terminal/#right-click-behavior).

## Local terminal

Pick which local shells the **Local terminal** button, **New terminal**, and the split menu offer. Every installed profile is on by default; turn off the ones you never use, such as Command Prompt, and they disappear from all of those menus at once.

Turning a shell off is presentation only. It stays installed, a Workspace already running it keeps going and restores after a restart, and **Show all** brings every hidden shell back in one step. Changing the list takes effect when you save.

## Logs and History

Choose the default log tail from 50, 100, 200, 500, or 1000 lines. The global Enhanced History switch controls whether remote connections capture reported Bash commands. Existing entries remain until you delete or clear them.

## Elevated reads

The global sudo setting allows passwordless sudo reads for every Saved Connection. Each connection also has a per-host allowance. When the global setting is active, the per-host control is locked and explains why.

Allowing the setting does not make Control Room prompt for a password. See [Security](/control-room/reference/security/) for the full behavior.

## Control Room updates

Settings shows the running version under **Current version**. **Automatically check for updates** is on by default and makes Control Room check GitHub Releases shortly after start, periodically while it stays open, and when you return to the app after it has been in the background long enough. **Check for updates** runs a manual check at any time, even with the automatic preference off, and reports that you are up to date, the available version, or why the check failed.

Update packages are cryptographically signed and verified before anything is installed. This updates Control Room on this Windows machine only. It never installs or updates anything on a Remote Host.

[Updating Control Room](/control-room/start-here/installation/#update-control-room) describes what happens between download and restart.

## SSH environment

Settings shows the detected Windows OpenSSH executable, the OpenSSH config path, and ssh-agent availability. These values describe the local environment. Control Room does not replace OpenSSH configuration or store agent keys.
