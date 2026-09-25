# Proxmox distribution lab

This harness creates one disposable Linux VM for Control Room testing. Terraform
clones a cloud-init template and owns the VM lifecycle. Ansible installs the
inspection dependencies and creates known systemd, port, firewall, log, and
optional Docker fixtures.

It never creates more than one VM in its Terraform state. The default allocation
is 1 vCPU using Proxmox's `x86-64-v2-AES` model and 1536 MiB of memory. The CPU
model is required by RHEL-family 9 images. Alpine uses 768 MiB. With the current Proxmox
load of 10.36 GiB out of 15.29 GiB, one normal guest raises allocated memory to
about 11.86 GiB before workload variation. Do not leave an old manual clone
running when starting the next target.

## Why the templates stay outside Terraform

The harness clones existing cloud-init templates. It does not download or
convert vendor images. This keeps RHEL subscription downloads and SLES media
outside the repository, and it prevents a moving image URL from silently
changing the operating system under test.

Community Scripts can create the first templates when a suitable script exists.
For the permanent suite, record the source image URL, release, checksum, and the
Community Scripts revision if one was used. RHEL and SLES validation must use
their real vendor images.

Each template must:

- boot as a QEMU VM, not an LXC container;
- accept Proxmox cloud-init user and network settings;
- have an SSH server enabled;
- let the cloud-init user run passwordless sudo;
- use one network device connected to the configured bridge;
- remain stopped and marked as a Proxmox template.

The QEMU guest agent is useful but not required. The lab uses a fixed IPv4
address and does not wait for the agent to report an address.

Terraform explicitly leaves cloud-init package upgrades disabled. The Ansible
playbook installs only the packages required by the fixtures, so a test run
does not silently turn into a full distribution upgrade or change the vendor
image before Control Room inspects it.

### Fedora Server template used in this lab

Template 9015 was prepared from Fedora's official
`Fedora-Server-Guest-Generic-44-1.7.x86_64.qcow2` image. Its SHA-256 digest is
`446c01f71e3c6cd3889af66fec927b8d1160b8e0744243d7861c2b8b2ddd3f0e`.
The stock Server guest image opens Fedora Initial Setup and does not include
cloud-init, so the template adds cloud-init, enables its services, disables the
interactive first-boot services, cleans machine identity and SSH host keys, and
then shuts down before conversion to a Proxmox template. No package upgrade is
performed when disposable clones are created.

## Controller requirements

- Terraform 1.9 or newer
- Docker
- an SSH key pair
- network access to Proxmox and the test VM
- a dedicated Proxmox API token

Ansible does not support a native Windows control node. `lab.sh` runs the pinned
Ansible version in Docker, so the same commands work from Git Bash or Linux.
The private key is copied into the temporary container with mode 0600 and the
container is removed after the playbook exits.

Give the Proxmox token only the permissions needed to clone, configure, power,
and destroy lab VMs and to allocate space on the selected datastore. Scope it to
a dedicated test pool when possible. Do not use a root password or commit the
token. The provider accepts it through `TF_VAR_proxmox_api_token`.

## One-time setup

Copy the example configuration:

```bash
cd infra/proxmox-distro-lab
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
```

Edit `terraform.tfvars` with the Proxmox node, storage, bridge, unused test IP,
gateway, public-key path, and template VM IDs. The file is ignored by Git.

Export the API token and private-key path in the shell that runs the lab:

```bash
export TF_VAR_proxmox_api_token='terraform@pve!control-room=secret-value'
export CONTROL_ROOM_LAB_SSH_KEY="$HOME/.ssh/id_ed25519"
```

Alpine uses custom cloud-init data because its default account stays locked even
when Proxmox installs an SSH key. `lab.sh up alpine` uploads that snippet over
SSH before Terraform creates the VM. If the Proxmox SSH address differs from
this lab's default, set it explicitly:

```bash
export CONTROL_ROOM_LAB_PROXMOX_SSH_TARGET='root@192.168.100.200'
```

The Alpine image may also omit `/etc/resolv.conf`. The playbook writes the lab
resolver before installing packages; override its default when needed:

```bash
export CONTROL_ROOM_LAB_DNS_SERVER='192.168.100.1'
```

On Git Bash, a Windows key path also works:

```bash
export CONTROL_ROOM_LAB_SSH_KEY='C:\Users\X13\.ssh\id_ed25519'
```

