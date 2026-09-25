terraform {
  required_version = ">= 1.9, < 2.0"

  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "0.112.0"
    }
  }
}
