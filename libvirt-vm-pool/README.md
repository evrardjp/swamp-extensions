# @evrardjp/libvirt-vm-pool

Desired-state local libvirt VM pool reconciler for Swamp.

This model owns the VM substrate layer only: libvirt domain lifecycle,
cloud-init seed/disk creation, power state, and connection facts. App packages,
services, SSH CA issuance, SSH daemon configuration, templates, and verification
should stay in downstream SSH/config models and workflows.

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

  # Optional metadata for downstream SSH CA / config models. This model does
  # not issue certificates or configure sshd; it only publishes these facts.
  sshCertificateAuthorities:
    host:
      - name: lab-host-ca
        model: lab-host-ca
        clientKnownHostsPatterns:
          - "*.lab.example"
          - "192.0.2.*"
    user:
      - name: lab-user-ca
        model: lab-user-ca
        trustedUserCAKeysPath: /etc/ssh/lab_user_ca.pub

  vms:
    - name: gitea
      desiredState: poweredOn # deleted | poweredOff | poweredOn
      hostname: gitea
      fqdn: gitea.lab.example
      serviceFqdn: git.lab.example
      ipAddress: 192.0.2.12
      prefixLength: 24
      gateway: 192.0.2.1
      nameserver: 198.51.100.1

      # Preferred bootstrap user declaration. The older sshUser/sshPubKeyPath
      # fields still work for compatibility, but new definitions should use
      # bootstrapSSHUser.
      bootstrapSSHUser:
        username: admin
        publicKeyPath: ~/.ssh/id_ed25519.pub

      # Optional metadata for downstream host certificate issuance/config.
      sshHostCertificate:
        ca: lab-host-ca
        principals:
          - gitea
          - gitea.lab.example
          - 192.0.2.12
        hostKeyPath: /etc/ssh/ssh_host_ed25519_key.pub
        hostCertificatePath: /etc/ssh/ssh_host_ed25519_key-cert.pub

      # Optional metadata for downstream user/account/certificate models.
      runtimeUsers:
        - username: git
          groups: [docker]
          sshCertificate:
            ca: lab-user-ca
            principals: [git, gitea-admin]

      memoryMiB: 2048
      vcpus: 2
      diskSizeGb: 20
      network: routed
      imagesDir: /var/lib/libvirt/images
      baseImagePath: /var/lib/libvirt/images/arch-cloud-base.qcow2
      baseImageUrl: https://geo.mirror.pkgbuild.com/images/latest/Arch-Linux-x86_64-cloudimg.qcow2
      pacmanMirrors:
        - https://archlinux.cu.be/$repo/os/$arch
        - https://mirror.netcologne.de/archlinux/$repo/os/$arch
      capabilities:
        - git
        - docker-host
```

`desiredState` values:

- `deleted` - destroy/undefine the domain and remove disk/seed ISO.
- `poweredOff` - ensure the disk, seed, and domain exist, then shut it down.
- `poweredOn` - ensure the disk, seed, and domain exist, then start it.

## SSH identity metadata

The VM pool publishes SSH-related intent, but does not implement the SSH CA
lifecycle itself.

- `bootstrapSSHUser` controls the cloud-init user and authorized key used for
  first access. If omitted, the legacy `sshUser` and `sshPubKeyPath` fields are
  used.
- `sshCertificateAuthorities` declares host/user CA models and paths/patterns
  for downstream config models.
- `sshHostCertificate` declares which CA/principals and host-key paths should be
  used by downstream certificate issuance/configuration.
- `runtimeUsers` declares non-bootstrap users and optional user-certificate
  principals for downstream account/certificate management.
- `fqdn` and `serviceFqdn` are published as connection/service facts for later
  DNS, SSH, reverse proxy, or application configuration steps.

## Methods

```bash
# Safe: inspect desired vs observed state and write Swamp data only
swamp model method run lab-vm-pool plan

# Mutating: reconcile every VM in the pool
swamp model method run lab-vm-pool sync
```

Use `plan` before destructive changes, especially before changing a VM to
`deleted`.

## Generated Swamp data

The model writes one `vm` resource per VM using the VM name as the data name,
and one `summary` resource named `current`.

Example downstream CEL references:

```cel
data.latest("lab-vm-pool", "gitea").attributes.ipAddress
data.latest("lab-vm-pool", "gitea").attributes.sshUser
data.latest("lab-vm-pool", "gitea").attributes.bootstrapSSHUser.username
data.latest("lab-vm-pool", "gitea").attributes.fqdn
data.latest("lab-vm-pool", "gitea").attributes.currentState
```

A per-VM resource contains fields like:

```json
{
  "name": "gitea",
  "hostname": "gitea",
  "fqdn": "gitea.lab.example",
  "serviceFqdn": "git.lab.example",
  "desiredState": "poweredOn",
  "previousState": "shut off",
  "currentState": "running",
  "ipAddress": "192.0.2.12",
  "sshUser": "admin",
  "bootstrapSSHUser": {
    "username": "admin",
    "publicKeyPath": "~/.ssh/id_ed25519.pub"
  },
  "sshHostCertificate": {
    "ca": "lab-host-ca",
    "principals": ["gitea", "gitea.lab.example", "192.0.2.12"],
    "hostKeyPath": "/etc/ssh/ssh_host_ed25519_key.pub",
    "hostCertificatePath": "/etc/ssh/ssh_host_ed25519_key-cert.pub"
  },
  "runtimeUsers": [
    {
      "username": "git",
      "groups": ["docker"],
      "sshCertificate": {
        "ca": "lab-user-ca",
        "principals": ["git", "gitea-admin"]
      }
    }
  ],
  "capabilities": ["git", "docker-host"],
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
  -> SSH wait / base config models
  -> SSH CA issuance and sshd/client trust configuration
  -> app-specific workflows/models
  -> verification
```
