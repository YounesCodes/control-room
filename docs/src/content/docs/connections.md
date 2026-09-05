---
title: Connections
description: Save, test, group, tag, and remove SSH destinations.
---

A **Saved Connection** is a local record containing an SSH destination and username, with optional port and identity-file overrides. It is the reusable target for remote Workspaces and structured inspections.

## Create or edit a connection

The connection editor accepts:

| Field | Details |
| --- | --- |
| Display name | Required in the UI, up to 80 characters. This is the name shown in the rail and Workspace tabs. |
| SSH destination | Required, up to 255 characters. It is passed to OpenSSH as the destination after validation. |
| Username | Required, up to 64 characters. |
| Port | Optional, from 1 to 65535. |
| Identity file | Optional path to an existing private key. Control Room never copies the file. |
| Group | One local Connection Group, or derived Ungrouped. |
| Tags | Existing local tags for filtering and organization. |
| Sudo allowance | Optional per-host permission for passwordless sudo reads. |

Use **Test structured access** before saving when you want to confirm that noninteractive SSH can reach the host. The test does not create a Saved Connection.

## Groups and tags

Groups are local, manually ordered sections in the connection rail. A Saved Connection belongs to at most one group. Deleting a group returns its connections to Ungrouped and does not contact the Remote Host.

Tags are local metadata used for filtering. They do not grant permissions and do not trigger an operation.

The rail search matches connection names, SSH targets, group names, and tags. Group collapse state and ordering stay on this Windows installation.

## Remove a connection

Removing a Saved Connection also removes its remote Workspaces, Enhanced History, and stored Host Baselines for that connection. It does not close or change local terminal Workspaces.

## SSH configuration

Control Room uses the Windows OpenSSH client and can display the detected client path, the `%USERPROFILE%\.ssh\config` path, and whether `ssh-agent` has an available identity. OpenSSH still owns its normal configuration and authentication behavior.
