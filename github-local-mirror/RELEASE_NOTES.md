## 2026.07.23.1

**Fixed:** Sync now updates canonical branches such as `refs/heads/main` in the
managed bare repository instead of leaving them stale while fetching only into
hard-coded `refs/remotes/origin/*` references.

**Changed:** The configured `gitRemote` now determines the remote-tracking
namespace. Upstream branches are also available through canonical branch names,
while local `review/*` worktree branches remain independent.

**Upgrade note:** After pulling this version, run `sync` once to refresh stale
canonical branch references in existing bare mirrors.
