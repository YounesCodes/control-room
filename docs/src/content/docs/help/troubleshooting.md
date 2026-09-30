---
title: Troubleshooting
description: Fix common SSH, inspection, Docker, and local shell problems.
---

**The terminal connects, but host views fail.** Open **Edit connection** and run **Test structured access**. The views need SSH access without a password prompt. A terminal password login can still work. Set up an SSH key or agent if you want the views.

**A view needs permission.** Some Docker, port, firewall, and boot reads need more access. Allow passwordless sudo for that host or use the one-time retry offered by the view. The view marks missing information instead of showing it as zero.

**Docker is unavailable.** Check Docker in Overview. The daemon may be missing or your account may lack access. Containers with incomplete Compose labels appear under **Ungrouped**.

**A local shell is missing.** Install the shell, then check **Settings → Local terminal**. Use **Show all** if you hid it earlier. Git Bash means Git for Windows, not the Windows WSL launcher.

**A tab did not connect after restart.** The app starts fresh sessions for restored tabs. If a start fails, read the error, then use **Reconnect** for SSH or **Restart** for a local shell to try again.

**A view shows partial results.** A command may be unavailable, access may be limited, or a result may have reached its size limit. The view labels that condition. Use the terminal if you need a broader check.

**The window shows an error.** Read the message and select **Reload**. This restarts the app session; saved connections, settings, notes, and baselines stay on disk.

**OpenSSH is missing.** Install or enable the Windows OpenSSH Client, then restart Control Room.
