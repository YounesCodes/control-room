# Use system OpenSSH through ConPTY

Control Room will run the Windows `ssh.exe` client inside ConPTY instead of implementing SSH in Rust. This preserves the user's OpenSSH configuration, known hosts, agent support, identity formats, and interactive prompts while giving terminal applications the console behavior they expect. The initial backend will use `portable-pty` behind a local `PtyBackend` interface and will be retained only if it passes the real-host prompt, resize, high-output, and shutdown tests.
