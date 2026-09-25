#!/usr/bin/env bash
set -euo pipefail

lab_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd "$lab_dir/../.." && pwd)
terraform_dir="$lab_dir/terraform"
ansible_dir="$lab_dir/ansible"
env_file="$lab_dir/.lab.env"
ansible_image="control-room-ansible:2.19.11"

usage() {
  printf '%s\n' \
    "Usage: ./lab.sh up <distro>" \
    "       ./lab.sh provision" \
    "       ./lab.sh test" \
    "       ./lab.sh status" \
    "       ./lab.sh down"
}

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

terraform_output() {
  terraform -chdir="$terraform_dir" output -json "$1" >/dev/null 2>&1 || return 1
  terraform -chdir="$terraform_dir" output -raw "$1" 2>/dev/null
}

to_docker_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s\n' "$1"
  fi
}

resolve_private_key() {
  local key=${CONTROL_ROOM_LAB_SSH_KEY:-"$HOME/.ssh/id_ed25519"}
  if [[ "$key" =~ ^[A-Za-z]:\\ ]]; then
    command -v cygpath >/dev/null 2>&1 || fail "use a POSIX private-key path on this controller"
    key=$(cygpath -u "$key")
  elif [[ "$key" != /* ]]; then
    key="$PWD/$key"
  fi
  [[ -f "$key" ]] || fail "SSH private key not found at $key"
  printf '%s\n' "$key"
}

upload_alpine_snippet() {
  local key
  local password_hash
  local public_key
  local proxmox_target=${CONTROL_ROOM_LAB_PROXMOX_SSH_TARGET:-root@192.168.100.200}

  key=$(resolve_private_key)
  public_key=${CONTROL_ROOM_LAB_SSH_PUBLIC_KEY:-"$key.pub"}
  [[ -f "$public_key" ]] || fail "SSH public key not found at $public_key"
  command -v openssl >/dev/null 2>&1 || fail "OpenSSL is required to prepare Alpine cloud-init data"
  password_hash=$(openssl passwd -6 "$(openssl rand -base64 32)")

  {
    printf '%s\n' \
      '#cloud-config' \
      'users:' \
      '  - name: controlroom' \
      '    groups: [wheel]' \
      '    shell: /bin/ash' \
      '    lock_passwd: false' \
      '    sudo: ALL=(ALL) NOPASSWD:ALL' \
      '    ssh_authorized_keys:'
    printf '      - %s\n' "$(tr -d '\r\n' <"$public_key")"
    printf "    hashed_passwd: '%s'\n" "$password_hash"
    printf '%s\n' \
      'ssh_pwauth: false' \
      'disable_root: true'
  } | ssh -i "$key" "$proxmox_target" \
    'install -m 600 /dev/stdin /var/lib/vz/snippets/control-room-alpine-user-data.yaml'
}

require_terraform() {
  [[ -f "$terraform_dir/terraform.tfvars" ]] || fail "copy terraform.tfvars.example to terraform.tfvars and edit it"
  [[ -n "${TF_VAR_proxmox_api_token:-}" ]] || fail "set TF_VAR_proxmox_api_token without writing it to disk"
  command -v terraform >/dev/null 2>&1 || fail "terraform is not installed"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || fail "Docker is required to run the pinned Ansible controller"
}

write_test_environment() {
  local distro=$1
  local ip=$2
  local user=$3
  local os_id=$4
  local key=$5
  local identity_path=$key

  if command -v cygpath >/dev/null 2>&1; then
    identity_path=$(cygpath -w "$key")
  fi

  {
    printf 'export CONTROL_ROOM_TEST_HOST=%q\n' "$ip"
    printf 'export CONTROL_ROOM_TEST_USER=%q\n' "$user"
    printf 'export CONTROL_ROOM_TEST_PORT=22\n'
    printf 'export CONTROL_ROOM_TEST_OS_ID=%q\n' "$os_id"
    printf 'export CONTROL_ROOM_TEST_EXPECT_PORTS=true\n'
    printf 'export CONTROL_ROOM_TEST_IDENTITY_FILE=%q\n' "$identity_path"
    printf 'export CONTROL_ROOM_LAB_DISTRO=%q\n' "$distro"
  } >"$env_file"
}

refresh_test_host_key() {
  local host=$1
  local known_hosts="$HOME/.ssh/known_hosts"
  local scanned_keys

  command -v ssh-keygen >/dev/null 2>&1 || fail "ssh-keygen is required for the rotating lab host key"
  command -v ssh-keyscan >/dev/null 2>&1 || fail "ssh-keyscan is required for the rotating lab host key"

  mkdir -p -- "$(dirname "$known_hosts")"
  touch "$known_hosts"
  ssh-keygen -R "$host" -f "$known_hosts" >/dev/null 2>&1 || true
  ssh-keygen -R "[$host]:22" -f "$known_hosts" >/dev/null 2>&1 || true
  scanned_keys=$(ssh-keyscan -T 10 -p 22 "$host" 2>/dev/null) || fail "could not read the lab VM host key"
  [[ -n "$scanned_keys" ]] || fail "the lab VM returned no SSH host key"
  printf '%s\n' "$scanned_keys" >>"$known_hosts"
}

run_ansible() {
  local distro=$1
  local ip=$2
  local user=$3
  local key=$4
  local repo_mount
  local ansible_mount
  local key_mount

  repo_mount=$(to_docker_path "$repo_dir")
  ansible_mount=$(to_docker_path "$ansible_dir")
  key_mount=$(to_docker_path "$key")

  MSYS_NO_PATHCONV=1 docker build --quiet --tag "$ansible_image" "$ansible_mount" >/dev/null
  MSYS_NO_PATHCONV=1 docker run --rm \
    --volume "$repo_mount:/workspace:ro" \
    --volume "$key_mount:/run/secrets/control-room-lab-key:ro" \
    --workdir /workspace/infra/proxmox-distro-lab/ansible \
    --env ANSIBLE_CONFIG=/workspace/infra/proxmox-distro-lab/ansible/ansible.cfg \
    --env ANSIBLE_HOST_KEY_CHECKING=False \
    "$ansible_image" \
    --inventory "$ip," \
    --user "$user" \
    --private-key /tmp/control-room-lab-key \
    --extra-vars "control_room_distro=$distro" \
    --extra-vars "control_room_dns_server=${CONTROL_ROOM_LAB_DNS_SERVER:-192.168.100.1}" \
    --extra-vars "control_room_install_docker=${LAB_INSTALL_DOCKER:-false}" \
    playbook.yml
}

provision_current() {
  local key
  local distro
  local ip
  local user
  local os_id

  key=$(resolve_private_key)
  distro=$(terraform_output distro) || fail "no active lab VM"
  ip=$(terraform_output target_ip)
  user=$(terraform_output ssh_username)
  os_id=$(terraform_output expected_os_id)

  run_ansible "$distro" "$ip" "$user" "$key"
  refresh_test_host_key "$ip"
  write_test_environment "$distro" "$ip" "$user" "$os_id" "$key"
  printf 'Prepared %s at %s. Test variables are in %s.\n' "$distro" "$ip" "$env_file"
}

command=${1:-}
case "$command" in
  up)
    distro=${2:-}
    [[ -n "$distro" ]] || fail "up requires a distribution key"
    require_terraform
    require_docker
    terraform -chdir="$terraform_dir" init

    if [[ "$distro" == "alpine" ]]; then
      upload_alpine_snippet
    fi

    if current=$(terraform_output distro); then
      if [[ "$current" != "$distro" ]]; then
        fail "$current is still active; run ./lab.sh down before provisioning $distro"
      fi
    fi

    terraform -chdir="$terraform_dir" apply -auto-approve -var="distro=$distro"
    provision_current
    ;;
  provision)
    require_terraform
    require_docker
    provision_current
    ;;
  test)
    [[ -f "$env_file" ]] || fail "run ./lab.sh up first"
    # shellcheck disable=SC1090
    source "$env_file"
    cargo test --locked \
      --manifest-path "$repo_dir/src-tauri/Cargo.toml" \
      remote::tests::live_fixture_supports_structured_features \
      -- --ignored --exact --nocapture
    ;;
  status)
    if distro=$(terraform_output distro); then
      printf 'Distribution: %s\n' "$distro"
      printf 'VM ID: %s\n' "$(terraform_output vm_id)"
      printf 'Address: %s\n' "$(terraform_output target_ip)"
      printf 'Memory: %s MiB\n' "$(terraform_output memory_mb)"
    else
      printf 'No lab VM is recorded in Terraform state.\n'
    fi
    ;;
  down)
    require_terraform
    distro=$(terraform_output distro) || fail "no active lab VM"
    terraform -chdir="$terraform_dir" destroy -auto-approve -var="distro=$distro"
    rm -f -- "$env_file"
    printf 'Destroyed the %s lab VM. Its template was not changed.\n' "$distro"
    ;;
  *)
    usage
    exit 1
    ;;
esac