## Run one distribution

Start with Rocky Linux:

```bash
./lab.sh up rocky
./lab.sh test
```

`up` performs these steps:

1. Terraform clones the Rocky template to VM ID 9800.
2. Cloud-init installs the test SSH key and fixed address.
3. The Docker-hosted Ansible controller waits for SSH.
4. Ansible checks `/etc/os-release` before installing anything.
5. Ansible installs Bash, iproute2, procps, firewall tools, and Python.
6. It creates active, socket-activated, and intentionally failed service
   fixtures on systemd guests. Alpine gets an OpenRC HTTP fixture instead.
7. It enables UFW on Debian and Ubuntu or firewalld on the other systemd
   targets, then adds an explicit TCP 18080 rule.
8. After the expected distribution is confirmed, it replaces the SSH
   `known_hosts` entry for the dedicated test IP because every disposable VM
   reuses that address with a new host key.
9. It writes `.lab.env` with the exact live-test connection settings.

`test` runs the ignored Rust SSH test against the VM. It checks distro
detection, host resources, filesystems, firewall parsing, ports, connections,
systemd services, boot evidence where available, and Docker when the daemon is
reachable.

For the Docker pass, destroy and recreate the same distro with the opt-in flag:

```bash
./lab.sh down
export LAB_INSTALL_DOCKER=true
./lab.sh up rocky
./lab.sh test
```

The Docker pass installs Docker from Docker's RPM repository on Rocky, Alma,
RHEL, Fedora, CentOS Stream, and Oracle Linux. Other targets use their own
distribution package. It starts an `nginx:alpine` fixture on TCP 18082 with
Compose project and service labels. Package or repository failures remain hard
failures rather than being reported as a passing Docker test.

When manual Control Room testing is complete, destroy the guest:

```bash
./lab.sh down
```

Terraform stops and removes VM 9800. It does not modify or delete the template.
The script refuses to replace one distribution with another until `down`
finishes.

## Test order

Use this order:

1. `rocky`
2. `ubuntu`
3. `debian`
4. `alma`
5. `rhel`
6. `fedora`
7. `centos-stream`
8. `oracle`
9. `amazon-linux`
10. `opensuse-leap`
11. `sles`
12. `arch`
13. `alpine`

Run the core pass first for every distribution. Run the Docker pass separately
so a Docker packaging problem cannot hide a failure in the portable or init
system inspection paths.

## Manual depth pass

After `lab.sh test` passes, connect with the Control Room installer built from
the same commit and inspect every available pane:

- Overview reports the exact distribution, kernel, architecture, uptime,
  resources, shell, init system, journald, firewall, and Docker state.
- Systemd lists the active HTTP service, socket unit, and intentional failed
  unit. Alpine reports that systemd is unavailable.
- Ports shows TCP 18080 and 18081. Ownership is only shown when the evidence is
  unambiguous. The Docker pass also shows TCP 18082.
- Firewall reports active UFW or firewalld state and the numeric TCP 18080 rule.
  Alpine reports the unsupported firewall boundary.
- Boot and journald Logs work on systemd guests and remain unavailable on
  Alpine.
- Docker lists and inspects the fixture and can stream its logs during the
  Docker pass.
- Enhanced History records only commands emitted by the installed Bash
  integration.
- Baselines capture available sections, compare a second live read, and keep
  unavailable sections distinct.
- The same reads are repeated with normal access, passwordless sudo allowed,
  and any applicable one-shot sudo path.

Record the image release and checksum, template VM ID, Proxmox version, test
commit, core result, Docker result, and manual pane result before destroying the
guest.

## Known limits

- The harness assumes each template implements Proxmox cloud-init user and
  static-network overrides. A template that ignores either setting fails before
  Ansible can connect.
- RHEL must be registered or have working package repositories. SLES needs the
  modules that provide the requested packages.
- Docker's CentOS repository is used for Rocky, Alma, Oracle, and CentOS Stream.
  Docker documents derivative use as unverified, so a failure there does not
  mean Control Room's read-only Docker inspection is broken.
- Terraform state identifies the disposable VM. Deleting it manually in
  Proxmox creates drift. Run `terraform apply` or repair the state before
  continuing.
- This suite does not turn LXC results into VM support claims. LXC shares the
  Proxmox host kernel and changes the evidence seen by boot, firewall, systemd,
  and `/proc` inspection.
