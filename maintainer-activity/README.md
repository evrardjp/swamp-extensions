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
  --global-arg staleInactivityDays=15 \
  --global-arg "githubToken=\${{ vault.get('local', 'GITHUB_TOKEN') }}"
```

`staleInactivityDays` is the model-level threshold for stale candidate
classification. It defaults to `15` and is intentionally a model argument rather
than a per-run override so scheduled classification stays consistent.

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

Classifier methods:

```bash
# Classify open PRs/issues whose latest conversation/code activity is older
# than the model's staleInactivityDays threshold and that do not already carry
# the Stale label. This writes activityEvent records only; it does not mutate
# GitHub labels.
swamp model method run eso-external-secrets-activity classify_stale_candidates

# Preview candidates without writing activity events.
swamp model method run eso-external-secrets-activity classify_stale_candidates \
  --input dryRun=true

# Clear Swamp-side stale classifications for PRs/issues that became active again
# (or still carry the Stale label but no longer meet the inactivity threshold).
# This records a classification_stale_candidate_cleared activityEvent; it does
# not remove GitHub labels yet.
swamp model method run eso-external-secrets-activity clear_stale_candidates
```

### Stale candidate classification

`classify_stale_candidates` is a deterministic classifier over already-synced
Swamp data. It does not call GitHub directly and does not apply or remove GitHub
labels.

Selection rules:

- considers open `prSnapshot` and `issueSnapshot` records;
- uses the latest snapshot for each PR/issue number;
- skips items already carrying the configured stale label, `Stale` by default;
- for PRs, activity is the latest of `lastConversationAt`, `lastCodeChangeAt`,
  `updatedAt`, and `createdAt`;
- for issues, activity is the latest of `lastConversationAt`, `updatedAt`, and
  `createdAt`;
- classifies when inactive days are greater than or equal to the model-level
  `staleInactivityDays` threshold, default `15`.

The method writes one `activityEvent` per new classification:

- `eventType: classification_stale_candidate`
- `label: Stale`
- tags: `classification`, `stale`, `stale-candidate`

Manual classification examples:

```bash
# Refresh current data first, then classify.
swamp model method run eso-external-secrets-activity sync_github_recent_activity \
  --input lookbackMinutes=1440
swamp model method run eso-external-secrets-activity classify_stale_candidates

# Only PRs, preview-only, at most 10 candidates.
swamp model method run eso-external-secrets-activity classify_stale_candidates \
  --input includeIssues=false \
  --input maxCandidates=10 \
  --input dryRun=true
```

`clear_stale_candidates` records the inverse Swamp-side classification when an
item becomes active again. It considers items that either carry the stale label
or have a prior Swamp stale classification, then records a clear event when the
latest activity is newer than the `staleInactivityDays` threshold.

The method writes:

- `eventType: classification_stale_candidate_cleared`
- `label: Stale`
- tags: `classification`, `stale`, `stale-candidate`, `cleared`

Manual clear examples:

```bash
# Preview clear events.
swamp model method run eso-external-secrets-activity clear_stale_candidates \
  --input dryRun=true

# Record clear events.
swamp model method run eso-external-secrets-activity clear_stale_candidates
```

Important: `clear_stale_candidates` only clears the Swamp-side classification.
If a GitHub `Stale` label has already been applied by another tool, this method
will not remove it. Add a future GitHub-label mutation method, with write-capable
token scopes, to keep GitHub labels in sync.

### Daily scheduled stale classification workflow

Recommended daily automation is a Swamp workflow that refreshes recent activity,
classifies stale candidates, then clears classifications for items that became
active again.

Create the workflow scaffold first so Swamp assigns the ID:

```bash
swamp workflow create maintainer-stale-classification-daily --json
```

Edit the generated `workflows/workflow-<id>.yaml`, preserve the generated `id`,
and use this shape:

```yaml
id: <generated-by-swamp>
name: maintainer-stale-classification-daily
description: Refresh recent maintainer activity and update Swamp-side stale classifications every day.
version: 1
tags:
  domain: maintainer-activity
  cadence: daily
trigger:
  schedule: "0 6 * * *"
reports:
  skip:
    - "@evrardjp/maintainer-briefing"
