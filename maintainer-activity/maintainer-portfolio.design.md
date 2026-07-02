# Maintainer Portfolio Aggregate Model/Report Design

## Goal

Add a cross-repository maintainer portfolio layer on top of per-repository
`@evrardjp/maintainer-activity` model instances.

The per-repo activity models remain the source of truth for GitHub ingestion,
PR dossiers, raw snapshots, and repo-local timelines. The portfolio layer should
read those models and produce a durable cross-repo work queue/briefing without
re-fetching GitHub.

This does **not** replace or fix single-repo reports. Single-repo reports must
work independently on each `@evrardjp/maintainer-activity` model. The portfolio
model/report composes several already-synced activity models.

## Non-goals

- Do not ingest GitHub directly in the portfolio model.
- Do not copy all raw events/files from child models into the portfolio model.
- Do not merge unrelated projects into one activity model just for reporting.
- Do not silently include forks in upstream reports. Fork inclusion must be
  explicit and documented.

## Proposed extension surface

### Model type

```text
@evrardjp/maintainer-portfolio
```

### Report type

```text
@evrardjp/maintainer-portfolio-report
```

The report is model-scope over the portfolio model's stored aggregate resources.

## Portfolio model global arguments

```ts
{
  portfolioName: string,
  includePrivateEvents: boolean = true,
  stalePrDays: number = 14,
  staleIssueDays: number = 30,
  projects: Array<{
    name: string,
    modelName: string,
    modelId?: string,
    modelType?: string, // default @evrardjp/maintainer-activity
    repo: string,       // owner/name, used for display and dedupe keys
    role?: "upstream" | "fork" | "related" | "docs" | "infra",
    includeInDefaultBriefing?: boolean,
    dedupeGroup?: string,
  }>
}
```

`modelName` is the normal operator-facing reference. `modelId` is optional for
stable direct lookup if needed. `modelType` defaults to
`@evrardjp/maintainer-activity`.

## Portfolio resources

### `portfolioSnapshot`

One current aggregate snapshot per portfolio run.

Suggested fields:

```json
{
  "portfolioName": "External Secrets",
  "generatedAt": "2026-07-02T12:00:00Z",
  "projectCount": 4,
  "counts": {
    "openPrs": 42,
    "failingPrs": 5,
    "changesRequestedPrs": 8,
    "mergeConflictPrs": 1,
    "stalePrs": 7,
    "openIssues": 123,
    "staleIssues": 12,
    "privateEvents": 3
  },
  "projects": [
    {
      "name": "ESO",
      "repo": "external-secrets/external-secrets",
      "modelName": "eso-external-secrets-activity",
      "lastSyncedAt": "2026-07-02T11:55:00Z",
      "counts": { "openPrs": 30, "failingPrs": 4 }
    }
  ]
}
```

### `portfolioItem`

One aggregate work item per interesting PR/issue across all projects.

Suggested fields:

```json
{
  "id": "external-secrets/external-secrets#pr-6546",
  "projectName": "ESO",
  "repo": "external-secrets/external-secrets",
  "sourceModelName": "eso-external-secrets-activity",
  "subjectType": "pr",
  "subjectNumber": 6546,
  "title": "feat(generators): add Azure access token generator",
  "url": "https://github.com/external-secrets/external-secrets/pull/6546",
  "state": "open",
  "author": "davidkarlsen",
  "labels": ["kind/feature"],
  "signals": ["changes-requested", "large-pr", "recent-bot-review"],
  "priorityScore": 85,
  "recommendedAction": "Review CodeRabbit critical findings and decide whether maintainer intervention is needed",
  "lastActivityAt": "2026-07-02T08:20:00Z",
  "idleDays": 0,
  "visibility": "public",
  "dedupeKey": "external-secrets/external-secrets#pr-6546"
}
```

### `portfolioEventSummary`

Optional compact event rollup, not a copy of all child events.

