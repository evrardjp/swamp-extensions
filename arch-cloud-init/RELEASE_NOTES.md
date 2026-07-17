## 2026.07.17.1

**Fixed:** Failed qcow2 or cloud-init ISO creation no longer leaves partial
artifacts that later `prepare` runs mistake for completed files.

**Fixed:** Concurrent `prepare` runs no longer delete or overwrite an overlay
disk successfully created by another invocation.

**Fixed:** Base-image downloads and cloud-init ISOs are now published atomically,
so concurrent runs cannot delete, overwrite, or accept another run's partial
artifact.

**Fixed:** Cloud-init values are YAML encoded, and static networking now matches
common predictable libvirt interface names instead of assuming `eth0`.

**Added:** Configurable ordered Arch Linux pacman mirrors in generated
cloud-init seed images, with Belgian and German mirrors as defaults.

**Changed:** Newly generated seed images now replace `/etc/pacman.d/mirrorlist`
before cloud-init installs packages. Existing seed ISOs remain unchanged; remove
an existing ISO before rerunning `prepare` to apply new mirror settings.

**Changed:** `prepare` now validates destination directories, the SSH public key,
existing non-empty artifacts, qcow2 metadata, and the ISO signature before making
durable changes. Invalid existing artifacts cause an error instead of being
silently reused.

**Added:** `networkInterfaceMatch` configures the cloud-init interface-name glob
and defaults to `en*`, covering common `ens3` and `enp1s0` libvirt interfaces.

**Upgrade note:** Existing configurations remain valid through the new default.
Set `networkInterfaceMatch` explicitly for guests whose interface does not start
with `en`. Remove an existing seed ISO to apply the new network configuration.
