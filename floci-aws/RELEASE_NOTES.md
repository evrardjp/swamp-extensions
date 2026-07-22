## 2026.07.21.1

**Added:** Fetch-based Floci health, S3 bucket, and S3 object models with typed
persisted observations, conditional object operations, and a bundled S3
lifecycle workflow. Prefix deletion supports bounded fan-out cleanup with
explicit truncation reporting.

**Added:** Local and CI protocol coverage using a pinned Floci container, the
real Swamp CLI, and `@swamp/s3-datastore` rehydration checks. `FLOCI_ENDPOINT`
runs the same suite against an operator-managed deployment without controlling
its lifecycle.

**Changed:** Floci-specific models use direct path-style HTTP rather than the
AWS SDK, isolating tests from a Swamp extension-bundling SDK incompatibility.

**Upgrade note:** This is the initial release. Docker is required only for the
`deno task e2e` protocol suite.
