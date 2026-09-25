variable "proxmox_endpoint" {
  description = "Proxmox API endpoint, including port 8006."
  type        = string
}

variable "proxmox_api_token" {
  description = "Proxmox API token in user@realm!token=value form."
  type        = string
  sensitive   = true
}

variable "proxmox_insecure" {
  description = "Allow a self-signed Proxmox API certificate."
  type        = bool
  default     = false
}

variable "node_name" {
  description = "Proxmox node that will run the disposable VM."
  type        = string
}

variable "distro" {
  description = "Distribution key to provision."
  type        = string

  validation {
    condition = contains([
      "rocky",
      "ubuntu",
      "debian",
      "alma",
      "rhel",
      "fedora",
      "centos-stream",
      "oracle",
      "amazon-linux",
      "opensuse-leap",
      "sles",
      "arch",
      "alpine"
    ], var.distro)
    error_message = "Choose one of the documented distribution keys."
  }
}

variable "template_vm_ids" {
  description = "Map of distribution keys to cloud-init template VM IDs. Only the selected key is required."
  type        = map(number)
}

variable "vm_id" {
  description = "VM ID for the disposable test guest. Reuse it after each destroy."
  type        = number
  default     = 9800
}

variable "vm_name_prefix" {
  description = "Prefix for the disposable VM name."
  type        = string
  default     = "cr-test"
}

variable "bridge" {
  description = "Proxmox bridge connected to the Control Room test machine."
  type        = string
  default     = "vmbr0"
}

variable "vm_datastore_id" {
  description = "Target datastore for the cloned VM disks."
  type        = string
  default     = "local-lvm"
}

variable "cloud_init_datastore_id" {
  description = "Datastore for the cloud-init disk."
  type        = string
  default     = "local-lvm"
}

variable "snippet_datastore_id" {
  description = "Proxmox directory storage with snippets enabled for distro-specific cloud-init data."
  type        = string
  default     = "local"
}

variable "ipv4_cidr" {
  description = "Static IPv4 address and prefix for the disposable VM."
  type        = string

  validation {
    condition     = can(cidrhost(var.ipv4_cidr, 0))
    error_message = "ipv4_cidr must use CIDR notation, for example 192.168.100.240/24."
  }
}

variable "gateway_ipv4" {
  description = "IPv4 gateway for the disposable VM."
  type        = string
}

variable "dns_servers" {
  description = "DNS servers passed to cloud-init."
  type        = list(string)
  default     = []
}

variable "ssh_username" {
  description = "Temporary account created through cloud-init."
  type        = string
  default     = "controlroom"
}

variable "ssh_public_key_file" {
  description = "Public key installed for the temporary account."
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}

variable "cpu_cores" {
  description = "Virtual CPU cores assigned to the disposable VM."
  type        = number
  default     = 1
}

variable "cpu_type" {
  description = "Proxmox CPU model. RHEL-family 9 guests require the x86-64-v2 instruction baseline."
  type        = string
  default     = "x86-64-v2-AES"
}

variable "memory_mb" {
  description = "Optional memory override. Defaults to 768 MiB for Alpine and 1536 MiB elsewhere."
  type        = number
  default     = null

  validation {
    condition     = var.memory_mb == null || (var.memory_mb >= 512 && var.memory_mb <= 3072)
    error_message = "memory_mb must stay between 512 and 3072 MiB for this single-guest lab."
  }
}

variable "full_clone" {
  description = "Create an independent full clone instead of a linked clone."
  type        = bool
  default     = true
}
