# @evrardjp/selfcert

Self-signed TLS certificate generator for swamp.

Creates RSA-4096 certificates locally using `node:crypto` and stores the cert and private key in a swamp vault.

## Usage

```yaml
type: '@evrardjp/selfcert'
arguments:
  fqdn: example.local
  ipSans:
    - 192.168.1.1
  vaultName: my-vault
  certVaultKey: tls-cert
  keyVaultKey: tls-key
  days: 3650
```

## Methods

- `generate` — Generate (or skip if already present) a self-signed certificate and store it in the vault.
