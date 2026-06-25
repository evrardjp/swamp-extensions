# @evrardjp/libvirt-vm-pool

Desired-state local libvirt VM pool reconciler for Swamp.

This model owns the VM substrate layer only: libvirt domain lifecycle, cloud-init
seed/disk creation, power state, and connection facts. App packages, services,
certificates, templates, and verification should stay in downstream SSH/config
models and workflows.

## Model type

```bash
@evrardjp/libvirt-vm-pool
```

Recommended instance name in a Swamp repo:

```bash
swamp model create @evrardjp/libvirt-vm-pool lab-vm-pool
```

## Desired state

Declare the pool in the model definition's `globalArguments.vms` list:

```yaml
globalArguments:
  uri: qemu:///system
  vms:
    - name: gitea
      desiredState: reachable # absent | defined | running | reachable
      hostname: gitea
      ipAddress: 192.168.164.12
      prefixLength: 24
      gateway: 192.168.164.1
      nameserver: 192.168.102.1
      sshUser: admin
      memoryMiB: 2048
      vcpus: 2
      diskSizeGb: 20
      network: routed
      imagesDir: /var/lib/libvirt/images
      baseImagePath: /var/lib/libvirt/images/arch-cloud-base.qcow2
      baseImageUrl: https://geo.mirror.pkgbuild.com/images/latest/Arch-Linux-x86_64-cloudimg.qcow2
```

`desiredState` values:

- `absent` — destroy/undefine the domain and remove disk/seed ISO.
- `defined` — ensure disk/seed/domain exist, do not start.
- `running` — ensure defined and started.
- `reachable` — same substrate actions as `running`, plus publish the intent
  that downstream SSH wait/config models should expect connectivity.

## Methods

```bash
# Safe: inspect desired vs observed state and write Swamp data only
swamp model method run lab-vm-pool plan

# Mutating: reconcile every VM in the pool
swamp model method run lab-vm-pool sync
```

Use `plan` before destructive changes, especially before changing a VM to
`absent`.

## Generated Swamp data

The model writes one `vm` resource per VM using the VM name as the data name, and
one `summary` resource named `current`.

Example downstream CEL references:

```cel
data.latest("lab-vm-pool", "gitea").attributes.ipAddress
data.latest("lab-vm-pool", "gitea").attributes.sshUser
data.latest("lab-vm-pool", "gitea").attributes.currentState
```

A per-VM resource contains fields like:

```json
{
  "name": "gitea",
  "desiredState": "reachable",
  "previousState": "shut off",
  "currentState": "running",
  "ipAddress": "192.168.164.12",
  "sshUser": "admin",
  "diskPath": "/var/lib/libvirt/images/gitea.qcow2",
  "isoPath": "/var/lib/libvirt/images/gitea-cloud-init.iso",
  "actions": ["ensureImage", "define", "start"],
  "errors": []
}
```

## Separation of concerns

The VM pool should not install or configure applications. Use it as the first
workflow phase, then let config/app models consume the published Swamp data:

```text
lab-vm-pool.sync
  -> generic SSH/base config models
  -> app-specific workflows/models
  -> verification
```
