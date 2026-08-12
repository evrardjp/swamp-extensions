# @evrardjp/caddy

Renders Caddy JSON for reverse-proxy sites, validates it with Caddy, and can
apply it to a remote Docker host over SSH.

## Model Type

`@evrardjp/caddy`

Rendering is local and side-effect free. Validation requires either `caddy` or
`docker` locally. Apply methods require an SSH-accessible target with Docker
Compose and replace the managed Caddy configuration in `workDir`.

Every upstream explicitly selects whether TLS certificate verification may be
skipped.

## Example

```yaml
globalArguments:
  nodeHost: 192.0.2.10
  nodeUser: admin
  workDir: /home/admin/caddy
  containerImage: caddy:2-alpine
```

Render a site without touching the target host:

```yaml
sites:
  - address: service.example.test
    tls: internal
    reverseProxy:
      upstreams:
        - https://127.0.0.1:8200
      transport:
        tlsInsecureSkipVerify: false
```

`renderReverseProxy` creates an inspectable config artifact named by the
SHA-256 digest of its JSON content. Pass that artifact's `configName` to
`validateConfig` or `applyConfig`; their swamp method outputs record success or
failure metadata. Use `applyReverseProxy` for the combined render, validate, and
apply operation when the target is ready.

Apply creates a managed Compose file and bootstrap configuration, starts the
Caddy container, and loads the final JSON through the loopback admin API.
Existing files under the configured `workDir` with the same managed names are
replaced.
