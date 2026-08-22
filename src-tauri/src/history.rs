use crate::{models::SavedConnection, remote::RemoteCommandExecutor};

const INSTALL_SCRIPT: &str = r##"set -eu
integration_dir="$HOME/.local/share/control-room"
integration_file="$integration_dir/shell-integration.bash"
bashrc="$HOME/.bashrc"
mkdir -p "$integration_dir"
chmod 700 "$integration_dir"
touch "$bashrc"
start_count="$(grep -Fxc '# >>> Control Room shell integration >>>' "$bashrc" 2>/dev/null || true)"
end_count="$(grep -Fxc '# <<< Control Room shell integration <<<' "$bashrc" 2>/dev/null || true)"
if { test "$start_count" -ne 0 || test "$end_count" -ne 0; } && { test "$start_count" -ne 1 || test "$end_count" -ne 1; }; then
  printf 'Control Room markers in .bashrc are incomplete or duplicated; no changes were made\n' >&2
  exit 2
fi
integration_temporary="$(mktemp "$integration_dir/.shell-integration.XXXXXX")"
bashrc_temporary=""
trap 'rm -f "$integration_temporary" "$bashrc_temporary"' EXIT
cat > "$integration_temporary" <<'CONTROL_ROOM_INTEGRATION'
# Control Room Bash integration. Loaded only by an explicitly enabled Control Room session.
if [[ $- != *i* || ${CONTROL_ROOM_SHELL_INTEGRATION:-0} != 1 || -n ${__CONTROL_ROOM_LOADED:-} ]]; then
  return
fi
__CONTROL_ROOM_LOADED=1

__control_room_b64() {
  printf '%s' "$1" | base64 | tr -d '\r\n'
}

__control_room_emit() {
  printf '\033]633;ControlRoom;%s\007' "$1"
}

