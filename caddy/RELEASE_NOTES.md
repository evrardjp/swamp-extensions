## 2026.07.20.1

**Added:** Initial release of `@evrardjp/caddy`, with reverse-proxy JSON
rendering, Caddy-native validation, and remote Docker Compose deployment over
SSH.

**Added:** Upstream transport configuration requires an explicit decision about
TLS certificate verification.

**Fixed:** Remote paths and file content are safely encoded, HTTP-only sites
honor disabled TLS, and failed Compose startup no longer removes a running
proxy.
