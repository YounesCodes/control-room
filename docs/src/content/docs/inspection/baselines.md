---
title: Baselines
description: Capture normalized host facts on demand and compare them later.
---

A Host Baseline answers a practical question. Something on the server looks or behaves
differently, and you want to know what changed.

```text
Before changing your server
        ↓
Capture a baseline
        ↓
Upgrade or reconfigure something
        ↓
Something looks different
        ↓
Compare against the baseline
        ↓
See exactly which entries changed
```

A baseline is a capture you start yourself, for one Saved Connection. It stores normalized facts
rather than raw command output, so a comparison matches entries by identity instead of guessing
from text. A systemd unit is matched by its unit id, a container by its ID, a listener by address
and protocol, a filesystem by its mount point.

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

| Status      | Meaning                                                   |
| ----------- | --------------------------------------------------------- |
| Collected   | The section returned its normalized facts.                |
| Partial     | The section returned facts but hit a bound or limitation. |
| Unsupported | The host does not provide that kind of inspection.        |
| Unavailable | The read failed or permission prevented it.               |
| Skipped     | You stopped before the section ran or did not select it.  |

Control Room never treats a section it did not read as unchanged.

## Compare

Compare a saved baseline with another saved baseline or with a live machine read. A live comparison is an explicit read that is thrown away after the comparison. It does not create a new capture.

Comparisons report additions, removals, changed values, and unchanged entries. Entries use domain identities such as systemd unit id, container identity, listener address and protocol, or filesystem mount point. The comparison does not guess why a value changed.

Host identity evidence tells you whether two captures appear to come from the same machine. Different identity, unknown identity, incompatible section schemas, and a live target are shown as separate facts.

## Manage saved baselines

Rename, pin, inspect, compare, export, or delete a baseline from the Baselines view. Control Room keeps up to 20 unpinned baselines per Saved Connection. Pinned baselines survive that routine retention limit.

Related: [Security](/control-room/reference/security/#stored-locally) lists what Control Room stores locally, baselines included.
