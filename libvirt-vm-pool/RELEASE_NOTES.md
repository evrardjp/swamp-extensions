## 2026.07.17.1

**Added:** VM cloud-init now installs CA certificates and sudo, writes a configurable ordered Arch Linux pacman mirror list, and disables the systemd time-wait service that can delay local lab bootstrapping.

**Changed:** VM desired states are now `deleted`, `poweredOff`, and `poweredOn`. `poweredOff` actively requests a graceful libvirt shutdown.

**Upgrade note:** Update `absent`, `defined`, `running`, or `reachable` desired-state values to `deleted`, `poweredOff`, or `poweredOn` respectively; both `running` and `reachable` map to `poweredOn`. Legacy values remain accepted and are normalized during execution so existing definitions and stored resources remain readable.
