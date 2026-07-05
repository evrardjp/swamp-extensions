## 2026.07.03.5

**Fixed:** Codebase heatmap now filters PR-file touches, landed PR-file summary counts, and PR-file snapshot totals using the scoped repository plus PR number, avoiding cross-repository PR number collisions and mismatched totals.

**Fixed:** Codebase heatmap preserves legacy PR-file history with or without a retained merged PR snapshot. When only the PR-file row remains, it keeps the touch count but leaves the touch date unknown instead of treating the snapshot sync time as the last code touch time.

**Fixed:** Codebase heatmap ignores stale retained PR-file rows that are explicitly marked as not landed, avoiding false landed touches for files removed from a PR before merge or after PR snapshot retention cleanup.

**Fixed:** Codebase heatmap JSON keeps the existing `counts.currentFilesWithTouches` key as an alias of the new landed-touch count for dashboard compatibility.

**Changed:** PR-file snapshots now record `landedAt` when syncing merged PRs so future reports can classify retained file history without needing the PR snapshot. Open PR file snapshots leave `landedAt` unset, closed-unmerged snapshots use `null`, and merged PR syncs mark previously retained files that are no longer in the final PR file list as not landed.
