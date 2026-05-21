# openbao-configurator

A [swamp](https://github.com/systeminit/swamp) extension that deploys and manages [OpenBao](https://openbao.org/) over SSH — from first config deploy through the full seal/unseal lifecycle. All state is tracked as swamp resources and wired together with CEL expressions.

## What it does

- Renders an OpenBao HCL config (raft storage, TCP listener, TLS, UI toggle, cluster/API addresses)
- Deploys the config via SCP and installs it at the configured path
- Ensures the storage directory exists with correct ownership
- Restarts the `openbao` systemd service and verifies it is active
- Initializes a fresh OpenBao instance and stores all unseal keys and root token in a swamp vault
- Submits unseal key shares one at a time (designed for distributed workflows where each repo holds one key)
- Seals a running instance via the root token
- Records all state as swamp resources for use in downstream models and CEL expressions

## Prerequisites

- [swamp](https://github.com/systeminit/swamp) installed and initialized (`swamp init`)
- SSH access to the target host with a user that has passwordless `sudo`
- OpenBao installed on the target host (the `openbao` user and systemd unit must exist)

## Installation

Pull the extension from the registry:

```sh
swamp extension pull @evrardjp/openbao-configurator
```

## Usage

### Create a model instance

```sh
swamp model create my-bao \
  --type @evrardjp/openbao-configurator \
  --arg host=192.168.1.10 \
  --arg sshUser=admin \
  --arg sshKeyPath=~/.ssh/id_ed25519
```

### Verify SSH connectivity

```sh
swamp model check run my-bao ssh-reachable
```

### Deploy the configuration

```sh
swamp model method run my-bao deploy \
  --arg listener.address=0.0.0.0:8200 \
  --arg clusterAddr=https://192.168.1.10:8201 \
  --arg apiAddr=https://192.168.1.10:8200
```

With TLS disabled (e.g. for a dev environment):

```sh
swamp model method run my-bao deploy \
  --arg listener.address=0.0.0.0:8200 \
  --arg listener.tlsDisable=true \
  --arg clusterAddr=http://192.168.1.10:8201 \
  --arg apiAddr=http://192.168.1.10:8200 \
  --arg ui=true
```

### Initialize OpenBao

Run once after the first `deploy` to generate unseal keys and a root token. All secrets are stored in a swamp vault:

```sh
swamp model method run my-bao initialize \
  --arg vaultName=openbao-creds \
  --arg keyShares=5 \
  --arg keyThreshold=3
```

### Unseal OpenBao

Submit one key share per call. Repeat until the threshold is reached:

```sh
swamp model method run my-bao unseal \
  --arg unsealKey="$(swamp vault get openbao-creds OPENBAO_UNSEAL_KEY_1)"
```

In a distributed workflow, supply the key via a CEL vault expression in your model YAML so each participant contributes their own share without ever seeing the others.

### Seal OpenBao

```sh
swamp model method run my-bao seal \
  --arg token="$(swamp vault get openbao-creds OPENBAO_ROOT_TOKEN)"
```

### Inspect the deployed state

```sh
swamp model get my-bao --json
```

### Use the deployed config in a downstream model

Reference the recorded state with CEL expressions:

```
data.latest("my-bao", "config").attributes.apiAddr
data.latest("my-bao", "initState").attributes.vaultName
data.latest("my-bao", "unseal").attributes.sealed
```

## Configuration reference

### Global arguments (set on the model)

| Argument     | Default                        | Description                                                                 |
|--------------|--------------------------------|-----------------------------------------------------------------------------|
| `host`       | *(required)*                   | SSH host IP or hostname                                                     |
| `sshUser`    | `admin`                        | SSH user                                                                    |
| `sshKeyPath` | `~/.ssh/id_ed25519`            | Path to SSH private key                                                     |
| `apiAddr`    | `https://<host>:8200`          | OpenBao API address for `bao` CLI commands (used by initialize/unseal/seal) |

### `deploy` method arguments

| Argument              | Default                        | Description                                         |
|-----------------------|--------------------------------|-----------------------------------------------------|
| `ui`                  | `false`                        | Enable the OpenBao web UI                           |
| `storage.path`        | `/var/lib/openbao/data`        | Raft storage data directory                         |
| `storage.nodeId`      | `vault-node-1`                 | Raft node identifier                                |
| `listener.address`    | *(required)*                   | Listener address in `host:port` format              |
| `listener.tlsDisable` | `false`                        | Disable TLS on this listener                        |
| `listener.tlsCertFile`| `/etc/openbao/tls/openbao.crt` | Path to TLS certificate on the remote host          |
| `listener.tlsKeyFile` | `/etc/openbao/tls/openbao.key` | Path to TLS private key on the remote host          |
| `clusterAddr`         | *(required)*                   | Cluster advertise address (e.g. `https://host:8201`)|
| `apiAddr`             | *(required)*                   | API advertise address (e.g. `https://host:8200`)    |
| `configPath`          | `/etc/openbao/openbao.hcl`     | Remote path for the deployed HCL config file        |

### `initialize` method arguments

| Argument        | Default          | Description                                               |
|-----------------|------------------|-----------------------------------------------------------|
| `vaultName`     | `openbao-creds`  | Swamp vault where unseal keys and root token will be stored |
| `keyShares`     | `5`              | Total number of unseal key shares to generate             |
| `keyThreshold`  | `3`              | Minimum key shares required to unseal                     |

Stored secrets: `OPENBAO_UNSEAL_KEY_1` … `OPENBAO_UNSEAL_KEY_N` and `OPENBAO_ROOT_TOKEN`.

### `unseal` method arguments

| Argument     | Default      | Description                                                          |
|--------------|--------------|----------------------------------------------------------------------|
| `unsealKey`  | *(required)* | One unseal key share — use a vault expression for distributed setups |

### `seal` method arguments

| Argument  | Default      | Description                                           |
|-----------|--------------|-------------------------------------------------------|
| `token`   | *(required)* | Root token — use a vault expression in model YAML     |

## Development

The extension source lives in `extensions/models/openbao_configurator.ts`. To iterate locally:

```sh
# Bundle and smoke-test against the local swamp daemon
swamp extension bundle
swamp model create test-bao --type @evrardjp/openbao-configurator --arg host=...
```

See the [swamp extension docs](https://github.com/systeminit/swamp) for the full development workflow.

## License

MIT — see [LICENSE](LICENSE.txt).
