# @evrardjp/qcow2-overlay-prep

Generic qcow2 base image downloader and overlay disk preparer for Swamp.

## Model type

```bash
@evrardjp/qcow2-overlay-prep
```

## What it does

The `prepare` method:

1. Ensures a base qcow2 image exists locally, optionally downloading it from
   `baseImageUrl`.
2. Creates a qcow2 overlay disk with
   `qemu-img create -f qcow2 -b <base> -F qcow2`.
3. Optionally grants a local user read/write ACLs on the image files with
   `setfacl`.
4. Publishes a `prep/current` resource with paths and action booleans.

It does not generate cloud-init data, define VMs, or start hypervisors.

## Example

```yaml
globalArguments:
  baseImagePath: /var/lib/libvirt/images/base.qcow2
  baseImageUrl: https://images.example.com/base.qcow2
  overlayPath: /var/lib/libvirt/images/demo.qcow2
  diskSizeGb: 20
  fileAclUser: qemu
```

```bash
swamp model method run demo-overlay prepare
```

Use `recreateOverlay: true` only when you intentionally want to remove and
recreate the overlay disk.
