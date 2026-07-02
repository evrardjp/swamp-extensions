# @evrardjp/maintainer-activity

Swamp-backed GitHub project activity database and maintainer briefing reports.

This extension stores durable project activity for one GitHub repository or
closely related project scope per Swamp model instance. It keeps both:

1. **Snapshots** — current repository, issue, PR, changed-file, fork, and CI
   state for dashboards/current-state reports.
2. **Activity events** — chronological facts from GitHub and private/manual/agent
   sources for timelines and historical reports.

## Model and report types

- Model: `@evrardjp/maintainer-activity`
- Report: `@evrardjp/maintainer-briefing`

Recommended pattern: create a separate model instance for each project/repo:

```bash
swamp model create @evrardjp/maintainer-activity eso-external-secrets-activity \
  --global-arg owner=external-secrets \
  --global-arg repo=external-secrets \
  --global-arg projectName="External Secrets Operator" \
  --global-arg "githubToken=\${{ vault.get('local', 'GITHUB_TOKEN') }}"
```

## GitHub token requirements

For public repositories, a fine-grained token with read-only repository access is
enough for most ingestion:

| Capability | GitHub access needed |
|---|---|
| Repository metadata | Metadata: read |
| Issues and issue comments | Issues: read |
| Pull requests, reviews, review comments, changed files | Pull requests: read |
| Checks / CI statuses | Checks: read; Actions: read if workflow runs/logs are ingested |
| Forks | Metadata: read |

For private repositories, grant equivalent read access to that private
repository.

Classic PAT equivalents:

- public-only: `public_repo` is usually sufficient;
- private repositories: `repo` read access is usually required;
- Actions logs/details may require Actions read access depending on API used.

The model stores GitHub content in Swamp data, including comments, review
bodies, file metadata, patch excerpts, CI details, and private maintainer/agent
notes. Treat the Swamp repo/datastore according to the sensitivity of the
repositories being ingested.

## Data resources

Current-state resources:

- `repoSnapshot`
- `forkSnapshot`
- `issueSnapshot`
- `prSnapshot`
- `prFileSnapshot`
- `ciStatusSnapshot`

Timeline/artifact resources:

- `activityEvent` — public/private chronological timeline entries
- `artifact` — large file data such as patches, logs, transcripts
- `artifactIndex` — searchable metadata for artifacts
- `prReport` — rendered PR dossier markdown and source metadata

## Methods

GitHub sync methods:

```bash
swamp model method run eso-external-secrets-activity sync_github_repo --input includeForkIndex=true
swamp model method run eso-external-secrets-activity sync_github_fork_index
swamp model method run eso-external-secrets-activity sync_github_recent_activity
swamp model method run eso-external-secrets-activity sync_github_prs --input state=open
swamp model method run eso-external-secrets-activity sync_github_issues --input state=open
swamp model method run eso-external-secrets-activity sync_github_backfill --input since=2026-01-01 --input until=2026-07-01
```

Manual/private records:

```bash
swamp model method run eso-external-secrets-activity record_activity --stdin
swamp model method run eso-external-secrets-activity record_artifact --stdin
```

Render a stored-data-only PR dossier:

```bash
swamp model method run eso-external-secrets-activity render_pr_report \
  --input prNumber=6530 \
  --input includePrivate=true
swamp data get eso-external-secrets-activity pr-report-external-secrets-external-secrets-6530 --json
```

## Fork model

`sync_github_fork_index` records fork metadata in the current model only. It does
**not** ingest full fork issue/PR/comment/review/file activity. If an important
fork needs full tracking, create a separate `@evrardjp/maintainer-activity`
model instance with `owner`/`repo` set to that fork.

Cross-repository reports that aggregate upstream plus fork models must document
their scope and deduplication policy, especially for commits and changed files
that can appear in both a fork and the upstream PR.

## Maintainer briefing report

`@evrardjp/maintainer-briefing` is a model-scope report over stored Swamp data.
It does not fetch GitHub itself.

```bash
swamp report get @evrardjp/maintainer-briefing --model maintainer-activity --markdown
swamp report get @evrardjp/maintainer-briefing --model maintainer-activity --json
```

The current report reads `prSnapshot`, `issueSnapshot`, `ciStatusSnapshot`, and
`activityEvent` resources. It highlights failing CI, requested changes, merge
conflicts, stale PRs/issues, and recent public/private activity events.

## Bundled maintainer skill

The Pi/agent-facing maintainer workflow lives in:

```text
maintainer-daily-briefing/SKILL.md
```

It tells agents how to fetch `@evrardjp/maintainer-briefing`, drill into a
PR/issue, and record durable conclusions through `record_activity` and
`record_artifact`.

## Development checks

```bash
deno check models/maintainer_activity.ts reports/maintainer_briefing.ts
deno test models/maintainer_activity_test.ts reports/maintainer_briefing_test.ts
swamp extension fmt manifest.yaml --check --json
swamp extension quality manifest.yaml --json
swamp extension push manifest.yaml --dry-run --json
```

Never publish without explicit maintainer approval.

## End to end usage

```bash
cd $YOUR_SWAMP_REPO
```

1. Ensure token exists:

```bash
swamp vault put local GITHUB_TOKEN <your-token>
```

2. Create a per-repo activity model:

```bash
swamp model create @evrardjp/maintainer-activity eso-external-secrets-activity \
    --global-arg owner=external-secrets \
    --global-arg repo=external-secrets \
    --global-arg projectName="External Secrets Operator" \
    --global-arg "githubToken=\${{ vault.get('local', 'GITHUB_TOKEN') }}"
```

3. Smoke-test metadata sync:

```bash
swamp model method run eso-external-secrets-activity sync_github_repo \
    --input includeForkIndex=true \
    --report @evrardjp/maintainer-briefing
```

4. Sync a small PR sample:

```bash
swamp model method run eso-external-secrets-activity sync_github_prs \
    --input state=open \
    --input limit=3 \
    --input includeFiles=true \
    --input includeReviews=true \
    --input includeReviewComments=true \
    --input includeIssueComments=true \
    --input includeChecks=true \
    --input includeTimeline=true \
    --report @evrardjp/maintainer-briefing
```

5. Read the briefing:

```bash
swamp report get @evrardjp/maintainer-briefing \
    --model eso-external-secrets-activity \
    --markdown
```

6. Pick a synced PR and render a dossier:

```bash
swamp data query 'modelName == "eso-external-secrets-activity" && specName == "prSnapshot"' \
    --select '{"number": attributes.number, "title": attributes.title, "url": attributes.url}'

  swamp model method run eso-external-secrets-activity render_pr_report \
    --input prNumber=<PR_NUMBER>

  swamp data get eso-external-secrets-activity pr-report-external-secrets-external-secrets-<PR_NUMBER> --json \
    | jq -r '.content.markdown'
```

If that works, next step is schedule a frequent workflow for sync_github_recent_activity and a nightly bounded sync_github_backfill.
