---
title: Troubleshooting
description: Diagnose common connection, inspection, Docker, terminal, and local shell problems.
---

## The terminal connects, but structured access fails

Open the connection editor and select **Test structured access**. Structured operations use noninteractive SSH. Check that the host accepts public-key authentication or an ssh-agent identity without a password prompt.

An interactive password login can work while structured access fails. That is expected when OpenSSH would need to ask for a password.

## A view says permission is required

Some facts need more access, especially socket ownership, firewall rules, Docker, and parts of boot diagnostics. Enable the appropriate sudo allowance if you want passwordless elevation, then retry. If the account requires a password, use the one-shot retry offered by the pane.

The view may still show partial facts. Missing owner data is not treated as proof that no process owns the socket.

## Docker is unavailable

Check the Docker capability row in Overview. The daemon may be absent, inaccessible to the account, or accessible only with sudo. Retry the Docker read with the allowed path when appropriate.

Containers without validated Compose project and service labels appear under Ungrouped. That does not mean the container is outside Compose. It means Control Room did not have enough validated label data to group it.

## A local shell is not offered

Only installed profiles appear. Check that PowerShell 7, Windows PowerShell, Command Prompt, or Git for Windows is installed. Control Room resolves the known shell profiles itself and rejects unknown ids. It does not use `System32\bash.exe` as Git Bash.

## A restored Workspace is disconnected

This is normal. Control Room restores tabs and layout, but never reconnects SSH or starts a local process automatically. Select the Workspace and reconnect or start it.

## Boot or port data is partial

Structured reads have bounds and independent sections. A missing timestamp, permission error, unsupported command, or truncation stays visible as such. Use the terminal for a broader investigation, and do not read an empty section as proof that the host has no matching data.

## The app cannot find OpenSSH

Control Room checks the Windows OpenSSH client in its standard location and then uses the available fallback. Install or enable the Windows OpenSSH Client, then restart Control Room so environment discovery runs again.
