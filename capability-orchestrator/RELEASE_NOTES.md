## 2026.07.05.1

**Fixed:** Direct `model_method` capability plans now render catalog
`globalArgs` into workflow task `inputs`, so required model configuration such
as host, user, port, and package lists is preserved when generated plan items
are executed by Swamp workflows.

**Changed:** Rendered `model_method` plan items now follow Swamp's workflow task
contract by exposing merged model arguments under `implementation.inputs`
instead of carrying a separate `globalArgs` field in the planned task output.

**Upgrade note:** Workflows or reports that consumed `plan/current` and read
`implementation.globalArgs` from planned `model_method` items should switch to
`implementation.inputs`.
