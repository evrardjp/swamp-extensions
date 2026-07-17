# @evrardjp/arch-cloud-init

Convenience Arch Linux VM image preparer for Swamp.

This is the opinionated wrapper around the more reusable concerns handled by
`@evrardjp/qcow2-overlay-prep` and `@evrardjp/cloud-init-nocloud`.

## Model type

```bash
@evrardjp/arch-cloud-init
```

## What it does

The `prepare` method:

1. Downloads the Arch Linux cloud image if the configured base image is absent.
2. Creates a qcow2 overlay disk for one VM.
3. Generates a NoCloud seed ISO with hostname, static network config, one SSH
   user, an ordered pacman mirrorlist, `openssh`, and `sshd` enabled.
4. Optionally appends extra Arch-specific `runcmd` entries.
5. Optionally grants a local user read/write ACLs on the image artifacts.

## Example

```yaml
globalArguments:
  vmName: demo
  hostname: demo
  ipAddress: 192.0.2.10/24
  gateway: 192.0.2.1
  nameserver: 192.0.2.53
  networkInterfaceMatch: en*
  sshUser: admin
  sshPubKeyPath: ~/.ssh/id_ed25519.pub
  diskSizeGb: 20
  imagesDir: /var/lib/libvirt/images
  baseImagePath: /var/lib/libvirt/images/arch-cloud-base.qcow2
  pacmanMirrors:
    - https://geo.mirror.pkgbuild.com/$repo/os/$arch
  extraRuncmd:
    - pacman-key --init
    - pacman-key --populate archlinux
  fileAclUser: qemu
```

```bash
swamp model method run demo-image-prep prepare
```

The method leaves an existing cloud-init ISO unchanged. Remove the existing ISO
before rerunning `prepare` when changing seed settings such as `pacmanMirrors`.

`networkInterfaceMatch` is a cloud-init interface-name glob. Its default, `en*`,
matches common predictable libvirt interface names such as `ens3` and `enp1s0`.
Set it explicitly if the guest uses another naming scheme.

Preparation requires Linux, `qemu-img`, and an existing writable `imagesDir` and
base-image parent directory. `setfacl` is also required when `fileAclUser` is set.
Existing base images, overlays, and seed ISOs must be regular non-empty files;
qcow2 metadata and the ISO signature are validated before they are reused.

For reusable non-Arch workflows, prefer composing generic image prep and generic
NoCloud ISO generation instead of this wrapper.
