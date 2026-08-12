## 2026.08.12.1

**Changed:** Rendered Caddy configurations now use their SHA-256 digest as the
artifact name, so validation and deployment refer to exact configuration
content instead of mutable `current` outputs.

**Changed:** Validation and apply results are recorded by swamp method outputs;
the redundant `validation` and `apply` data resources are no longer produced.

**Fixed:** Compound apply methods no longer return duplicate data instance names
after successfully updating the remote Caddy service.

**Upgrade note:** `validateConfig` and `applyConfig` now require `configName`
instead of `configJson`. Run `renderReverseProxy` first and pass its config
artifact name. Replace consumers of `validation/current` and `apply/current`
with the corresponding swamp method output or `@swamp/method-summary` report.
