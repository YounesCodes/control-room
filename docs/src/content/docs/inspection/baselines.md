---
title: Host baselines
description: Capture normalized host facts on demand and compare them later.
---

A Host Baseline is a user-requested capture of normalized facts for one Saved Connection. It gives you a deterministic record to compare later without saving raw command output.

## Capture sections

Before starting, choose any of:

- host identity and capabilities
- systemd units
- Docker containers
- listening ports
- filesystems

Capture runs one section at a time. The progress view shows the current section and lets you stop after the in-flight section returns. Finished sections remain in the baseline. The rest are marked skipped.

## Section status

Each section stores its own collection time, schema version, and one status:

| Status | Meaning |
| --- | --- |
| Collected | The section returned its normalized facts. |
| Partial | The section returned facts but hit a bound or limitation. |
| Unsupported | The host does not provide that kind of inspection. |
| Unavailable | The read failed or permission prevented it. |
| Skipped | You stopped before the section ran or did not select it. |

Control Room never treats a section it did not read as unchanged.

## Compare

Compare a saved baseline with another saved baseline or with a live machine read. A live comparison is an explicit read that is thrown away after the comparison. It does not create a new capture.

Comparisons report additions, removals, changed values, and unchanged entries. Entries use domain identities such as systemd unit id, container identity, listener address and protocol, or filesystem mount point. The comparison does not guess why a value changed.

Host identity evidence tells you whether two captures appear to come from the same machine. Different identity, unknown identity, incompatible section schemas, and a live target are shown as separate facts.

## Manage saved baselines

Rename, pin, inspect, compare, export, or delete a baseline from the Baselines view. Control Room keeps up to 20 unpinned baselines per Saved Connection. Pinned baselines survive that routine retention limit.
