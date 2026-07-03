# @evrardjp/pi-session-telemetry

Privacy-safe Pi coding-agent telemetry for Swamp.

This extension stores real Pi agent activity as Swamp data so agent usage can be
reported, audited, and summarized without scraping Pi JSONL session files. It is
intended to create useful, non-spammy Swamp events from normal agent work.

## Architecture

```text
Pi extension / integration
  -> swamp model method run pi-session-telemetry ingest_batch
  -> @evrardjp/pi-session-telemetry model
  -> Swamp data resources
  -> @evrardjp/pi-session-report
```

The model is a high-volume observability sink. It should not decide which events
matter to a maintainer. For curated maintainer state, use
`@evrardjp/github-project-activity` and bridge selected findings with its
`record_pi_session_finding` method.

## Swamp model

Model type: `@evrardjp/pi-session-telemetry`

Recommended instance name:

```bash
swamp model create @evrardjp/pi-session-telemetry pi-session-telemetry
```

Privacy-sensitive capture is disabled by default. Opt in only for private repos:

```bash
swamp model create @evrardjp/pi-session-telemetry pi-session-telemetry \
  --global-arg includeContent=true \
  --global-arg includeToolPayloads=true \
  --global-arg includePaths=true
```

Global arguments:

- `includeContent=false` — stores prompt/message text, raw payloads, images, and
  session snapshots only when true.
- `includeToolPayloads=false` — stores tool arguments/results/details only when
  true.
- `includePaths=false` — stores `cwd` and `sessionFile` only when true.

## Generated Swamp data

The model writes these resource specs:

- `event` — one normalized Pi event envelope.
- `prompt` — prompt/input metadata from `input` and `before_agent_start` events.
- `message` — conversation message metadata from `message_end` events.
- `toolExecution` — tool start/update/end phases.
- `usage` — token and cost usage extracted from assistant messages.
- `sessionSnapshot` — session tree/branch snapshot, only useful when content is
  opted in.
- `batch` — summary for each ingested batch.

Example event input:

```bash
swamp model method run pi-session-telemetry ingest \
  --input 'event:json={
    "id":"evt-example-1",
    "sessionId":"session-example",
    "type":"message_end",
    "timestamp":"2026-06-17T00:00:00.000Z",
    "cwd":"/home/me/project",
    "data":{
      "role":"assistant",
      "model":"example-model",
      "contentText":"redacted unless includeContent=true",
      "contentHash":"sha256:abc",
      "usage":{"input":100,"output":20,"totalTokens":120,"cost":{"total":0.01}}
    }
  }'
```

With default privacy settings, stored `event` data keeps metadata and hashes but
removes content and local paths. A generated `usage` resource resembles:

```json
{
  "id": "evt-example-1",
  "sessionId": "session-example",
  "provider": "openai-codex",
  "model": "gpt-5.5",
  "input": 100,
  "output": 20,
  "totalUsageCount": 120,
  "costTotal": 0.01
}
```

## Reports

Run the model-scope report:

```bash
swamp report get @evrardjp/pi-session-report \
  --model pi-session-telemetry \
  --markdown
```

The report summarizes:

- event counts by type
- sessions
- tools
- models selected
- message roles
- token/cost usage
- tool errors
- recent messages, showing hashes unless content capture is enabled

## Development checks

```bash
deno test models/pi_session_telemetry_test.ts
swamp extension fmt manifest.yaml --check --repo-dir /path/to/swamp-repo
TMPDIR=/tmp swamp extension push manifest.yaml --dry-run --json --repo-dir /path/to/swamp-repo
```

Never publish without explicit maintainer approval.
