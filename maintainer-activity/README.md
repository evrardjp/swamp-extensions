# @evrardjp/maintainer-activity

Durable maintainer activity ledger and briefing reports for Swamp.

This extension stores the curated operational state a maintainer wants to see
again tomorrow: GitHub PR/issue lifecycle events, CI failures needing attention,
classifications, and distilled Pi agent-session findings. It complements
`@evrardjp/pi-session-telemetry`: Pi telemetry is the high-volume raw stream;
maintainer activity is the low-volume human-useful ledger.

## Architecture

```text
GitHub PR feed models             Pi session telemetry / agent conclusions
  -> ingest_github_pr_feed          -> record_pi_session_finding
              \                    /
               -> @evrardjp/maintainer-activity model
                    -> Swamp data resources
                    -> @evrardjp/maintainer-briefing report
```

`maintainer-activity` and `maintainer-briefing` are different Swamp concepts:

- `@evrardjp/maintainer-activity` is the **model type**. A model instance such as
  `maintainer-activity` owns the durable ledger and exposes methods that ingest
  or record maintainer facts.
- `@evrardjp/maintainer-briefing` is a **report** attached to that model. It does
  not fetch GitHub itself; it reads the model's stored Swamp data and renders a
  markdown/JSON view.

In short: **model = data + methods**, **report = view over that data**. Refresh
feed models and ingest into `maintainer-activity` before reading the report when
you need a current daily briefing.

The model intentionally stores curated records, not every raw event. Use it for
answers to questions like:

- What requires maintainer attention today?
- Which PRs/issues are blocked?
- Which CI failures need triage?
- What did an agent session conclude about this item?

## Swamp model

Model type: `@evrardjp/maintainer-activity`

Recommended instance name:

```bash
swamp model create @evrardjp/maintainer-activity maintainer-activity
```

## Generated Swamp data

The model writes these resource specs:

- `lifecycleEvent` — chronological event about a repo, issue, PR, project, or
  session. Sources include `github`, `swamp`, `pi-agent-session`, `review-tool`,
  and `manual`.
- `classification` — current analysis of an issue/PR: blocker status,
  difficulty, review effort, security relevance, inactivity, priority score, and
  recommended action.
- `ciAttention` — CI/workflow state that likely requires maintainer action.
- `sessionLog` — optional summarized or full agent-session context tied to one
  or more work items.

Example `lifecycleEvent`:

```json
{
  "repo": "owner/repo",
  "itemType": "pr",
  "number": 123,
  "source": "pi-agent-session",
  "actor": "pi",
  "eventType": "maintainer-finding",
  "summary": "Agent concluded CI failure likely needs maintainer triage",
  "relatedSessionId": "session-example",
  "tags": ["pi-session-telemetry"]
}
```

Example `classification`:

```json
{
  "repo": "owner/repo",
  "itemType": "pr",
  "number": 123,
  "blockerStatus": "ci_blocked",
  "blockerConfidence": 0.8,
  "securityRelevant": false,
  "inactive": false,
  "difficulty": "unknown",
  "reviewEffort": "unknown",
  "priorityScore": 60,
  "recommendedAction": "Inspect failing checks and decide whether maintainer action is needed"
}
```

## Bridge from Pi session telemetry

Use `@evrardjp/pi-session-telemetry` to capture normal Pi activity. When a Pi
session yields a useful maintainer conclusion, bridge only the distilled finding
into this model with `record_pi_session_finding`.

```bash
swamp model method run maintainer-activity record_pi_session_finding \
  --input 'finding:json={
    "sessionId":"session-example",
    "repo":"owner/repo",
    "itemType":"pr",
    "number":123,
    "summary":"Agent concluded the failing e2e job is probably a flaky setup issue, but maintainer must decide whether it blocks merge",
    "body":"Optional short detail. Do not paste raw private chat unless explicitly wanted.",
    "recordSessionLog":true,
    "sessionSummary":"Investigated PR #123 CI failure and identified likely flaky setup triage."
  }'
```

This writes:

1. a `lifecycleEvent` with `source: "pi-agent-session"`
2. `relatedSessionId` pointing back to the Pi telemetry session
3. optionally a `sessionLog` linked to the repo/PR/issue

Use this bridge instead of dumping all Pi telemetry into daily reports.

## GitHub PR feed ingestion

If `@mgreten/github-pr-feed` does not have cached events, refresh it first:

```bash                                                                                                                                                                                                                                                                                                                                            
swamp model method run gh-pr-feed-eso-eso refresh                                                                                                                                                                                                                                                                                                
```    

