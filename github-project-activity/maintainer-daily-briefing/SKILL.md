---
name: "maintainer-daily-briefing"
description: "Use Swamp maintainer activity data and reports to brief the user on urgent repository maintenance work and record agent-session context"
version: 2
created: "2026-06-16"
updated: "2026-07-02"
---
## When to Use
Use when the user asks for a daily maintainer briefing, urgent matters, important reviews/work, what issue/PR to tackle next, a PR/issue drill-down, or asks to persist maintainer-session conclusions/logs. Do not query GitHub directly unless explicitly refreshing through Swamp workflows/models.

## Procedure
1. Locate the maintainer Swamp repository with `MAINTAINER_SWAMP_REPO="${SWAMP_MAINTAINER_REPO:-$HOME/git/evrardjp/local-infra}"` and run Swamp commands from that directory, regardless of the current project cwd.
2. Start by reading the Swamp skill in that repo if available. Remember the distinction: `github-project-activity` is the model instance/data ledger; `@evrardjp/github-project-briefing` is a report view over that model data.
3. For daily/project maintainer reports, refresh Swamp data first unless the user explicitly asks for cached data. Prefer the project activity methods: `swamp model method run <activity-model> sync_github_recent_activity`, or for repair/backfill use `sync_github_backfill` with a bounded `since`/`until` window.
4. Fetch the refreshed briefing with `swamp report get @evrardjp/github-project-briefing --model <activity-model> --json` and/or `--markdown`.
5. If refresh fails or the briefing is missing/stale, offer to run the relevant Swamp refresh workflow/model rather than querying GitHub directly.
6. For repo-wide questions, answer from the briefing JSON: open PRs with failing CI, requested changes, merge conflicts, stale PRs/issues, and recent activity events.
7. For a PR/issue drill-down, filter the briefing JSON by repo + subject type + number, or run `render_pr_report` for a timeline-first PR dossier.
8. When the current conversation produces an actionable maintainer conclusion, record a concise private event with `record_activity`. Use `source: "pi-agent"` or `source: "manual"`, `visibility: "private"`, and include an artifact reference if there is a longer transcript/log.
9. When the user asks to preserve a whole conversation/session/log for later, store the large content with `record_artifact`, then record a short `record_activity` event pointing to that artifact in `artifactRefs`.
10. Before continuing a long-running discussion about a specific item, compare the latest Swamp data timestamps/revision with what is in the conversation. If stale, tell the user and refresh via Swamp.

## Pitfalls
- Do not assume the current working directory is the Swamp repo; always cd/use the configured maintainer Swamp repo path.
- Do not store maintainer operational state in Hermes/Pi memory; store it in Swamp. Hermes memory is only for durable assistant behavior preferences/conventions.
- Do not rely on CLI `--resume` as the maintainer memory; Swamp artifacts and activity events are the persistent operational memory.
- Use the current project activity model surface: snapshots, `activityEvent`, and artifacts.

## Verification
1. The relevant project activity sync completes before showing a daily/project briefing, unless the user explicitly requested cached data.
2. `swamp report get @evrardjp/github-project-briefing --model <activity-model> --json` returns structured data or a clear missing/stale state.
3. Recorded private findings appear in later maintainer briefing or PR drill-down reports as `activityEvent` entries with `visibility: private`.
4. No direct GitHub API/CLI queries are used except through explicit Swamp refresh operations.
