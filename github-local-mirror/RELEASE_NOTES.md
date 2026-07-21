## 2026.07.21.1

**Fixed:** Context reports can be retrieved after `prepare_review_context`
without resupplying method arguments, because the selected PR or issue is now
retained in Swamp.

**Fixed:** Comment-only reviews no longer clear an active changes-requested
state, dismissed reviews now clear it, and missing check-run data now leaves CI
readiness `Unknown` instead of reporting that no fixes are needed.

**Fixed:** Commit timelines exclude commits dropped by a force-push, initial PR
revisions use the Git merge base, and incremental PR listing stops once records
are older than the sync window.

**Fixed:** Local repository references are matched case-insensitively and
generated analysis commands safely quote model names.

**Upgrade note:** Run `sync` after upgrading so PR commits are recorded against
their current head. Until an older PR is resynced, its legacy commit records
remain visible; once current-head records exist, stale and legacy records are
excluded from its timeline.
