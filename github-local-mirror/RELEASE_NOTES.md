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

**Changed:** Development worktrees now default to the mirrored repository's
symbolic `HEAD`, and sync preserves their registered local branches instead of
reconciling those branches as mirror-owned refs. Creation rejects branch names
already owned by the configured mirror.

**Fixed:** Concurrent worktree lifecycle methods no longer lose registry
updates, interrupted PR-head materialization remains registered for retry, and
missing checkouts cannot delete ahead branches without explicit force.

**Fixed:** Identity-specific review worktrees use collision-resistant names and
resource IDs, while existing unhashed identity worktrees remain idempotent.

**Changed:** Detached, identity-verified worktrees remain eligible for refresh,
and analysis treats local descendants of the latest PR head as current.

**Changed:** The `review` branch name is reserved for managed PR worktrees. Sync
fails safely when a registered development worktree was renamed outside the
model instead of pruning its current branch.

**Changed:** Worktree cleanup verifies a persistent checkout identity before
removal, and malformed PR artifacts are isolated instead of aborting all
analysis and reconciliation.

**Upgrade note:** Existing worktree registry records are decoded as review
worktrees and remain compatible. `prepare_worktree` and
`close_merged_worktrees` remain available for existing callers; new automation
should use `sync -> refresh_pr_worktrees -> analyze_worktrees`. The
`worktreeSnapshot.prNumber` field is now optional for pre-PR development
worktrees. Consumers must read a PR association as
`prLink?.prNumber ?? prNumber` so both new and legacy review snapshots remain
supported; both values are absent for unattached development worktrees.
`worktreeAnalysis.isPrHeadStale` is now nullable while a development worktree is
unattached; consumers must test for `true` or `false` before using PR freshness.
Legacy worktrees without a checkout identity are retained by automatic cleanup;
re-run `prepare_worktree` or the matching `create_worktree`, or explicitly run
`attach_worktree`, to validate the checkout and backfill its identity.
