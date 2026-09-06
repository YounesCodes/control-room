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
            sudo_enabled: false,
            group_id: None,
            tags: Vec::new(),
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

    /// Runs a wrapper around the real scripts under Git Bash, which is one of
    /// the shells Control Room hosts and so is resolved the way the app
    /// resolves it. The scripts only ever run on a Remote Host, but they are
    /// ordinary POSIX shell and their behaviour does not depend on which
    /// machine the shell is on.
    fn run_under_bash(script: &str) -> std::process::Output {
        use std::io::Write;

        let bash = crate::local_shell::resolve_installed("git-bash")
            .expect("Git Bash is required to exercise the shell integration scripts");
        let mut child = crate::ssh::background_command(bash.program())
            .args(["--noprofile", "--norc", "-s"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("Git Bash could not be started");
        child
            .stdin
            .take()
            .expect("stdin")
            .write_all(script.as_bytes())
            .expect("the script could not be written");
        child.wait_with_output().expect("Git Bash did not finish")
    }

    /// Reads the `key=value` lines the wrapper prints, so a scenario reports
    /// what it observed instead of the test parsing shell output by position.
    fn observations(output: &std::process::Output) -> std::collections::HashMap<String, String> {
        assert!(
            output.status.success(),
            "the wrapper failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.split_once('='))
            .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
            .collect()
    }

    /// A `.bashrc` is the user's own file, and Control Room writes into it.
    /// Installing twice must not leave two copies of the block, uninstalling
    /// must take exactly the block and nothing around it, and uninstalling
    /// something that is not installed has to succeed rather than fail.
    ///
    /// The source-text guard beside this says the markers exist. It cannot say
    /// what running the script does to a file that already has content in it.
    #[test]
    #[cfg(windows)]
    fn installing_history_twice_leaves_one_reversible_block() {
        let script = format!(
            r##"set -eu
root="$(mktemp -d)"
export HOME="$root"
printf 'export EDITOR=vim\n# a comment of my own\nalias ll="ls -la"\n' > "$HOME/.bashrc"
before_nonblank="$(grep -cve '^[[:space:]]*$' "$HOME/.bashrc" || true)"

( {INSTALL_SCRIPT} ) > /dev/null
( {INSTALL_SCRIPT} ) > /dev/null

printf 'start_markers=%s\n' "$(grep -Fxc '# >>> Control Room shell integration >>>' "$HOME/.bashrc" || true)"
printf 'end_markers=%s\n' "$(grep -Fxc '# <<< Control Room shell integration <<<' "$HOME/.bashrc" || true)"
printf 'integration_file=%s\n' "$(test -r "$HOME/.local/share/control-room/shell-integration.bash" && echo 1 || echo 0)"
printf 'history_file_read=%s\n' "$(test -e "$HOME/.bash_history" && echo 1 || echo 0)"

( {UNINSTALL_SCRIPT} ) > /dev/null

printf 'after_start_markers=%s\n' "$(grep -Fxc '# >>> Control Room shell integration >>>' "$HOME/.bashrc" || true)"
printf 'after_editor=%s\n' "$(grep -Fxc 'export EDITOR=vim' "$HOME/.bashrc" || true)"
printf 'after_comment=%s\n' "$(grep -Fxc '# a comment of my own' "$HOME/.bashrc" || true)"
printf 'after_alias=%s\n' "$(grep -Fxc 'alias ll="ls -la"' "$HOME/.bashrc" || true)"
printf 'after_nonblank=%s\n' "$(grep -cve '^[[:space:]]*$' "$HOME/.bashrc" || true)"
printf 'before_nonblank=%s\n' "$before_nonblank"
printf 'after_control_room=%s\n' "$(grep -Fic 'control room' "$HOME/.bashrc" || true)"
printf 'after_control_room_path=%s\n' "$(grep -Fc 'control-room' "$HOME/.bashrc" || true)"
printf 'after_integration_file=%s\n' "$(test -e "$HOME/.local/share/control-room/shell-integration.bash" && echo 1 || echo 0)"

# Removing what is already gone is what a user who never installed it does.
( {UNINSTALL_SCRIPT} ) > /dev/null
printf 'second_uninstall=ok\n'

rm -rf "$root"
"##
        );

        let found = observations(&run_under_bash(&script));

        assert_eq!(found.get("start_markers").map(String::as_str), Some("1"));
        assert_eq!(found.get("end_markers").map(String::as_str), Some("1"));
        assert_eq!(found.get("integration_file").map(String::as_str), Some("1"));
        assert_eq!(
            found.get("history_file_read").map(String::as_str),
            Some("0"),
            "Enhanced History records what the integration reports, and never \
             reads the host's own shell history"
        );

        assert_eq!(
            found.get("after_start_markers").map(String::as_str),
            Some("0")
        );
        assert_eq!(
            found.get("after_integration_file").map(String::as_str),
            Some("0")
        );
        for line in ["after_editor", "after_comment", "after_alias"] {
            assert_eq!(
                found.get(line).map(String::as_str),
                Some("1"),
                "{line}: uninstall took something that was not its own"
            );
        }
        // The block is appended after a blank line, and uninstall removes the
        // marked lines rather than the separator, so the file can keep a blank
        // line it did not start with. Everything with content in it is back to
        // what it was, and nothing of Control Room's is left.
        assert_eq!(
            found.get("after_nonblank"),
            found.get("before_nonblank"),
            "a line with content in it was added or lost"
        );
        assert_eq!(
            found.get("after_control_room").map(String::as_str),
            Some("0")
        );
        assert_eq!(
            found.get("after_control_room_path").map(String::as_str),
            Some("0")
        );
        assert_eq!(
            found.get("second_uninstall").map(String::as_str),
            Some("ok")
        );
    }

    /// Markers a user half-deleted, or duplicated by an older bug, mean the
    /// script cannot tell which lines are its own. Editing anyway would take
    /// somebody's shell configuration with it, so both scripts refuse and say
    /// so, and leave the file exactly as they found it.
    #[test]
    #[cfg(windows)]
    fn damaged_markers_stop_both_scripts_before_they_edit_anything() {
        for (name, bashrc) in [
            (
                "an opening marker with no closing one",
                "export EDITOR=vim\n# >>> Control Room shell integration >>>\n",
            ),
            (
                "a closing marker with no opening one",
                "export EDITOR=vim\n# <<< Control Room shell integration <<<\n",
            ),
            (
                "the block written twice",
                "# >>> Control Room shell integration >>>\n\
                 # <<< Control Room shell integration <<<\n\
                 # >>> Control Room shell integration >>>\n\
                 # <<< Control Room shell integration <<<\n",
            ),
        ] {
            for (action, body) in [("install", INSTALL_SCRIPT), ("uninstall", UNINSTALL_SCRIPT)] {
                let script = format!(
                    r##"set -eu
root="$(mktemp -d)"
export HOME="$root"
printf '%s' '{bashrc}' > "$HOME/.bashrc"
digest_before="$(cksum < "$HOME/.bashrc")"
status=0
( {body} ) > /dev/null 2> "$root/stderr" || status=$?
printf 'status=%s\n' "$status"
printf 'unchanged=%s\n' "$(test "$digest_before" = "$(cksum < "$HOME/.bashrc")" && echo 1 || echo 0)"
printf 'explained=%s\n' "$(grep -Fc 'incomplete or duplicated' "$root/stderr" || true)"
rm -rf "$root"
"##
                );

                let found = observations(&run_under_bash(&script));
                assert_eq!(
                    found.get("status").map(String::as_str),
                    Some("2"),
                    "{action} with {name} should refuse"
                );
                assert_eq!(
                    found.get("unchanged").map(String::as_str),
                    Some("1"),
                    "{action} with {name} edited the file anyway"
                );
                assert_eq!(
                    found.get("explained").map(String::as_str),
                    Some("1"),
                    "{action} with {name} refused without saying why"
                );
            }
        }
    }

    /// The integration only loads for a session Control Room started with the
    /// flag set. Sourcing it in an ordinary interactive shell has to be a
    /// no-op, or opting in on one host would follow the user into every shell
    /// on that machine.
    #[test]
    #[cfg(windows)]
    fn the_integration_stays_inert_in_a_shell_control_room_did_not_start() {
        let script = format!(
            r##"set -eu
root="$(mktemp -d)"
export HOME="$root"
touch "$HOME/.bashrc"
( {INSTALL_SCRIPT} ) > /dev/null
integration="$HOME/.local/share/control-room/shell-integration.bash"

# Not an interactive shell, and no opt-in.
unset CONTROL_ROOM_SHELL_INTEGRATION
loaded=$( . "$integration"; printf '%s' "${{__CONTROL_ROOM_LOADED:-0}}" )
printf 'without_optin=%s\n' "$loaded"

# Opted in, but this shell is still not interactive, which is what a
# Structured Operation's own ssh invocation looks like.
loaded=$( CONTROL_ROOM_SHELL_INTEGRATION=1; . "$integration"; printf '%s' "${{__CONTROL_ROOM_LOADED:-0}}" )
printf 'noninteractive=%s\n' "$loaded"

rm -rf "$root"
"##
        );

        let found = observations(&run_under_bash(&script));
        assert_eq!(found.get("without_optin").map(String::as_str), Some("0"));
        assert_eq!(found.get("noninteractive").map(String::as_str), Some("0"));
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
