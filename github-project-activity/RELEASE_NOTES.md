## 2026.07.05.1

**Changed:** PR detail sync now always fetches PR files. The `includeFiles` input has been removed so PR snapshots and PR-file snapshots cannot drift apart when a PR is later merged.

**Changed:** PR-file snapshots now explicitly record whether the file was part of a merged PR with `merged: true` / `merged: false`, separately from the PR lifecycle state stored as `prState: "open"` / `prState: "closed"`.

**Changed:** Codebase heatmap now trusts only explicit merged PR-file snapshots. Older markerless PR-file rows are ignored instead of guessed.

**Upgrade note:** This is a breaking data-interpretation change for existing heatmap ingestions. Re-run `sync_github_prs` or `sync_github_backfill` for the history window you want represented.
