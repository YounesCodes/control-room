---
title: Boot diagnostics
description: Inspect bounded evidence for the current or a recent Linux boot.
---

A server reboots more slowly than usual, or a service fails after a restart, and you want the
boot evidence in one place. Boot Diagnostics gathers it on demand: it lists up to ten boots
reported by journald, then lets you select the current boot or one of the recent previous boots.

## Sections

The current boot can provide:

- boot id and time range
- total boot time, kernel time, and userspace time
- up to 20 slow-unit observations from `systemd-analyze blame`
- current failed system-scope units
- up to 30 warning-through-alert journal entries

Each section has its own collection time and availability state. A permission error in one section does not erase the sections that finished.

## Current and previous boots

Timing and slow-unit data describe the current boot. The failed-unit list is system scope. When you select an older boot, the journal navigation makes clear that the live journal read is current-only rather than pretending that old-boot evidence was loaded.

## Read the result carefully

Boot Diagnostics is bounded evidence, not a causal report. A slow unit is not declared the cause of a problem. A missing, unsupported, or permission-limited section stays distinct from an empty section. Boot evidence is held in Workspace memory and is not saved as a baseline or database record.