jobs:
  - name: classify-stale
    description: Refresh recent GitHub activity, mark stale candidates, and clear stale marks for active items.
    steps:
      - name: sync-recent-activity
        task:
          type: model_method
          modelIdOrName: eso-external-secrets-activity
          methodName: sync_github_recent_activity
          inputs:
            lookbackMinutes: 1440
            includeOpenPrs: true
            includeRecentlyUpdatedIssues: true
        dependsOn: []
        weight: 0
        allowFailure: false
      - name: classify-stale-candidates
        task:
          type: model_method
          modelIdOrName: eso-external-secrets-activity
          methodName: classify_stale_candidates
        dependsOn:
          - step: sync-recent-activity
            condition:
              type: succeeded
        weight: 0
        allowFailure: false
      - name: clear-active-stale-candidates
        task:
          type: model_method
          modelIdOrName: eso-external-secrets-activity
          methodName: clear_stale_candidates
        dependsOn:
          - step: classify-stale-candidates
            condition:
              type: succeeded
        weight: 0
        allowFailure: false
    dependsOn: []
    weight: 0
```

Validate and run manually:

```bash
swamp workflow validate maintainer-stale-classification-daily --json
swamp workflow run maintainer-stale-classification-daily
```

The `trigger.schedule` field is a cron expression. `"0 6 * * *"` means daily at
06:00 according to the scheduler environment. The workflow remains runnable on
demand with `swamp workflow run` even when it also has a schedule.

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

(Optional): Sync the rest of the PRs, issues, etc.
   swamp model method run eso-external-secrets-activity sync_github_prs \
     --input state=open \
     --input limit=20 \
     --input includeFiles=true \
     --input includeReviews=true \
     --input includeReviewComments=true \
     --input includeIssueComments=true \
     --input includeChecks=true \
     --input includeTimeline=true

   swamp model method run eso-external-secrets-activity sync_github_issues \
     --input state=open \
     --input limit=20 \
     --input includeComments=true \
     --input includeTimeline=true

 For repair/history:

 ```bash
   swamp model method run eso-external-secrets-activity sync_github_backfill \
     --input since=2026-06-01 \
     --input until=2026-07-02 \
     --input limit=100
 ```

5. Classify stale candidates and clear stale classifications for recently
   active items:

```bash
# Preview first.
swamp model method run eso-external-secrets-activity classify_stale_candidates \
    --input dryRun=true
swamp model method run eso-external-secrets-activity clear_stale_candidates \
    --input dryRun=true

# Record Swamp-side classification events.
swamp model method run eso-external-secrets-activity classify_stale_candidates
swamp model method run eso-external-secrets-activity clear_stale_candidates
```

6. Read the briefing:

```bash
swamp report get @evrardjp/maintainer-briefing \
    --model eso-external-secrets-activity \
    --markdown
```

7. Pick a synced PR and render a dossier:

```bash
swamp data query 'modelName == "eso-external-secrets-activity" && specName == "prSnapshot"' \
    --select '{"number": attributes.number, "title": attributes.title, "url": attributes.url}'

  swamp model method run eso-external-secrets-activity render_pr_report \
    --input prNumber=<PR_NUMBER>

  swamp data get eso-external-secrets-activity pr-report-external-secrets-external-secrets-<PR_NUMBER> --json \
    | jq -r '.content.markdown'
```

### Deep dive into data

First, render the PR report:

```bash
  swamp model method run eso-external-secrets-activity render_pr_report \
    --input prNumber=6546
```

You will see a command listing the overall structure of data. Read it with:

```bash
swamp data get eso-external-secrets-activity \
    pr-report-external-secrets-external-secrets-6546 \
    --json | jq -r '.content.markdown'
```

Useful raw inspection commands:

```bash
# PR snapshots
swamp data query 'modelName == "eso-external-secrets-activity" && specName == "prSnapshot"' \
  --select '{"name": name, "version": version, "number": attributes.number, "title": attributes.title, "state": attributes.state, "checksState": attributes.checksState, "reviewDecision": attributes.reviewDecision, "url": attributes.url}'

# Activity events for PR 6546
swamp data query 'modelName == "eso-external-secrets-activity" && specName == "activityEvent" && attributes.subjectType == "pr" && attributes.subjectNumber == 6546' \
  --select '{"time": attributes.createdAt, "type": attributes.eventType, "actor": attributes.actor, "summary": attributes.summary, "file": attributes.filePath}'

# Changed files for PR 6546
swamp data query 'modelName == "eso-external-secrets-activity" && specName == "prFileSnapshot" && attributes.prNumber == 6546' \
  --select '{"path": attributes.path, "status": attributes.statusShort, "additions": attributes.additions, "deletions": attributes.deletions}'

# CI statuses for PR 6546
swamp data query 'modelName == "eso-external-secrets-activity" && specName == "ciStatusSnapshot" && attributes.prNumber == 6546' \
  --select '{"name": attributes.name, "status": attributes.status, "conclusion": attributes.conclusion, "url": attributes.url}'
```

