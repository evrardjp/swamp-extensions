# swamp-extensions

Personal Swamp extensions maintained by evrardjp.

## Layout

This repository uses one publishable extension per subdirectory. Each extension
has its own `manifest.yaml` and uses `paths.base: manifest`, so files resolve
relative to that extension directory.

```text
swamp-extensions/
  pi-session-telemetry/
    manifest.yaml
    README.md
    LICENSE.txt
    models/
    reports/
  github-project-activity/
    manifest.yaml
    README.md
    LICENSE.txt
    models/
    reports/
  github-local-mirror/
    manifest.yaml
    README.md
    LICENSE.txt
    models/
    reports/
  libvirt-vm-pool/
    manifest.yaml
    README.md
    LICENSE.txt
    models/
  capability-orchestrator/
    manifest.yaml
    README.md
    LICENSE.txt
    models/
  selfcert/
    manifest.yaml
    README.md
    LICENSE.txt
    selfcert.ts
```

This is preferable to one giant manifest because each extension can be versioned,
quality-checked, reviewed, and published independently.

## Extensions

### `@evrardjp/pi-session-telemetry`

High-volume Pi agent telemetry sink. Stores normalized Pi events, message/tool
metadata, token/cost usage, and session summaries. Prompt text, tool payloads,
and local paths are opt-in.

Use it for observability and reporting over real Pi usage.

### `@evrardjp/github-project-activity`

Low-volume maintainer ledger. Stores curated PR/issue lifecycle events,
classifications, CI attention records, and distilled Pi agent-session findings.

Use it for daily maintainer briefings and PR/issue drill-downs.

### `@evrardjp/github-local-mirror`

Local GitHub mirror for maintainers and agents. It keeps a local git object
cache plus Swamp-indexed PRs, issues, comments, reviews, checks, patch revision
metadata, and local review worktree analysis.

Use it when you want frequent lightweight syncs, durable local PR/issue context,
and editable worktrees for human or agent review/fix workflows.

### `@evrardjp/libvirt-vm-pool`

Desired-state local libvirt VM pool reconciler. It owns VM substrate lifecycle
(domain/disk/seed/power state) and writes per-VM connection facts as Swamp data
for downstream SSH/config/app models.

Use it as the first phase of homelab workflows before applying base config and
app-specific guarantees.

### `@evrardjp/capability-orchestrator`

Capability catalog and DAG planner models. The catalog publishes manually
maintained capability definitions; the planner combines those definitions with
VM pool data and emits ordered execution waves for Swamp workflows.

### `@evrardjp/selfcert`

Self-signed TLS certificate generator. Creates RSA-4096 certificates locally and
stores certificate/private-key PEM data in a Swamp vault for downstream service
configuration.

## Relationship between the two

```text
Pi usage
  -> @evrardjp/pi-session-telemetry
  -> raw/metadata event stream and usage report

Maintainer-relevant conclusion from a Pi session
  -> @evrardjp/github-project-activity record_pi_session_finding
  -> daily briefing / PR drill-down
```

Do not mirror every Pi event into maintainer activity. Bridge only durable,
actionable conclusions.

## Local development from another Swamp repo

From a Swamp repository, add all extension subdirectories as sources:

```bash
swamp extension source add "/var/home/evrardjp/git/evrardjp/swamp-extensions/*"
swamp extension source list --json
```

Run checks against a Swamp repo with:

```bash
swamp extension fmt /var/home/evrardjp/git/evrardjp/swamp-extensions/pi-session-telemetry/manifest.yaml \
  --check --repo-dir /path/to/swamp-repo

TMPDIR=/tmp swamp extension push /var/home/evrardjp/git/evrardjp/swamp-extensions/pi-session-telemetry/manifest.yaml \
  --dry-run --json --repo-dir /path/to/swamp-repo
```

Never publish without explicit maintainer approval.
