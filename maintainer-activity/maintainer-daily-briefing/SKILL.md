---
name: "maintainer-daily-briefing"
description: "Use Swamp maintainer activity data and reports to brief the user on urgent repository maintenance work and record agent-session context"
version: 1
created: "2026-06-16"
updated: "2026-06-16"
---
## When to Use
Use when the user asks for a daily maintainer briefing, urgent matters, important reviews/work, what issue/PR to tackle next, a PR/issue drill-down, or asks to persist maintainer-session conclusions/logs. Do not query GitHub directly unless explicitly refreshing through Swamp workflows/models.

## Procedure
1. Locate the maintainer Swamp repository with `MAINTAINER_SWAMP_REPO="${SWAMP_MAINTAINER_REPO:-$HOME/git/evrardjp/local-infra}"` and run Swamp commands from that directory, regardless of the current project cwd.
2. Start by reading the Swamp skill in that repo if available, then fetch the latest briefing with `swamp report get @evrardjp/maintainer-briefing --model maintainer-activity --json` and/or `--markdown`.
3. If the briefing is missing or stale, offer to run the relevant Swamp refresh workflow/model rather than querying GitHub directly.
4. For repo-wide questions, answer from the briefing JSON: urgent items, blocked/maintainer-input-needed items, security-relevant items, CI attention, inactive items, and good next tasks for the user's time budget.
5. For a PR/issue drill-down, filter the briefing JSON by repo + item type + number and include lifecycle events from GitHub, Swamp, manual notes, and Pi agent-session events.
6. When the current conversation produces an actionable maintainer conclusion, record a concise distilled finding with `record_pi_session_finding`. Include the Pi `sessionId` when available so `relatedSessionId` links back to `@evrardjp/pi-session-telemetry`.
7. When the user asks to preserve the whole conversation/session for later, use `record_pi_session_finding` with `recordSessionLog: true` for Pi-originated findings, or `record_session_log` directly for non-Pi/imported session artifacts.
8. Before continuing a long-running discussion about a specific item, compare the latest Swamp data timestamps/revision with what is in the conversation. If stale, tell the user and refresh via Swamp.

## Pitfalls
- Do not assume the current working directory is the Swamp repo; always cd/use the configured maintainer Swamp repo path.
- Do not store maintainer operational state in Hermes/Pi memory; store it in Swamp. Hermes memory is only for durable assistant behavior preferences/conventions.
- Do not rely on CLI `--resume` as the maintainer memory; Swamp session logs and lifecycle events are the persistent operational memory.
- Do not treat PR review as a special workflow yet. Review-helper behavior is planned later; for now, any agent prompt can feed useful conclusions into Swamp lifecycle/session data.

## Verification
1. `swamp report get @evrardjp/maintainer-briefing --model maintainer-activity --json` returns structured data or a clear missing/stale state.
2. Recorded Pi findings appear in later maintainer briefing or PR/issue drill-down reports with `source: pi-agent-session` and `relatedSessionId` populated when available.
3. No direct GitHub API/CLI queries are used except through explicit Swamp refresh operations.