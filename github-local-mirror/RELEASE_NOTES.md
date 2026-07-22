## 2026.07.22.2

**Added:** The `close_merged_worktrees` method removes non-dirty worktrees after
their pull requests are merged while retaining their review branches and local
commits.

**Changed:** The local mirror status report now shows merged cleanup candidates,
successful removals, and cleanup failures. One dirty worktree no longer prevents
other eligible worktrees from being processed.

**Upgrade note:** Add `close_merged_worktrees` between `sync` and
`analyze_worktrees` in scheduled mirror workflows to enable automatic cleanup.
