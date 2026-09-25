output "distro" {
  value = var.distro
}

output "expected_os_id" {
  value = local.selected.os_id
}

output "expected_systemd" {
  value = local.selected.systemd
}

output "target_ip" {
  value = local.target_ip
}

output "ssh_username" {
  value = var.ssh_username
}

output "vm_id" {
  value = proxmox_virtual_environment_vm.target.vm_id
}

output "memory_mb" {
  value = local.memory_mb
}

output "cpu_type" {
  value = var.cpu_type
}
