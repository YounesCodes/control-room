---
title: Settings
description: Configure terminal display, logs, Enhanced History, sudo reads, and SSH environment details.
---

Open Settings from the top bar. Changes apply after you save them.

## Terminal

Configure:

- terminal font family
- font size from 9 to 32
- scrollback from 100 to 100,000 lines
- right-click paste
- ANSI foreground, red, green, yellow, blue, magenta, and cyan colors

Reset returns the ANSI palette to the app defaults. Terminal settings apply to both local and SSH terminals.

## Logs and History

Choose the default log tail from 50, 100, 200, 500, or 1000 lines. The global Enhanced History switch controls whether remote connections capture reported Bash commands. Existing entries remain until you delete or clear them.

## Elevated reads

The global sudo setting allows passwordless sudo reads for every Saved Connection. Each connection also has a per-host allowance. When the global setting is active, the per-host control is locked and explains why.

Allowing the setting does not make Control Room prompt for a password. See [Security and data](/control-room/reference/security/) for the full behavior.

## SSH environment

Settings shows the detected Windows OpenSSH executable, the OpenSSH config path, and ssh-agent availability. These values describe the local environment. Control Room does not replace OpenSSH configuration or store agent keys.
