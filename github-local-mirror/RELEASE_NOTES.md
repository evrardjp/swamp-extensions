## 2026.07.23.1

**Fixed:** Sync now updates canonical branches such as `refs/heads/main` in the
managed bare repository instead of leaving them stale while fetching only into
hard-coded `refs/remotes/origin/*` references.

**Changed:** The configured `gitRemote` now determines the remote-tracking
namespace. Upstream branches are also available through canonical branch names,
while local worktree branches remain independent.

**Upgrade note:** After pulling this version, run `sync` once to refresh stale
canonical branch references in existing bare mirrors. If a custom `gitRemote`
was previously used and `origin` is not a separate remote you need to retain,
remove its legacy stale refs with
`git --git-dir <path> for-each-ref --format='delete %(refname)' refs/remotes/origin | git --git-dir <path> update-ref --stdin`.
