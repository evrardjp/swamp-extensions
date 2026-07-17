# @evrardjp/opencode-session-archive

Long-term OpenCode session analytics and native conversation archives in Swamp.

This package contains a Swamp model, generic webhook workflow, overview report,
and an OpenCode plugin source file. Installing the Swamp extension does not
install or enable the OpenCode plugin.

## Data flow

```text
OpenCode session.idle or swamp_archive_session tool
  -> signed generic swamp serve webhook
  -> @evrardjp/opencode-session-ingest workflow
  -> @evrardjp/opencode-session-archive model
  -> session metadata + optional native JSON archive
  -> @evrardjp/opencode-session-overview report
```

The archive is OpenCode's native `{ "info": ..., "messages": [...] }` export
shape. It can be passed back to `opencode import` without transcript conversion.
The webhook carries that object as one sensitive JSON string, so Swamp's generic
method-summary report redacts it instead of duplicating full transcripts.

## Privacy defaults

- Session titles and aggregate usage are stored.
- Prompt text is not included in analytics unless `includeDiscussionText` is
  explicitly enabled.
- Local directories are omitted unless `includeDirectory` is enabled.
- Full transcripts are archived only when a title contains `[archive]`, or when
  the `swamp_archive_session` tool is invoked.
- Swamp metadata and archives have an infinite lifetime. The latest 100 metadata
  versions and latest 20 archive versions per session are retained.

Archives contain the complete conversation, including tool payloads, file parts,
and reasoning parts supplied by OpenCode. Protect the Swamp repository and its
datastore accordingly.

## Setup when ready

Pull the extension and create the model:

```bash
swamp extension pull @evrardjp/opencode-session-archive
swamp model create @evrardjp/opencode-session-archive opencode-sessions
```

Run `swamp serve` with a generic webhook. Keep the token out of argv:

```bash
export OPENCODE_SWAMP_WEBHOOK_TOKEN='replace-with-a-long-random-token'
swamp serve \
  --webhook '/hooks/opencode:@evrardjp/opencode-session-ingest:@env=OPENCODE_SWAMP_WEBHOOK_TOKEN:generic:x-opencode-swamp-token:Bearer '
```

Copy `opencode/opencode_swamp_exporter.ts` from the pulled package into an
OpenCode plugin directory only when you want to enable it. Configure it as a
plugin tuple, preferably using a file URL or a path outside the active project:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///path/to/opencode_swamp_exporter.ts",
      {
        "endpoint": "http://127.0.0.1:9090/hooks/opencode",
        "tokenEnv": "OPENCODE_SWAMP_WEBHOOK_TOKEN",
        "archivePolicy": "tagged",
        "archiveTitleTag": "[archive]",
        "includeDiscussionText": false,
        "includeDirectory": false
      }
    ]
  ]
}
```

The OpenCode process and `swamp serve` process must receive the same token value.
Restart OpenCode after enabling or changing the plugin.

## Archiving sessions

With `archivePolicy: "tagged"`, rename a session so its title contains
`[archive]`; its next idle export includes the full native archive. The plugin
also exposes `swamp_archive_session`, which can archive the current session or a
specific still-available session ID immediately.

Policy choices:

- `none`: metadata only unless the manual archive tool is invoked.
- `tagged`: archive tagged sessions; this is the default.
- `all`: archive every exported session.

Set `includeDiscussionText: true` to store bounded user-prompt excerpts in the
metadata and report. The full archive is unaffected by this setting.

## Finding and restoring an archive

The overview report shows recent titles, discussion excerpts, and archive data
names:

```bash
swamp report get @evrardjp/opencode-session-overview \
  --model opencode-sessions \
  --markdown
```

Find a session or archive with Swamp data queries:

```bash
swamp data query \
  'modelName == "opencode-sessions" && specName == "session" && (attributes.title.contains("webhook") || attributes.sessionID == "ses_example")'
swamp data list opencode-sessions
```

Retrieve the `archive-<sessionID>` content as `session.json`, then import it:

```bash
swamp data get opencode-sessions archive-ses_example --json \
  | jq '.content' > session.json
opencode import session.json
```

## Development

All tests use synthetic sessions and never read OpenCode's local datastore:

```bash
deno task check
deno task lint
deno task fmt
deno task test
swamp workflow validate @evrardjp/opencode-session-ingest --json
swamp extension fmt manifest.yaml --check
swamp extension quality manifest.yaml
```
