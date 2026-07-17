# @evrardjp/capability-caddy-sites

Converts capability catalog `exposes` metadata into site inputs accepted by
`@evrardjp/caddy`.

## Model Type

`@evrardjp/capability-caddy-sites`

The `render` method reads selected capabilities from a capability catalog,
expands `@{vm.FIELD}` placeholders, and publishes normalized Caddy sites. It
does not apply Caddy configuration itself.

Use it with `@evrardjp/capability-orchestrator` and `@evrardjp/caddy`.

## Capability Metadata

```yaml
exposes:
  - name: api
    listen: TCP:@{vm.ipAddress}:8200
    upstreamScheme: https
    tlsInsecureSkipVerify: false
    public:
      fqdn: api.example.test
      listen: TCP:0.0.0.0:443
      scheme: https
      tls: internal
```

Render one or more selected capabilities for a VM:

```bash
swamp model method run lab-host-caddy-sites render \
  --input catalogModelName=lab-capability-catalog \
  --input capabilities='["api"]'
```

The adapter validates endpoint syntax, requires explicit upstream TLS
verification behavior, and supports VM placeholder expansion in nested expose
metadata. It emits only normalized site definitions. Deployment remains the
responsibility of `@evrardjp/caddy`, keeping capability-domain concerns out of
the generic proxy model and allowing the rendered artifact to be inspected
before any target host is modified.
