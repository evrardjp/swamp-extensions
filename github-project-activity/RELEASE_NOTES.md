## 2026.07.03.5

**Fixed:** Codebase heatmap now filters PR-file touches, landed PR-file summary counts, and PR-file snapshot totals using the scoped repository plus PR number, avoiding cross-repository PR number collisions and mismatched totals.

**Fixed:** Codebase heatmap preserves legacy PR-file history when the corresponding PR snapshot has already expired from retained data, without treating the snapshot sync time as the last code touch time.

**Fixed:** Codebase heatmap ignores stale retained PR-file rows for merged PRs when those rows were not refreshed with a merged-file `landedAt`, avoiding false landed touches for files removed from a PR before merge.

**Changed:** PR-file snapshots now record `landedAt` when syncing merged PRs so future reports can classify retained file history without needing the PR snapshot.
