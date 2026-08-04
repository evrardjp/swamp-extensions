## 2026.08.04.1

**Changed:** Definitions using the deprecated `reachable` desired state now emit a warning and are normalized to `poweredOn`.

**Upgrade note:** Replace `reachable` with `poweredOn`, then add an explicit downstream SSH or network readiness check. `reachable` remains temporarily accepted for compatibility.
