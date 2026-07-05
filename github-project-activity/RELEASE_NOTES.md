## 2026.07.03.5

**Fixed:** Codebase heatmap now filters PR-file touches and landed PR-file summary counts using the scoped repository plus PR number, avoiding cross-repository PR number collisions and mismatched totals.

**Fixed:** Codebase heatmap preserves legacy PR-file history when the corresponding PR snapshot has already expired from retained data.

**Changed:** PR-file snapshots now record `landedAt` when syncing merged PRs so future reports can classify retained file history without needing the PR snapshot.
