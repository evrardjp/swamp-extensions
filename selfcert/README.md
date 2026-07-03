# @evrardjp/selfcert

Self-signed TLS certificate generator for Swamp.

This extension creates RSA-4096 certificates locally with `node:crypto`, writes
certificate metadata as Swamp data, and stores the certificate and private-key
PEM bodies in a Swamp vault. It is intended for local labs and bootstrap flows
where a service needs TLS before an ACME/production CA integration is available.

## Usage

```yaml
type: "@evrardjp/selfcert"
arguments:
  fqdn: service.example.com
  ipSans:
    - 192.0.2.10
  vaultName: my-vault
  certVaultKey: tls-cert
  keyVaultKey: tls-key
  days: 3650
```

Run the generator method after creating or updating the model:

```bash
swamp model @evrardjp/selfcert method run generate my-service-selfcert
swamp data get my-service-selfcert
```

## Methods

- `generate` — Generate an RSA-4096 self-signed certificate and store cert + key
  in the configured vault. If the current cert resource already exists, the
  method skips generation so repeated workflow runs remain idempotent.

## Outputs

- `cert` resource — FQDN, vault name, vault key names, generation timestamp, and
  expiration timestamp.
- `log` file — A short generation log useful for workflow troubleshooting.
