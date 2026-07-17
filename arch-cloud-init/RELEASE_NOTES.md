## 2026.07.17.1

**Fixed:** Failed qcow2 or cloud-init ISO creation no longer leaves partial
artifacts that later `prepare` runs mistake for completed files.

**Added:** Configurable ordered Arch Linux pacman mirrors in generated
cloud-init seed images, with Belgian and German mirrors as defaults.

**Changed:** Newly generated seed images now replace `/etc/pacman.d/mirrorlist`
before cloud-init installs packages. Existing seed ISOs remain unchanged; remove
an existing ISO before rerunning `prepare` to apply new mirror settings.
