# @evrardjp/github-local-mirror

Swamp-backed local GitHub mirror for maintainers and agents.

The model keeps two synchronized stores:

- a managed local git object repository (`gitObjectPath`) for commits, PR refs,
  diffs, and editable worktree creation;
- structured Swamp data for PRs, issues, comments, reviews, review comments,
  timeline events, check runs, file touches, patch revision metadata, sync
  cursors, and worktree analysis.

## Model name convention

Use:

```text
<owner>-<repo>-mirror
```

Examples:

```text
external-secrets-external-secrets-mirror
Roche-foxops-mirror
```

## Initial git repo

Create an explicit bare object repository before the first sync:

```bash
mkdir -p ~/git/external-secrets

git init --bare ~/git/external-secrets/external-secrets.git
```

The model will configure/fetch remotes during `sync`. It does **not** use
`git clone --mirror`; fetch refspecs are explicit and safer for local review
workflows.

## Create a model

```bash
swamp model create @evrardjp/github-local-mirror \
  external-secrets-external-secrets-mirror \
  --global owner=external-secrets \
  --global repo=external-secrets \
  --global gitObjectPath=$HOME/git/external-secrets/external-secrets.git \
  --global workspaceRoot=$HOME/git/external-secrets/worktrees \
  --global artifactRoot=$HOME/git/external-secrets/mirror-artifacts \
  --global githubToken='vault://...'
```

Optional globals:

- `gitRemoteUrl`: override `https://github.com/<owner>/<repo>.git`.
- `knownRemotes`: named push/fork remotes to keep configured in the common git
  repo.
- `firstSyncSince`: restrict first bootstrap if you do not want full history.
- `syncOverlapMinutes`: overlap cursor windows to avoid timestamp edge loss.
- `timelineCodeGranularity`: show code events as `observed-push` (default) or
  one event per `commit` in PR context reports.
- `needsClarificationLabels`: labels that deterministically mark a PR as
  needing clarification.
- `maxApiPages`: bounded GitHub pagination limit. Reaching it records an
  incomplete collection instead of silently truncating a timeline.

## Methods

### `sync`

Single public mirror refresh. It always syncs full-fidelity data for changed
PRs/issues: patches, file metadata, comments, reviews, review comments,
timeline, and checks.

```bash
swamp model method run external-secrets-external-secrets-mirror sync
```

During sync the model:

1. fetches git refs/objects, including PR head and merge refs;
2. configures upstream/known/contributor fork remotes when observed;
3. fetches changed PRs/issues from GitHub;
4. writes structured Swamp records;
5. exports revision patches under `artifactRoot/prs/<pr>/revisions/<headSha>/`;
6. updates local cursor state.

### `prepare_worktree`

Create an editable worktree for the latest mirrored PR head without calling
GitHub. The PR must already be present in the mirror.

```bash
swamp model method run external-secrets-external-secrets-mirror prepare_worktree \
  --input prNumber=123 \
  --input identity=jp
```

The branch/path naming convention is:

```text
review/pr-{number}-patchhead-{shortHeadSha}-{identity?}
<workspaceRoot>/pr-{number}-patchhead-{shortHeadSha}-{identity?}
```

After editing:

```bash
cd <returned-path>
git add .
git commit -m 'fix: address review issue'

# Push to your fork, or to the contributor fork if maintainer edits are allowed.
git push fork-evrardjp HEAD:review/pr-123-patchhead-abc123def456-jp
git push fork-contributor HEAD:<contributor-head-ref>
```

### `analyze_worktrees`

Analyze registered worktrees and write `worktreeAnalysis` data:

- missing/deleted worktree paths;
- dirty worktrees;
- local commits ahead of the original PR head;
- stale worktrees whose PR head changed since creation.

```bash
swamp model method run external-secrets-external-secrets-mirror analyze_worktrees
```

### `status`

Write and return current local mirror status:

```bash
swamp model method run external-secrets-external-secrets-mirror status
```

### `prepare_review_context`

Select a mirrored PR or issue and generate its deterministic context report
without contacting GitHub:

```bash
swamp model method run external-secrets-external-secrets-mirror \
  prepare_review_context \
  --input subjectType=pr \
  --input number=123

swamp report get @evrardjp/github-pr-context \
  --model external-secrets-external-secrets-mirror \
  --markdown
```

The report joins a requested PR to its referenced local issues and every other
local PR linked to those issues. Starting from an issue shows that issue and its
linked PRs. External references are not fetched or expanded; their URL is shown
when the mirror has one.

The timeline contains complete stored bodies, comments, reviews, events, and
code events. It does not embed code diffs. Instead, every push or commit event
includes its changed-file table and exact local `git` command.

Readiness is deterministic and tri-state:

- `Is Draft`
- `Needs CI fixes`
- `Changes requested by reviewer`
- `Needs clarification`

The result is `Not Ready` when any signal is `Yes`, `Ready` when every signal is
`No`, and `Unknown` otherwise.

### `record_pr_analysis`

Store an agent-produced code-path walkthrough and review-attention map for the
current mirrored head:

```bash
swamp model method run external-secrets-external-secrets-mirror \
  record_pr_analysis \
  --input-file pr-analysis.yaml
```

Example input:

```yaml
prNumber: 123
headSha: 0123456789abcdef
generator: maintainer-agent
codePathWalkthrough: |
  The request enters `src/router.ts` and delegates to `src/service.ts`.
reviewAttentionMap: |
  Review the new runtime dependency and transaction cleanup path.
evidenceRefs:
  - src/router.ts:20
  - 0123456789abcdef
```

The method rejects evidence for a stale head. Until matching evidence exists,
the deterministic report leaves both analysis sections visibly unfilled. The
bundled `github-pr-review` skill performs this check, asks before generating
analysis, records it through Swamp, and then shows the refreshed report.

## Status report

```bash
swamp report get @evrardjp/github-local-mirror-status \
  --model external-secrets-external-secrets-mirror \
  --markdown
```

## Suggested workflow shape

Use one scheduled workflow per repo mirror:

```text
sync -> analyze_worktrees
```

Set a small workflow `queueTimeout` so scheduled ticks exit quickly if a longer
bootstrap/backfill sync already holds the model lock. Run it frequently after the
first bootstrap; incremental runs should be lightweight.