__control_room_preexec() {
  local command cwd started
  command="$(fc -ln -1 2>/dev/null)" || command="$BASH_COMMAND"
  command="${command#$'\t'}"
  command="${command# }"
  [[ -n ${command//[[:space:]]/} ]] || return
  cwd="$PWD"
  started="$(date +%s%3N)"
  __control_room_emit "start;$started;$(__control_room_b64 "$cwd");$(__control_room_b64 "$command")"
  __control_room_command_active=1
  __control_room_ready=0
}

__control_room_precmd() {
  local exit_code=$?
  local finished cwd
  __control_room_in_prompt=1
  if [[ ${__control_room_command_active:-0} == 1 ]]; then
    finished="$(date +%s%3N)"
    cwd="$PWD"
    __control_room_emit "finish;$finished;$exit_code;$(__control_room_b64 "$cwd")"
    __control_room_command_active=0
  fi
  return "$exit_code"
}

__control_room_prompt_complete() {
  __control_room_in_prompt=0
  __control_room_ready=1
}

__control_room_previous_debug_handler=""
__control_room_debug_spec="$(trap -p DEBUG)"
if [[ -n $__control_room_debug_spec ]]; then
  __control_room_debug_literal="${__control_room_debug_spec#trap -- }"
  __control_room_debug_literal="${__control_room_debug_literal% DEBUG}"
  eval "__control_room_previous_debug_handler=$__control_room_debug_literal"
fi

__control_room_debug() {
  local previous_status=$?
  if [[ -n $__control_room_previous_debug_handler ]]; then
    eval "$__control_room_previous_debug_handler"
  fi
  if [[ ${__control_room_ready:-0} == 1 && ${__control_room_in_prompt:-0} == 0 ]]; then
    __control_room_preexec
  fi
  return "$previous_status"
}

__control_room_ready=0
__control_room_in_prompt=0
__control_room_command_active=0
trap '__control_room_debug' DEBUG
if declare -p PROMPT_COMMAND 2>/dev/null | grep -q '^declare -a'; then
  PROMPT_COMMAND=(__control_room_precmd "${PROMPT_COMMAND[@]}" __control_room_prompt_complete)
else
  __control_room_previous_prompt_command="${PROMPT_COMMAND-}"
  PROMPT_COMMAND=(__control_room_precmd)
  if [[ -n $__control_room_previous_prompt_command ]]; then
    PROMPT_COMMAND+=("$__control_room_previous_prompt_command")
  fi
  PROMPT_COMMAND+=(__control_room_prompt_complete)
fi
CONTROL_ROOM_INTEGRATION
chmod 600 "$integration_temporary"
mv -f "$integration_temporary" "$integration_file"
integration_temporary=""
if test "$start_count" -eq 0; then
  bashrc_temporary="$(mktemp "$HOME/.bashrc.control-room.XXXXXX")"
  cp -p "$bashrc" "$bashrc_temporary"
  cat >> "$bashrc_temporary" <<'CONTROL_ROOM_BASHRC'

# >>> Control Room shell integration >>>
if [[ $- == *i* && ${CONTROL_ROOM_SHELL_INTEGRATION:-0} == 1 && -r "$HOME/.local/share/control-room/shell-integration.bash" ]]; then
  source "$HOME/.local/share/control-room/shell-integration.bash"
fi
# <<< Control Room shell integration <<<
CONTROL_ROOM_BASHRC
  mv -f "$bashrc_temporary" "$bashrc"
  bashrc_temporary=""
fi
trap - EXIT
printf 'installed\n'
"##;

const UNINSTALL_SCRIPT: &str = r##"set -eu
bashrc="$HOME/.bashrc"
if test -f "$bashrc"; then
  start_count="$(grep -Fxc '# >>> Control Room shell integration >>>' "$bashrc" 2>/dev/null || true)"
  end_count="$(grep -Fxc '# <<< Control Room shell integration <<<' "$bashrc" 2>/dev/null || true)"
  if { test "$start_count" -ne 0 || test "$end_count" -ne 0; } && { test "$start_count" -ne 1 || test "$end_count" -ne 1; }; then
    printf 'Control Room markers in .bashrc are incomplete or duplicated; no changes were made\n' >&2
    exit 2
  fi
fi
if test -f "$bashrc" && test "$start_count" -eq 1; then
  temporary="$(mktemp "$HOME/.bashrc.control-room.XXXXXX")"
  trap 'rm -f "$temporary"' EXIT
  cp -p "$bashrc" "$temporary"
  awk '
    $0 == "# >>> Control Room shell integration >>>" { skipping=1; next }
    $0 == "# <<< Control Room shell integration <<<" { skipping=0; next }
    !skipping { print }
  ' "$bashrc" > "$temporary"
  mv -f "$temporary" "$bashrc"
  trap - EXIT
fi
rm -f "$HOME/.local/share/control-room/shell-integration.bash"
rmdir "$HOME/.local/share/control-room" 2>/dev/null || true
printf 'removed\n'
"##;

pub fn integration_status(connection: &SavedConnection) -> Result<bool, String> {
    let output = RemoteCommandExecutor::execute(
        connection,
        "history_status",
        r#"bashrc="$HOME/.bashrc"; file=0; test -r "$HOME/.local/share/control-room/shell-integration.bash" && file=1; start=0; end=0; if test -f "$bashrc"; then start="$(grep -Fxc '# >>> Control Room shell integration >>>' "$bashrc" 2>/dev/null || true)"; end="$(grep -Fxc '# <<< Control Room shell integration <<<' "$bashrc" 2>/dev/null || true)"; fi; if test "$file" -eq 1 && test "$start" -eq 1 && test "$end" -eq 1; then exit 0; fi; if test "$file" -eq 0 && test "$start" -eq 0 && test "$end" -eq 0; then exit 1; fi; exit 2"#,
    )?;
    match output.exit_code {
        0 => Ok(true),
        1 => Ok(false),
        _ => Err(
            "Enhanced History integration is incomplete or has duplicate .bashrc markers".into(),
        ),
    }
}

pub fn install_integration(connection: &SavedConnection) -> Result<(), String> {
    let output = RemoteCommandExecutor::execute_with_input(
        connection,
        "history_install",
        "bash -s",
        INSTALL_SCRIPT.as_bytes(),
    )?;
    if output.exit_code == 0 {
        Ok(())
    } else {
        Err(format!(
            "History integration installation failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

pub fn uninstall_integration(connection: &SavedConnection) -> Result<(), String> {
    let output = RemoteCommandExecutor::execute_with_input(
        connection,
        "history_uninstall",
        "bash -s",
        UNINSTALL_SCRIPT.as_bytes(),
    )?;
    if output.exit_code == 0 {
        Ok(())
    } else {
        Err(format!(
            "History integration removal failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live_connection() -> SavedConnection {
        SavedConnection {
            id: "live-history-fixture".into(),
            display_name: "Debian laptop".into(),
            destination: std::env::var("CONTROL_ROOM_TEST_HOST")
                .expect("CONTROL_ROOM_TEST_HOST is required"),
            username: std::env::var("CONTROL_ROOM_TEST_USER").ok(),
            port: std::env::var("CONTROL_ROOM_TEST_PORT")
                .ok()
                .and_then(|value| value.parse().ok()),
            identity_file: None,
            history_enabled: false,
            created_at: String::new(),
            updated_at: String::new(),
            last_connected_at: None,
        }
    }

    #[test]
    fn integration_is_opt_in_and_marker_bounded() {
        assert!(INSTALL_SCRIPT.contains("CONTROL_ROOM_SHELL_INTEGRATION"));
        assert!(INSTALL_SCRIPT.contains("# >>> Control Room shell integration >>>"));
        assert!(UNINSTALL_SCRIPT.contains("# <<< Control Room shell integration <<<"));
        assert!(!INSTALL_SCRIPT.contains(".bash_history"));
        assert!(INSTALL_SCRIPT.contains("mktemp \"$HOME/.bashrc.control-room.XXXXXX\""));
        assert!(INSTALL_SCRIPT.contains("cp -p \"$bashrc\" \"$bashrc_temporary\""));
        assert!(INSTALL_SCRIPT.contains("incomplete or duplicated"));
        assert!(UNINSTALL_SCRIPT.contains("incomplete or duplicated"));
    }

    #[test]
    #[ignore = "requires the explicitly configured Debian SSH fixture"]
    fn live_history_install_is_reversible_in_an_isolated_home() {
        let connection = live_connection();
        let script = format!(
            r#"set -eu
test_root="$(mktemp -d /tmp/control-room-history-test.XXXXXX)"
trap 'rm -rf "$test_root"' EXIT
export HOME="$test_root"
(
{INSTALL_SCRIPT}
)
test -r "$HOME/.local/share/control-room/shell-integration.bash"
grep -Fq '# >>> Control Room shell integration >>>' "$HOME/.bashrc"
CONTROL_ROOM_SHELL_INTEGRATION=1 bash --noprofile --rcfile "$HOME/.bashrc" -i <<'CONTROL_ROOM_COMMANDS'
printf CONTROL_ROOM_HISTORY_OK
false
exit 0
CONTROL_ROOM_COMMANDS
(
{UNINSTALL_SCRIPT}
)
test ! -e "$HOME/.local/share/control-room/shell-integration.bash"
! grep -Fq '# >>> Control Room shell integration >>>' "$HOME/.bashrc"
"#
        );
        let output = RemoteCommandExecutor::execute_with_input(
            &connection,
            "history_fixture",
            "bash -s",
            script.as_bytes(),
        )
        .unwrap();
        assert_eq!(
            output.exit_code,
            0,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        let transcript = format!("{stdout}\n{}", String::from_utf8_lossy(&output.stderr));
        assert!(stdout.contains("installed"));
        assert!(transcript.contains("CONTROL_ROOM_HISTORY_OK"));
        assert!(transcript.contains("\u{1b}]633;ControlRoom;start;"));
        assert!(transcript.contains("\u{1b}]633;ControlRoom;finish;"));
        let commands = transcript
            .split("\u{1b}]633;ControlRoom;start;")
            .skip(1)
            .filter_map(|marker| marker.split('\u{7}').next())
            .filter_map(|payload| payload.split(';').nth(2))
            .collect::<Vec<_>>();
        assert!(commands.contains(&"cHJpbnRmIENPTlRST0xfUk9PTV9ISVNUT1JZX09L"));
        assert!(commands.contains(&"ZmFsc2U="));
        let exit_codes = transcript
            .split("\u{1b}]633;ControlRoom;finish;")
            .skip(1)
            .filter_map(|marker| marker.split('\u{7}').next())
            .filter_map(|payload| payload.split(';').nth(1))
            .collect::<Vec<_>>();
        assert!(exit_codes.contains(&"0"));
        assert!(exit_codes.contains(&"1"));
        assert!(stdout.contains("removed"));
    }
}
