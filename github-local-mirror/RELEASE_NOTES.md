## 2026.07.29.1

**Fixed:** The PR context report now prefers the canonical current mirror-state
artifact, preventing stale synchronization dates from historical data names.

**Upgrade note:** No migration is required. Historical mirror-state artifacts
remain supported when the canonical artifact is absent.
