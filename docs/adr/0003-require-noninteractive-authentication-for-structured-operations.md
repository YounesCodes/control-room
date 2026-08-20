# Require noninteractive authentication for structured operations

Terminal Sessions may use interactive OpenSSH password and key-passphrase prompts. Structured Operations and Log Streams will require OpenSSH to authenticate noninteractively through configured keys or an agent because they run in separate SSH processes. Control Room will explain this requirement instead of storing SSH passwords or attempting to reuse credentials entered in a terminal.
