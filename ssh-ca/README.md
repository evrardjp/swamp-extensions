# @evrardjp/ssh-ca

Swamp-native OpenSSH certificate authority lifecycle management for local labs.

This extension manages OpenSSH CA keys and certificates as Swamp model data. It
uses only `ssh-keygen` for key generation, signing, and fingerprint inspection.
Private CA key material is emitted only through fields marked sensitive so Swamp
stores it in the configured vault; normal data contains public keys,
certificates, fingerprints, serials, principals, trust bundles, and audit
metadata.

## Model

- Type: `@evrardjp/ssh-ca`
- File: `models/ssh_ca.ts`

## Methods

- `init-root` — create or read the root SSH CA key.
- `ensure-subca` — create or reconcile host/user subordinate CAs.
- `issue-host-cert` — sign a host public key.
- `issue-user-cert` — sign a user public key.
- `render-client-trust` — render `known_hosts` `@cert-authority` lines.
- `render-server-user-ca-trust` — render `TrustedUserCAKeys` material.
- `reconcile-certs` — report missing/expiring CA state.
- `rotate-subca` — create replacement sub-CA and record overlap metadata.
- `revoke-cert` — record certificate revocation metadata.
- `deactivate-subca` — deactivate a subordinate CA.

## Example

```bash
swamp extension source add /var/home/evrardjp/git/evrardjp/swamp-extensions/ssh-ca --only models

swamp model @evrardjp/ssh-ca method run init-root lab-ssh-ca \
  --input caName=lab-ssh-ca \
  --input hostSubCas:json='[{"name":"local-host-ca","usage":"host"}]' \
  --input userSubCas:json='[{"name":"local-user-ca","usage":"user"}]'

swamp model method run lab-ssh-ca ensure-subca \
  --input name=local-host-ca \
  --input usage=host

ssh-keygen -q -t ed25519 -N '' -C gerrit.local -f /tmp/gerrit-host
swamp model method run lab-ssh-ca issue-host-cert \
  --input hostPublicKey="$(cat /tmp/gerrit-host.pub)" \
  --input principals:json='["gerrit.local"]' \
  --input subCaName=local-host-ca \
  --input keyId=gerrit.local

swamp model method run lab-ssh-ca render-client-trust \
  --input hostPattern=gerrit.local \
  --input subCaNames:json='["local-host-ca"]'
```

## Security notes

- Do not pass existing host or user private keys to this model for signing;
  signing methods take public keys only.
- The only supported external helper is `ssh-keygen`.
- The model does not configure Gerrit or sshd directly; consumers should use the
  emitted trust bundle resources.
- OpenSSH certificates are not X.509 chains. Consumers must trust the active
  host/user CA public keys directly.
