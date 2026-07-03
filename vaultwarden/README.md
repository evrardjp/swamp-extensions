# @evrardjp/vaultwarden

Swamp helper extension for [Vaultwarden](https://github.com/dani-garcia/vaultwarden).

This extension does **not** SSH to hosts, copy files, write compose files, start
containers, or manage systemd. Use cfgmgmt/container extensions for deployment:

- directory/file/template extensions for data, certs, and env files
- a certificate extension for TLS material
- a container/systemd extension for the Vaultwarden service

This model keeps Vaultwarden-specific helper logic in one place: discover the
upstream `.env.template`, render `.env` content from overrides, and verify the
published `/alive` endpoint.

## Model

- Package: `@evrardjp/vaultwarden`
- Type: `@evrardjp/vaultwarden`
- File: `vaultwarden.ts`

## Global arguments

| Argument | Required | Description |
| --- | --- | --- |
| `version` | no | Vaultwarden image tag and upstream template branch/tag; default `latest` |
| `fqdn` | yes | Public FQDN for `DOMAIN` and health checks, for example `vaultwarden.example.com` |
| `baseUrl` | no | External base URL; defaults to `https://<fqdn>` |

Example model:

```yaml
type: '@evrardjp/vaultwarden'
name: vaultwarden-config
globalArgs:
  version: latest
  fqdn: vaultwarden.example.com
```

## Methods

### `discover`

Fetch and parse the upstream `.env.template` into an `envTemplate/current` data
snapshot.

```bash
swamp model method run vaultwarden-config discover
```

### `render-env`

Render a Vaultwarden `.env` file from the upstream template and caller-provided
overrides. The result is data-only; another extension should write it to the
host/container runtime.

```bash
swamp model method run vaultwarden-config render-env \
  --input 'envVars:json={"SIGNUPS_ALLOWED":"false","ADMIN_TOKEN":"..."}'
```

Use the rendered content from CEL:

```text
data.latest("vaultwarden-config", "envFile").attributes.envFile
```

### `verify`

Check the HTTP `/alive` endpoint and record `verification/current`.

```bash
swamp model method run vaultwarden-config verify
```

Override the URL when needed:

```bash
swamp model method run vaultwarden-config verify \
  --input url=https://vaultwarden.example.com/alive
```

## Data outputs

- `envTemplate/current` — parsed upstream environment variable catalog
- `envFile/current` — rendered `.env` content and applied keys
- `verification/current` — HTTP health check result

## License

MIT — see [LICENSE.txt](LICENSE.txt).
