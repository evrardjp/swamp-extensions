## 2026.07.17.1

**Added:** Initial `@evrardjp/github-local-mirror` extension with a repo mirror model, full-fidelity `sync`, `prepare_worktree`, `analyze_worktrees`, and `status` methods.

**Added:** Local patch revision artifacts, contributor fork remote discovery, Swamp-indexed PR/issue activity, check run snapshots, worktree snapshots, and worktree stale/dirty/ahead analysis.

**Added:** `@evrardjp/github-local-mirror-status` report for mirror freshness and local worktree state.

**Upgrade note:** This is a new extension and stores data separately from `@evrardjp/github-project-activity`.
