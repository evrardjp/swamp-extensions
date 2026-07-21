## 2026.07.20.1

**Added:** `@evrardjp/github-pr-context` provides a deterministic issue-centered PR/issue timeline with complete comments and event data, per-push or per-commit changed-file tables, local Git inspection commands, worktree state, and tri-state review readiness facts.

**Added:** PR and issue bodies, subject references, PR commits, richer review events, and collection-completeness records are retained in Swamp. External references remain unresolved and expose their URL when known.

**Added:** `prepare_review_context` selects a mirrored PR or issue, while `record_pr_analysis` stores code-path walkthrough and review-attention evidence tied to an exact PR head. The bundled `github-pr-review` skill asks before generating missing LLM evidence.

**Changed:** GitHub pagination is bounded and incomplete timeline, check, commit, or snapshot collection is recorded explicitly. Incomplete syncs no longer advance the successful cursor.

**Fixed:** Incomplete PR file pagination is retried for the same head until the complete changed-file set has been stored.

**Upgrade note:** Run `sync` after upgrading to populate the new context, relationship, commit, and collection-status resources. Existing snapshots remain compatible, but readiness remains `Unknown` until completeness records exist.
