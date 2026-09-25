mock_provider "proxmox" {}

variables {
  proxmox_endpoint        = "https://192.0.2.10:8006/"
  proxmox_api_token       = "terraform@pve!test=not-a-real-token"
  node_name               = "pve"
  ipv4_cidr               = "192.0.2.20/24"
  gateway_ipv4            = "192.0.2.1"
  ssh_public_key_file     = "tests/test-key.pub"
  template_vm_ids         = { rocky = 9001, alpine = 9013 }
  proxmox_insecure        = true
  vm_datastore_id         = "local-lvm"
  cloud_init_datastore_id = "local-lvm"
}

run "rocky_uses_the_standard_single_guest_budget" {
  command = plan

  variables {
    distro = "rocky"
  }

  assert {
    condition     = output.expected_os_id == "rocky"
    error_message = "Rocky Linux must assert its real os-release ID."
  }

  assert {
    condition     = output.expected_systemd
    error_message = "Rocky Linux must use the systemd fixture path."
  }

  assert {
    condition     = output.memory_mb == 1536
    error_message = "The normal VM budget must remain 1536 MiB."
  }

  assert {
    condition     = output.cpu_type == "x86-64-v2-AES"
    error_message = "The VM CPU model must satisfy the RHEL 9 x86-64-v2 baseline."
  }
}

run "alpine_uses_the_reduced_memory_budget" {
  command = plan

  variables {
    distro = "alpine"
  }

  assert {
    condition     = output.expected_os_id == "alpine"
    error_message = "Alpine must assert its real os-release ID."
  }

  assert {
    condition     = !output.expected_systemd
    error_message = "Alpine must not use the systemd fixture path."
  }

  assert {
    condition     = output.memory_mb == 768
    error_message = "The Alpine VM budget must remain 768 MiB."
  }
}
