locals {
  distro_catalog = {
    rocky = {
      os_id     = "rocky"
      systemd   = true
      memory_mb = 1536
    }
    ubuntu = {
      os_id     = "ubuntu"
      systemd   = true
      memory_mb = 1536
    }
    debian = {
      os_id     = "debian"
      systemd   = true
      memory_mb = 1536
    }
    alma = {
      os_id     = "almalinux"
      systemd   = true
      memory_mb = 1536
    }
    rhel = {
      os_id     = "rhel"
      systemd   = true
      memory_mb = 1536
    }
    fedora = {
      os_id     = "fedora"
      systemd   = true
      memory_mb = 1536
    }
    centos-stream = {
      os_id     = "centos"
      systemd   = true
      memory_mb = 1536
    }
    oracle = {
      os_id     = "ol"
      systemd   = true
      memory_mb = 1536
    }
    amazon-linux = {
      os_id     = "amzn"
      systemd   = true
      memory_mb = 1536
    }
    opensuse-leap = {
      os_id     = "opensuse-leap"
      systemd   = true
      memory_mb = 1536
    }
    sles = {
      os_id     = "sles"
      systemd   = true
      memory_mb = 1536
    }
    arch = {
      os_id     = "arch"
      systemd   = true
      memory_mb = 1536
    }
    alpine = {
      os_id     = "alpine"
      systemd   = false
      memory_mb = 768
    }
  }

  selected       = local.distro_catalog[var.distro]
  template_vm_id = lookup(var.template_vm_ids, var.distro, null)
  memory_mb      = coalesce(var.memory_mb, local.selected.memory_mb)
  target_ip      = split("/", var.ipv4_cidr)[0]
}
