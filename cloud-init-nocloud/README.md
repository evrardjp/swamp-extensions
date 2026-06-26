# @evrardjp/cloud-init-nocloud

Generic cloud-init NoCloud seed ISO generator for Swamp.

This extension intentionally avoids distribution, hypervisor, and image-format
assumptions. It only renders NoCloud seed content into a minimal ISO 9660 image
with the `CIDATA` volume label expected by cloud-init.

## Model type

```bash
@evrardjp/cloud-init-nocloud
```

## Method

```bash
swamp model method run <model-name> generate --args '{
  "userData": "#cloud-config\nusers: []\n",
  "metaData": "instance-id: demo-1\nlocal-hostname: demo\n",
  "networkConfig": "version: 2\nethernets: {}\n",
  "outputPath": "/var/lib/libvirt/images/demo-cloud-init.iso",
  "overwrite": true
}'
```

`userData` is required unless `globalArguments.defaultUserData` is set.
`metaData` is optional; when omitted, the model generates it from `instanceId`
and `localHostname` arguments or global defaults. `networkConfig` is optional.

The model always writes a Swamp file output named `iso/seed`. If `outputPath` is
provided, it also writes the same bytes to that host path. Existing host files
are protected unless `overwrite: true` is set.

## Global defaults

```yaml
globalArguments:
  defaultInstanceId: demo-1
  defaultLocalHostname: demo
  defaultUserData: |
    #cloud-config
    users: []
  defaultNetworkConfig: |
    version: 2
    ethernets: {}
  defaultOutputPath: /var/lib/libvirt/images/demo-cloud-init.iso
```

## Outputs

- File `iso/seed`: generated ISO bytes.
- Resource `isoSummary/current`: file list, byte length, SHA-256 checksum,
  optional host output path, and generation timestamp.

## Scope

This extension does **not** download cloud images, create qcow2 overlays, define
libvirt domains, or install OS packages. Compose it with separate image or VM
models for those concerns.
