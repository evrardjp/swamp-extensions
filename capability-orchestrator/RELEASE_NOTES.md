## 2026.07.17.3

**Fixed:** Direct `model_method` capability plans now render catalog
`globalArgs` into workflow task `inputs`, so required model configuration such
as host, user, port, and package lists is preserved when generated plan items
are executed by Swamp workflows.

**Added:** Capability catalog entries can declare public endpoint exposure metadata, including backend and public listeners, schemes, and TLS behavior.

**Changed:** Rendered `model_method` plan items now follow Swamp's workflow task
contract by exposing merged model arguments under `implementation.inputs`
instead of carrying a separate `globalArgs` field in the planned task output.

**Changed:** Pacman package capabilities that require an empty-package collector are aggregated into one collector task per VM while preserving their other dependency edges. Package removals continue to run as independent tasks.

**Changed:** Capability dependency names must be non-empty.

**Upgrade note:** Workflows or reports that consumed `plan/current` and read
`implementation.globalArgs` from planned `model_method` items should switch to
`implementation.inputs`.

**Upgrade note:** Pacman package capabilities with `ensure: present` must directly require a pacman collector capability whose package list is empty.
