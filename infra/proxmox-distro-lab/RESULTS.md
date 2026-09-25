# Live distribution validation

- Last updated: 2026-09-17
- Control Room commit: `429686f9e4b935327f8c728a4f8baca4c42532c3`
- Proxmox VE: 9.2.0, pve-manager 9.2.18
- Disposable VM: 9800 at 192.168.100.240

Each passing row used a freshly cloned VM, passwordless read-only sudo where
needed, the systemd or OpenRC fixtures, the firewall and port fixtures, and the
Docker fixture. The ignored Rust live SSH test exercised capability discovery,
host resources, filesystems, firewall state, services, boot diagnostics, ports,
connections, and containers where the guest supported them.

| Target        | Image/release                   | Live SSH suite | Docker fixture | Notes                                                        |
| ------------- | ------------------------------- | -------------- | -------------- | ------------------------------------------------------------ |
| Rocky Linux   | 9.8                             | Pass           | Pass           | RHEL-compatible representative                               |
| Ubuntu        | 24.04                           | Pass           | Pass           | Debian family                                                |
| Debian        | 12                              | Pass           | Pass           | Debian family                                                |
| AlmaLinux     | 9.8                             | Pass           | Pass           | RHEL-compatible                                              |
| Fedora Server | 44 Server Edition               | Pass           | Pass           | Official Server Guest Generic qcow2; template 9015           |
| CentOS Stream | 9                               | Pass           | Pass           | RHEL-compatible                                              |
| Oracle Linux  | 9.8                             | Pass           | Pass           | RHEL-compatible                                              |
| Amazon Linux  | 2023                            | Pass           | Pass           | systemd/journald                                             |
| openSUSE Leap | 15.6                            | Pass           | Pass           | SUSE family representative                                   |
| Arch Linux    | rolling image tested 2026-09-17 | Pass           | Pass           | systemd/journald                                             |
| Alpine Linux  | 3.24                            | Pass           | Pass           | Portable panes and Docker; OpenRC boundary confirmed         |
| RHEL          | Not supplied                    | Blocked        | Blocked        | Requires a real Red Hat image and working repositories       |
| SLES          | Not supplied                    | Blocked        | Blocked        | Requires a real SUSE image and suitable modules/repositories |

Fedora Server used
`Fedora-Server-Guest-Generic-44-1.7.x86_64.qcow2`, SHA-256
`446c01f71e3c6cd3889af66fec927b8d1160b8e0744243d7861c2b8b2ddd3f0e`.
The first untouched clone exposed Fedora Initial Setup rather than cloud-init.
Template 9015 therefore adds cloud-init, disables the interactive first-boot
services, enables SSH and the guest agent, cleans machine identity and SSH host
keys, and boots with SELinux enforcing. A fresh clone completed cloud-init with
no errors; its degraded label contained only Proxmox's deprecated single-user
cloud-config warning.

The desktop UI depth checklist has not been run. The automated live suite proves
the Rust inspection paths and parsers, not rendering, navigation, selection,
stream-follow behavior, or baseline workflows in the packaged application.
