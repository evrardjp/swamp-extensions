## 2026.07.24.1

**Added:** `create_worktree` can register development worktrees from a local base
ref before a pull request exists. `attach_worktree`, `detach_worktree`, and
`remove_worktree` provide explicit lifecycle operations without conflating PR
association with filesystem state.

**Added:** `refresh_pr_worktrees` uniquely attaches matching development
worktrees, retains superseded PR revisions, materializes missing current
revisions for tracked identity lineages, and safely removes merged-PR worktrees.

**Changed:** Worktree analysis and status now include creation provenance,
optional PR association, current branch and HEAD, upstream configuration,
revision state, and unambiguous PR attachment candidates.

**Changed:** `sync` accepts `requireComplete=true` so workflows can stop before
worktree reconciliation when synchronization returns partial results.

**Upgrade note:** Existing worktree registry records are decoded as review
worktrees and remain compatible. `prepare_worktree` and
`close_merged_worktrees` remain available for existing callers; new automation
should use `sync -> refresh_pr_worktrees -> analyze_worktrees`.
