# openbao-configurator

Swamp extension for OpenBao configuration rendering and lifecycle control
through the OpenBao HTTP API.

This extension can render typed OpenBao HCL, but it does **not** copy files, SSH
to hosts, create directories, or manage systemd. Use cfgmgmt-style extensions for
deployment:

- `@evrardjp/openbao-configurator` `renderConfig` for OpenBao-aware HCL
  generation
- `@adam/cfgmgmt/file` for `/etc/openbao/openbao.hcl` deployment, ideally with a
  `bao server -config=<candidate> -verify-only` validation step
- `@adam/cfgmgmt/directory` for data/TLS directories
- a certificate extension for TLS material
- `@adam/cfgmgmt/systemd` for the `openbao` service

After OpenBao is installed, configured, and reachable, this extension also
handles the API lifecycle steps that need OpenBao semantics: status,
initialization, unseal, and seal.

## Model

- Package: `@evrardjp/openbao-configurator`
- Type: `@evrardjp/openbao-configurator`
- File: `openbao.ts`

## Methods

### `renderConfig`

Render deterministic OpenBao HCL from typed arguments and record it as
`renderedConfig/current`. This method does not deploy the file.

```bash
swamp model method run my-bao renderConfig \
  --input clusterAddr=https://bao.example.com:8201 \
  --input storage.type=raft \
  --input listeners.0.type=tcp \
  --input listeners.0.address=0.0.0.0:8200
```

The rendered HCL is available at:

```text
data.latest("my-bao", "renderedConfig").attributes.content
```

Use that content as the input to a cfgmgmt file deployment model.

### `status`

Read `/v1/sys/health` and record a `status` data snapshot.

```bash
swamp model method run my-bao status
```

### `initialize`

Run `/v1/sys/init` if the instance is not already initialized. Generated unseal
keys and the root token are stored in a Swamp vault.

```bash
swamp model method run my-bao initialize \
  --input vaultName=local \
  --input keyShares=5 \
  --input keyThreshold=3
```

Stored secrets:

- `OPENBAO_UNSEAL_KEY_1` … `OPENBAO_UNSEAL_KEY_N`
- `OPENBAO_ROOT_TOKEN`

### `unseal`

Submit one unseal key share to `/v1/sys/unseal` and record the progress.

```bash
swamp model method run my-bao unseal \
  --input unsealKey="${{ vault.get('local', 'OPENBAO_UNSEAL_KEY_1') }}"
```

### `seal`

Seal OpenBao via `/v1/sys/seal` using an operator token.

```bash
swamp model method run my-bao seal \
  --input token="${{ vault.get('local', 'OPENBAO_ROOT_TOKEN') }}"
```

## Configuration

Global arguments:

| Argument | Required | Description |
| --- | --- | --- |
| `apiAddr` | yes | OpenBao API address, for example `https://bao.example.com:8200` |

Example model:

```yaml
type: '@evrardjp/openbao-configurator'
name: my-bao
globalArgs:
  apiAddr: https://bao.example.com:8200
```

## TLS

The extension uses the runtime HTTP client. For a private CA or self-signed
certificate, configure the runtime trust store before running Swamp, for example
with `DENO_CERT=/path/to/openbao-ca.crt`.

## Data outputs

- `renderedConfig/current` — rendered OpenBao HCL and metadata
- `status/current` — OpenBao health snapshot
- `initState/result` — initialization status and vault name
- `unseal/result` — unseal progress and sealed state
- `seal/result` — seal confirmation

Reference outputs with CEL, for example:

```text
data.latest("my-bao", "initState").attributes.vaultName
data.latest("my-bao", "unseal").attributes.sealed
```

## License

MIT — see [LICENSE.txt](LICENSE.txt).
