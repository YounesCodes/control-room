# Use existing OpenSSH identities in the first release

The first release will use identities already available to Windows OpenSSH through its default lookup or an explicit existing key path. It will not import, copy, or persist private keys. This fits the initial homelab environment, where Remote Hosts already trust the user's Windows key, and avoids creating a second private-key store before public distribution requires one.
