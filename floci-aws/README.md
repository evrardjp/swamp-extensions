# @evrardjp/floci-aws

Swamp models and protocol tests for the [Floci](https://floci.io/floci/) local
AWS emulator. Phase 1 covers endpoint health and S3 bucket/object lifecycle.

The extension uses a minimal fetch-based, SigV4-signed, path-style S3 protocol
client. Model methods do not invoke `aws`, `curl`, shell wrappers, or the AWS
SDK. Credentials come from sensitive model arguments or the standard AWS
environment variables, defaulting to Floci's conventional `test` credentials;
they are never persisted. Object bodies are reduced to a SHA-256 digest and byte
count before persistence.

## Models

- `@evrardjp/floci-aws/health`: `status`
- `@evrardjp/floci-aws/s3-bucket`: `create`, `head`, `sync`, `delete`
- `@evrardjp/floci-aws/s3-object`: `put`, `head`, `get`, `list`, `delete`,
  `deletePrefix`

Object `put`, `head`, and `get` support `ifMatch`/`ifNoneMatch`; `delete`
supports `ifMatch`. Conditional failures include the HTTP status and a bounded
S3 error response, without request bodies or credentials.

## Local use

```bash
swamp extension pull @evrardjp/floci-aws

# Or use the source tree during development:
swamp extension source add /path/to/swamp-extensions/floci-aws
swamp model create @evrardjp/floci-aws/s3-bucket demo-bucket \
  --global-arg endpoint=http://127.0.0.1:4566 \
  --global-arg region=us-east-1 \
  --global-arg bucket=demo-bucket
swamp model method run demo-bucket create
```

The bundled `@evrardjp/floci-aws-smoke` workflow creates and heads a bucket,
puts, heads, and gets an object, then deletes the object and bucket. It uses
`data.latest("floci-smoke-object", "state")` to pass the observed ETag into the
conditional get.

## Tests

```bash
deno task check
deno task lint
deno task fmt
deno task test
deno task e2e
```

`deno task e2e` requires Docker and the real `swamp` binary. It defaults to the
pinned `floci/floci:1.5.11` image; override with `FLOCI_IMAGE`. The suite starts
Floci in persistent mode, uses temporary Swamp repositories and local extension
sources, runs lifecycle calls, validates the bundled workflow, configures
`@swamp/s3-datastore`, checks sync/rehydration and lock outcomes, restarts
Floci, and removes containers and temporary repositories.

Set `FLOCI_ENDPOINT` to run the same suite against an existing Floci deployment.
External mode leaves container lifecycle management to the operator and removes
its temporary S3 buckets and objects through the extension models.

On a direct wire-protocol failure, the test writes a Floci-classified draft
under `artifacts/`. Workflow, datastore, or Swamp runtime failures receive a
separate Swamp integration classification. The known bundled AWS SDK discrepancy
is documented in `issue-drafts/swamp-extension-aws-sdk-bundling.md`. Tests never
submit issues.

The official `@swamp/aws/s3` package remains the preferred general AWS model.
This extension is deliberately scoped to Floci compatibility and should move
fixes upstream whenever practical.
