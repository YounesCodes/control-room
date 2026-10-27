#!/usr/bin/env bash
set -euo pipefail

# The runner is disposable. Bind sshd only to loopback and use per-run keys.
fixture_dir="$(mktemp -d)"
sshd_pid=""
cleanup() {
  if [[ -n "$sshd_pid" ]]; then sudo kill "$sshd_pid" 2>/dev/null || true; fi
  rm -rf "$fixture_dir"
}
trap cleanup EXIT
chmod 755 "$fixture_dir"
ssh-keygen -q -t ed25519 -N '' -f "$fixture_dir/host_key"
ssh-keygen -q -t ed25519 -N '' -f "$fixture_dir/client_key"
cp "$fixture_dir/client_key.pub" "$fixture_dir/authorized_keys"
chmod 600 "$fixture_dir/authorized_keys"
mkdir -p "$fixture_dir/bin"
ln -s "$(command -v ssh)" "$fixture_dir/bin/ssh.exe"
export PATH="$fixture_dir/bin:$PATH"
export CONTROL_ROOM_TEST_HOST=127.0.0.1
export CONTROL_ROOM_TEST_USER="$(id -un)"
export CONTROL_ROOM_TEST_PORT=22345
export CONTROL_ROOM_TEST_OS_ID=ubuntu
export CONTROL_ROOM_TEST_SSH_CONFIG="$fixture_dir/ssh_config"
printf '[127.0.0.1]:22345 %s\n' "$(cat "$fixture_dir/host_key.pub")" > "$fixture_dir/known_hosts"
cat > "$CONTROL_ROOM_TEST_SSH_CONFIG" <<EOF
Host *
  IdentityFile "$fixture_dir/client_key"
  UserKnownHostsFile "$fixture_dir/known_hosts"
  StrictHostKeyChecking yes
  IdentitiesOnly yes
  BatchMode yes
EOF
cat > "$fixture_dir/sshd_config" <<EOF
Port 22345
ListenAddress 127.0.0.1
HostKey $fixture_dir/host_key
PidFile $fixture_dir/sshd.pid
AuthorizedKeysFile $fixture_dir/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
AllowUsers $CONTROL_ROOM_TEST_USER
StrictModes no
Subsystem sftp internal-sftp
EOF
sudo mkdir -p /run/sshd
sudo /usr/sbin/sshd -f "$fixture_dir/sshd_config" -E "$fixture_dir/sshd.log"
sshd_pid="$(cat "$fixture_dir/sshd.pid")"
ssh -F "$CONTROL_ROOM_TEST_SSH_CONFIG" -p "$CONTROL_ROOM_TEST_PORT" "$CONTROL_ROOM_TEST_USER@$CONTROL_ROOM_TEST_HOST" true

for test in \
  history::tests::live_history_install_is_reversible_in_an_isolated_home \
  remote::tests::live_fixture_supports_structured_features; do
  cargo test --locked --manifest-path src-tauri/Cargo.toml --lib "$test" -- --ignored --exact
done
