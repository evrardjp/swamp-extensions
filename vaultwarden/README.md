# @evrardjp/vaultwarden

Vaultwarden lifecycle management for swamp.

Deploy and manage a [Vaultwarden](https://github.com/dani-garcia/vaultwarden) docker-compose stack over SSH.

## Usage

```yaml
type: '@evrardjp/vaultwarden'
arguments:
  version: latest
  host: 192.168.1.10
  fqdn: vaultwarden.example.local
  sshUser: admin
  sshKeyPath: ~/.ssh/id_ed25519
  workDir: /opt/vaultwarden
```

## Methods

- `discover` — Fetch and parse the upstream `.env.template` from vaultwarden GitHub.
- `deploy` — Upload files and start the docker-compose stack with health checks.
- `configure` — Update env vars and force-recreate the container.
- `verify` — Check SSH docker ps and curl health endpoint.