```json
{
  "id": "external-secrets/external-secrets#pr-6546#2026-07-02",
  "repo": "external-secrets/external-secrets",
  "subjectType": "pr",
  "subjectNumber": 6546,
  "day": "2026-07-02",
  "publicEventCount": 12,
  "privateEventCount": 1,
  "notableEvents": [
    { "time": "08:20", "actor": "github-actions", "summary": "CI succeeded" }
  ],
  "sourceModelName": "eso-external-secrets-activity"
}
```

## Methods

### `aggregate`

Reads the configured child activity models and writes portfolio resources.

Inputs:

```ts
{
  projectNames?: string[],
  includePrivate?: boolean,
  since?: string,
  until?: string,
  maxItemsPerProject?: number,
  includeForks?: boolean
}
```

Behavior:

1. Resolve configured project model IDs/names.
2. Read child model data only via Swamp `dataRepository`.
3. Load latest `prSnapshot`, `issueSnapshot`, `ciStatusSnapshot`, and
   `activityEvent` resources per child model.
4. Derive signals and priority scores.
5. Apply deduplication.
6. Write one `portfolioSnapshot` and N `portfolioItem` resources.
7. Optionally write compact `portfolioEventSummary` resources.

### `aggregate_recent`

Convenience method for frequent workflows. Equivalent to `aggregate` with a
small recent window and normal default item caps.

### `aggregate_backfill`

Repair method for a bounded window. It should still read already-synced child
model data only; if child models are stale, the workflow should sync them first.

## Deduplication policy

Default dedupe key:

```text
<repo>#<subjectType>-<subjectNumber>
```

For upstream/fork aggregation:

- Issues and PRs are distinct unless explicitly linked by metadata.
- Changed files and commits are not portfolio-level primary keys in v1.
- If a fork PR and upstream PR represent the same work, that needs an explicit
  `dedupeGroup` or future relation resource.
- Reports must show which projects/forks were included.

## Priority scoring v1

Start simple and transparent:

| Signal | Score |
|---|---:|
| User-owned PR needs code fix | 100 |
| Security-relevant event/label | 95 |
| Failing CI on open PR | 80 |
| Requested changes on open PR | 75 |
| Merge conflict | 70 |
| Stale open PR | 60 |
| Stale open issue | 40 |
| Private maintainer note in recent window | +10 |
| Large PR (`changedFiles >= 20` or `additions + deletions >= 1000`) | +10 |

The report should display the signals used so the score is explainable.

## Portfolio report structure

```markdown
# Maintainer Portfolio — <portfolioName>

## Executive summary

| Metric | Count |
|---|---:|
| Open PRs | 42 |
| Failing PRs | 5 |
| Changes requested | 8 |
| Merge conflicts | 1 |
| Stale PRs | 7 |
| Stale issues | 12 |

## Top priority work

| Project | Item | Title | Score | Signals | Recommended action |
|---|---|---|---:|---|---|

## Failing CI across repos

## Requested changes across repos

## Merge conflicts

## Stale PRs and issues

## Recent private maintainer/agent notes

## Per-project rollup
```

## Workflow pattern

A scheduled workflow should sync child models, then aggregate:

```yaml
trigger:
  schedule: "*/30 * * * *"

jobs:
  sync-eso:
    steps:
      - model: eso-external-secrets-activity
        method: sync_github_recent_activity
  sync-website:
    steps:
      - model: eso-website-activity
        method: sync_github_recent_activity
  aggregate:
    needs: [sync-eso, sync-website]
    steps:
      - model: eso-maintainer-portfolio
        method: aggregate_recent
```

Nightly workflow:

1. Run bounded `sync_github_backfill` on child models.
2. Run portfolio `aggregate_backfill`.
3. Persist `@evrardjp/maintainer-portfolio-report`.

## Open decisions

1. Whether portfolio model config should reference child models by name only or
   require stable IDs.
2. Whether private events should be included by default in aggregate reports.
3. Whether to add a first-class relation/deduplication resource for fork/upstream
   PR equivalence.
4. Whether portfolio report should link to child `render_pr_report` artifacts or
   call no child methods and only print commands operators can run.
5. Whether `@evrardjp/maintainer-briefing` should remain single-repo only or be
   renamed to `@evrardjp/project-activity-briefing` later.
