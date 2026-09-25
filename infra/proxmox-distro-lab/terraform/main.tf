resource "proxmox_virtual_environment_vm" "target" {
  name        = "${var.vm_name_prefix}-${var.distro}"
  description = "Disposable Control Room ${var.distro} inspection target. Managed by Terraform."
  tags        = ["control-room", "distro-test", var.distro]

  node_name = var.node_name
  vm_id     = var.vm_id

  started                              = true
  stop_on_destroy                      = true
  delete_unreferenced_disks_on_destroy = false

  clone {
    vm_id        = local.template_vm_id
    datastore_id = var.vm_datastore_id
    full         = var.full_clone
    retries      = 3
  }

  cpu {
    cores = var.cpu_cores
    type  = var.cpu_type
  }

  memory {
    dedicated = local.memory_mb
  }

  initialization {
    datastore_id      = var.cloud_init_datastore_id
    user_data_file_id = var.distro == "alpine" ? "${var.snippet_datastore_id}:snippets/control-room-alpine-user-data.yaml" : null
    upgrade           = false

    dns {
      servers = var.dns_servers
    }

    ip_config {
      ipv4 {
        address = var.ipv4_cidr
        gateway = var.gateway_ipv4
      }
    }

    dynamic "user_account" {
      for_each = var.distro == "alpine" ? [] : [1]

      content {
        keys     = [trimspace(file(pathexpand(var.ssh_public_key_file)))]
        username = var.ssh_username
      }
    }
  }

  network_device {
    bridge = var.bridge
    model  = "virtio"
  }

  lifecycle {
    precondition {
      condition     = local.template_vm_id != null
      error_message = "template_vm_ids does not contain the selected distribution key."
    }
  }
}
