# Control Room

Control Room is a local Windows desktop tool for opening and inspecting Linux systems through SSH. This glossary separates saved connection details, remote machines, and the processes that interact with them.

## Language

**Saved Connection**:
A reusable set of details that tells OpenSSH how to reach a remote destination. It contains an SSH destination and username, and may contain explicit port or identity overrides.
_Avoid_: Host record, server entry, connection profile

**Remote Host**:
The Linux system reached through a Saved Connection. More than one Saved Connection may refer to the same Remote Host.
_Avoid_: Saved host, connection

**Workspace**:
An open view of one Saved Connection that groups a Terminal Session with inspection features for its Remote Host. A Saved Connection may have multiple Workspaces.
_Avoid_: Host tab, session

**Terminal Session**:
One interactive SSH shell inside a Workspace. Its connection state belongs to the session, not to the Saved Connection or Remote Host.
_Avoid_: Connection, host session

**Structured Operation**:
A bounded, read-only inspection request such as discovering host details or listing services. It runs independently of Terminal Sessions and uses a backend-defined command.
_Avoid_: Background command, arbitrary command

**Log Stream**:
A live journald or Docker log reader with its own lifecycle. It is independent of Terminal Sessions and other Log Streams.
_Avoid_: Terminal stream, session stream

**Enhanced History**:
A local record of commands reported by Control Room's explicitly installed Bash integration. It contains commands executed in integrated Terminal Sessions and does not import a Remote Host's existing shell history.
_Avoid_: Terminal history, Bash history, scrollback
