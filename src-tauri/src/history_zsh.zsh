# Loaded only in an explicitly enabled interactive Control Room session.
if [[ $- != *i* || ${CONTROL_ROOM_SHELL_INTEGRATION:-0} != 1 || -n ${__CONTROL_ROOM_LOADED:-} ]]; then
  return
fi
__CONTROL_ROOM_LOADED=1
autoload -Uz add-zsh-hook
zmodload zsh/datetime 2>/dev/null || true

__control_room_b64() {
  printf '%s' "$1" | base64 | tr -d '\r\n'
}

__control_room_millis() {
  if [[ -n ${EPOCHREALTIME:-} ]]; then
    printf '%.0f' "$(( EPOCHREALTIME * 1000 ))"
  else
    printf '%s000' "$(date +%s)"
  fi
}

__control_room_preexec() {
  printf '\033]633;ControlRoom;start;%s;%s;%s\007' \
    "$(__control_room_millis)" "$(__control_room_b64 "$PWD")" "$(__control_room_b64 "$1")"
  __control_room_command_active=1
}

__control_room_precmd() {
  local exit_code=$?
  if [[ ${__control_room_command_active:-0} == 1 ]]; then
    printf '\033]633;ControlRoom;finish;%s;%s;%s\007' \
      "$(__control_room_millis)" "$exit_code" "$(__control_room_b64 "$PWD")"
    __control_room_command_active=0
  fi
  return "$exit_code"
}

add-zsh-hook preexec __control_room_preexec
add-zsh-hook precmd __control_room_precmd
