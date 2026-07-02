# @evrardjp/ssh-ca

Strict OpenSSH certificate authority lifecycle management for Swamp.

One `@evrardjp/ssh-ca` model instance represents one actual OpenSSH CA keypair.
There is no root CA and no intermediate CA hierarchy because OpenSSH validates a
host/user certificate directly against a trusted CA public key.

Private CA keys, CA key passphrases, and optionally issued certificates are stored
in the configured Swamp vault. Public metadata, public keys, certificate
metadata, `@cert-authority` lines, `TrustedUserCAKeys` material, and base64 KRLs
are stored as Swamp data so other extensions can consume and deploy them.

## Model

- Type: `@evrardjp/ssh-ca`
- File: `models/ssh_ca.ts`

## OpenSSH concepts

- **CA keypair** — a normal OpenSSH private/public keypair used with
  `ssh-keygen -s` to sign certificates.
- **Host certificate** — signed with `ssh-keygen -s <ca_key> -h ...`.
- **User certificate** — signed with `ssh-keygen -s <ca_key> ...` without `-h`.
- **`@cert-authority` line** — client-side `known_hosts` syntax for trusting a
  CA public key for host certificates.
- **`TrustedUserCAKeys`** — server-side `sshd_config` setting pointing to a file
  containing CA public keys trusted for user certificates.
- **KRL** — OpenSSH Key Revocation List, generated with `ssh-keygen -k`.

## Methods

### `generate-keypair`

Generate this model's OpenSSH CA keypair with `ssh-keygen`.

Parameters:

- `algorithm`: `ed25519`, `rsa`, or `ecdsa` (default from global args)
- `bits`: optional `ssh-keygen -b` value
- `comment`: optional `ssh-keygen -C` comment
- `passphraseVaultKey`: optional vault key for generated passphrase
- `privateKeyVaultKey`: optional vault key for generated private key
- `force`: regenerate even if `ca-current` exists

Example:

```bash
swamp model method run gerrit-host-ca generate-keypair \
  --input algorithm=ed25519 \
  --input comment=gerrit-host-ca
```

Outputs:

- `ca-current` Swamp data containing public key, fingerprint, algorithm, comment,
  and vault refs
- private key in vault
- generated passphrase in vault

### `import-keypair`

Import an existing OpenSSH CA private/public key.

Parameters:

- `privateKey` or `privateKeyVault`
- `passphrase`
- `publicKey`
- optional `algorithm`, `bits`, `comment`

Example:

```bash
swamp model method run imported-ca import-keypair \
  --input privateKeyVault.vaultName=local \
  --input privateKeyVault.key=my-existing-ca-private-key \
  --input passphrase='...' \
  --input publicKey="$(cat ca.pub)" \
  --input algorithm=ed25519
```

### `issue-host-certificate`

Sign a host public key with this CA using `ssh-keygen -s ... -h`.

Parameters:

- one public key source:
  - `publicKey`
  - `publicKeyDataName`
  - `publicKeyVault.vaultName` + `publicKeyVault.key`
- `principals`: host principals for `ssh-keygen -n`
- `keyId`: certificate identity for `ssh-keygen -I`
- `serial`: optional `ssh-keygen -z` serial
- `validity`: optional duration like `30d`
- `options`: optional array of raw `ssh-keygen -O` options
- `outputTarget`: `data`, `vault`, or `both`
- `certificateVaultKey`: optional vault key when storing cert in vault

Example:

```bash
swamp model method run gerrit-host-ca issue-host-certificate \
  --input publicKey="$(cat /tmp/gerrit-host.pub)" \
  --input 'principals:json=["gerrit.local"]' \
  --input keyId=gerrit-host \
  --input serial=1001 \
  --input validity=30d \
  --input outputTarget=both
```

### `issue-user-certificate`

Sign a user public key with this CA using `ssh-keygen -s` without `-h`.

Same parameters as `issue-host-certificate`.

Example:

```bash
swamp model method run platform-user-ca issue-user-certificate \
  --input publicKey="$(cat /tmp/alice.pub)" \
  --input 'principals:json=["alice"]' \
  --input keyId=alice-login \
  --input serial=2001 \
  --input validity=24h \
  --input outputTarget=vault
```

### `generate-cert-authority`

Generate one OpenSSH `known_hosts` `@cert-authority` line for this CA public key.
This does not write to a remote machine.

Example:

```bash
swamp model method run gerrit-host-ca generate-cert-authority \
  --input hostPattern='*.local'
```

Output data contains:

```text
@cert-authority *.local ssh-ed25519 AAAA...
```

### `generate-trustedusercakeys`

Generate OpenSSH `TrustedUserCAKeys` file content for this CA public key. This
does not write to a remote machine.

Example:

```bash
swamp model method run platform-user-ca generate-trustedusercakeys
```

### `revoke-certificate`

Record a revocation event and generate an OpenSSH KRL for this CA.

Supported entry mechanisms:

- `serial`
- `keyId`
- `publicKey`
- `certificate`
- `targetDataName` pointing to Swamp data containing a certificate/public key

Example:

```bash
swamp model method run platform-user-ca revoke-certificate \
  --input reason='alice key compromised' \
  --input 'entries:json=[{"serial":2001},{"keyId":"alice-login"}]'
```

### `generate-revocation-list`

Generate an OpenSSH KRL without recording a revocation reason.

Example:

```bash
swamp model method run platform-user-ca generate-revocation-list \
  --input 'entries:json=[{"targetDataName":"cert-alice-login"}]'
```

The KRL is binary and is stored as base64 Swamp data in `krlBase64` with
`krlFormat: openssh-krl`.

### `describe-ca`

Produce a summary data item for this CA with example OpenSSH config snippets.
The inventory report is richer and reads all CA model data.

## Report

The extension registers `@evrardjp/ssh-ca-inventory`.

It summarizes all `@evrardjp/ssh-ca` model instances in the repo:

- CA public keys
- fingerprints
- algorithms/comments
- issued certificates
- KRL/revocation data
- example `known_hosts` `@cert-authority` configuration
- example `TrustedUserCAKeys` file content

Example:

```bash
swamp report get @evrardjp/ssh-ca-inventory --model gerrit-host-ca --markdown
```

## Security notes

- The model invokes `ssh-keygen` only.
- Private CA keys are stored in the Swamp vault.
- Generated CA passphrases are stored in the Swamp vault by default.
- Certificate material can be stored in Swamp data, in the vault, or both.
- This extension produces data only. It does not configure SSH clients/servers or
  write remote files.
- To enforce revocation, another extension must decode `krlBase64`, write the KRL
  to a target path, and configure `RevokedKeys` for `ssh`/`sshd` as appropriate.
