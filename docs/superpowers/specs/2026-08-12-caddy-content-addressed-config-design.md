# Caddy Content-Addressed Config Design

## Goal

Fix issue 44 by replacing mutable `current` receipts with durable configuration
artifacts and relying on swamp's method outputs for execution status.

## Data Model

The extension will declare only the `config` resource. A rendered configuration
will use the lowercase hexadecimal SHA-256 digest of its exact `configJson` as
its instance name. The resource content will retain `config`, `configJson`,
`sites`, and `warnings`; it will drop `timestamp` because swamp records artifact
creation time.

Rendering identical JSON will address the same data name. Swamp may create a new
version under that name because the extension API cannot return a handle for an
existing artifact. This preserves deterministic identity without bypassing
swamp's data API.

The `validation` and `apply` resources will be removed. Swamp's method output
already records method arguments, success or failure, errors, timestamps, and
produced data handles, so separate receipt resources duplicate runtime metadata.

## Methods

`renderReverseProxy({ sites })` renders Caddy JSON and writes one content-addressed
`config` artifact.

`validateConfig({ configName })` reads that exact stored config resource and
validates its `configJson`. It returns no data handles. It throws a clear error
when the artifact is absent, malformed, or rejected by Caddy.

`applyConfig({ configName })` reads that exact stored config resource, validates
its `configJson`, then performs the existing remote write, Compose update, and
Caddy reload. It returns no data handles. Swamp's method output is the application
record.

`applyReverseProxy({ sites })` renders and writes one config artifact, then
validates and applies the exact same in-memory JSON. It returns only the config
handle. This avoids reading an artifact that was just produced while preserving
the same validation and application path as `applyConfig`.

Only artifacts produced by `renderReverseProxy` or `applyReverseProxy` are
accepted. The extension will not add an arbitrary JSON import method.

## Compatibility

This intentionally breaks the API:

- `validateConfig` and `applyConfig` replace `configJson` with `configName`.
- The `validation` and `apply` resource specs and outputs are removed.
- Config instance names change from `current` to a SHA-256 digest.
- Config resource content removes `timestamp`.

The model and manifest versions will be bumped to the next CalVer release.
`RELEASE_NOTES.md` will explicitly tell callers to render a config first, pass
the resulting config name to validation or apply, and use swamp method outputs
instead of validation/apply receipt resources.

## Error Handling

Artifact lookup happens before validation or remote side effects. Missing or
malformed config artifacts fail immediately. Validation remains before all SSH
operations. Existing SSH, Compose, and Caddy reload errors continue to propagate
to swamp, which records the failed method output.

## Tests

Regression coverage will verify:

- identical rendered JSON produces the same SHA-256 instance name;
- changed rendered JSON produces a different name;
- standalone validation and apply read the requested artifact;
- missing artifacts fail before commands run;
- validation and apply write no receipt resources;
- `applyReverseProxy` returns one uniquely named config handle;
- existing remote path quoting, UTF-8 writes, command ordering, and failure
  behavior remain intact.