If a `@mgreten/github-pr-feed` model has cached PR events and snapshots, ingest
it into the maintainer ledger:

```bash
swamp model method run maintainer-activity ingest_github_pr_feed \
  --input feedModelId=<github-pr-feed-model-id> \
  --input repo=owner/repo \
  --input limit=5000 \
  --input includeBots=true \                                                                                                                                                                                                                                                                                                                     
  --input 'personalGithubHandles:json=["evrardjp","evrardj-roche"]'                                                                                                                                                                                                                                                                              
```

This creates:

- `lifecycleEvent` entries for PR feed events
- `ciAttention` entries for check failures
- `classification` entries from latest PR snapshots

## Manual records

Record a lifecycle event:

```bash
swamp model method run maintainer-activity record_event \
  --input 'event:json={
    "repo":"owner/repo",
    "itemType":"pr",
    "number":123,
    "source":"manual",
    "actor":"maintainer",
    "eventType":"decision",
    "summary":"Do not merge until author answers the API compatibility question"
  }'
```

Record CI attention:

```bash
swamp model method run maintainer-activity record_ci_attention \
  --input 'ci:json={
    "repo":"owner/repo",
    "prNumber":123,
    "workflow":"e2e",
    "conclusion":"failure",
    "reason":"Repeated failure likely requires maintainer triage",
    "requiresMaintainerAttention":true
  }'
```

## Report

### Cached report
The daily briefing is a report over the `maintainer-activity` model data.

You can produce the cached report using:

```bash                                                                                                                                                                                                                                                                                                                                            
swamp report get @evrardjp/maintainer-briefing \                                                                                                                                                                                                                                                                                                 
  --model maintainer-activity \                                                                                                                                                                                                                                                                                                                  
  --markdown                                                                                                                                                                                                                                                                                                                                     
```    

### Refreshed/today's daily briefing (example: External-Secrets)

For an up-to-date daily briefing, refresh the relevant GitHub PR feed first,
then ingest it, then read the report:

```bash
#change directory to your swamp repo first
swamp model method run gh-pr-feed-eso-eso refresh                                                                                                                                                                                                                                                                                                
                                                                                                                                                                                                                                                                                                                                                 
swamp model method run maintainer-activity ingest_github_pr_feed \                                                                                                                                                                                                                                                                               
  --input feedModelId=0e829358-6f1c-4172-8a09-2ec9f8923a39 \                                                                                                                                                                                                                                                                                     
  --input repo=external-secrets/external-secrets \                                                                                                                                                                                                                                                                                               
  --input limit=5000 \                                                                                                                                                                                                                                                                                                                           
  --input includeBots=true \                                                                                                                                                                                                                                                                                                                     
  --input 'personalGithubHandles:json=["evrardjp","evrardj-roche"]'                                                                                                                                                                                                                                                                              
                                                                                                                                                                                                                                                                                                                                                 
swamp report get @evrardjp/maintainer-briefing \                                                                                                                                                                                                                                                                                                 
  --model maintainer-activity \                                                                                                                                                                                                                                                                                                                  
  --markdown                                                                                                                                                                                                                                                                                                                                     
```    

Use `swamp report get ... --json` when an agent needs to filter or drill down
programmatically. Only use the stored report without refreshing when you
explicitly want cached data.

The report currently surfaces:

- urgent/noteworthy work items
- security-relevant items
- blocked or needs-input items
- CI attention
- inactive items
- recent lifecycle/agent events
- recent session logs

It is a maintainer briefing view, not a full PR review queue yet. Planned useful
additions include sections for "needs my code fixes", "ready for maintainer
review", "quick wins", "needs maintainer decision", and "author action needed".

## Bundled maintainer skill

The Pi/agent-facing maintainer workflow lives in:

```text
maintainer-daily-briefing/SKILL.md
```

It tells agents how to fetch `@evrardjp/maintainer-briefing`, drill into a
PR/issue, and record durable conclusions through `record_pi_session_finding`.
It is included as an extension additional file for now. Registering it as a
first-class Swamp `skills:` manifest entry currently requires a Swamp repo with a
supported enrolled skill tool; this repo is primarily using Pi, so keeping the
skill file alongside the extension avoids breaking extension validation while
still keeping the procedure versioned with the model/report it operates.

## Development checks

```bash
deno check models/maintainer_activity.ts reports/maintainer_briefing.ts
swamp extension fmt manifest.yaml --check --repo-dir /path/to/swamp-repo
TMPDIR=/tmp swamp extension push manifest.yaml --dry-run --json --repo-dir /path/to/swamp-repo
```

Never publish without explicit maintainer approval.
