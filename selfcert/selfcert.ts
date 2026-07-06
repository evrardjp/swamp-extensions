import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { z } from "npm:zod@4";
import type { ModelDefinition } from "jsr:@systeminit/swamp-testing@0.20260518.13";

type VaultPut = (v: string, k: string, val: string) => Promise<void>;
type VaultDelete = (v: string, k: string) => Promise<void>;
type RuntimeVaultService = {
  put?: VaultPut;
  delete?: VaultDelete;
};

async function putSecret(
  vaultName: string,
  key: string,
  value: string,
  runtimePut?: VaultPut,
  vaultService?: RuntimeVaultService,
): Promise<void> {
  if (runtimePut) {
    await runtimePut(vaultName, key, value);
    return;
  }
  if (!vaultService?.put) {
    throw new Error(
      "This Swamp runtime does not expose context.vaultService.put; cannot store certificate material safely",
    );
  }
  await vaultService.put(vaultName, key, value);
}

async function deleteSecret(
  vaultName: string,
  key: string,
  runtimeDelete?: VaultDelete,
  vaultService?: RuntimeVaultService,
): Promise<void> {
  if (runtimeDelete) {
    await runtimeDelete(vaultName, key);
    return;
  }
  if (!vaultService?.delete) {
    throw new Error(
      "This Swamp runtime does not expose context.vaultService.delete; cannot clean up certificate material safely",
    );
  }
  await vaultService.delete(vaultName, key);
}

// ─── ASN.1 / DER helpers ──────────────────────────────────────────────────────

function derLen(len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function tlv(tag: number, value: Uint8Array): Uint8Array {
  const lenBytes = derLen(value.length);
  const out = new Uint8Array(1 + lenBytes.length + value.length);
  out[0] = tag;
  out.set(lenBytes, 1);
  out.set(value, 1 + lenBytes.length);
  return out;
}

const seq = (v: Uint8Array) => tlv(0x30, v);
const set_ = (v: Uint8Array) => tlv(0x31, v);

function encodeOid(dotted: string): Uint8Array {
  const parts = dotted.split(".").map(Number);
  const bytes: number[] = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let n = parts[i];
    const chunk: number[] = [n & 0x7f];
    n >>= 7;
    while (n > 0) {
      chunk.unshift((n & 0x7f) | 0x80);
      n >>= 7;
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, new Uint8Array(bytes));
}

function derInt(buf: Uint8Array): Uint8Array {
  const pad = (buf[0] & 0x80) ? concat(new Uint8Array([0]), buf) : buf;
  return tlv(0x02, pad);
}

const derNull = () => new Uint8Array([0x05, 0x00]);
const derBool = (b: boolean) => tlv(0x01, new Uint8Array([b ? 0xff : 0x00]));
const derOctet = (v: Uint8Array) => tlv(0x04, v);
const derBits = (v: Uint8Array) => tlv(0x03, concat(new Uint8Array([0x00]), v));
const derUTF8 = (s: string) => tlv(0x0c, new TextEncoder().encode(s));

function derTime(d: Date): Uint8Array {
  const p = (n: number, w = 2) => n.toString().padStart(w, "0");
  const y = d.getUTCFullYear();
  if (y >= 2050) {
    const s = `${p(y, 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${
      p(d.getUTCHours())
    }${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
    return tlv(0x18, new TextEncoder().encode(s)); // GeneralizedTime
  }
  const s = `${p(y % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${
    p(d.getUTCHours())
  }${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, new TextEncoder().encode(s)); // UTCTime
}

// OIDs
const OID_SHA256_RSA = "1.2.840.113549.1.1.11";
const OID_CN = "2.5.4.3";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_SAN = "2.5.29.17";

const algSha256Rsa = seq(concat(encodeOid(OID_SHA256_RSA), derNull()));

function buildName(cn: string): Uint8Array {
  return seq(set_(seq(concat(encodeOid(OID_CN), derUTF8(cn)))));
}

function buildValidity(notBefore: Date, notAfter: Date): Uint8Array {
  return seq(concat(derTime(notBefore), derTime(notAfter)));
}

function isIPv4(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  return !!m && m.slice(1).every((o) => parseInt(o) <= 255);
}

function buildSANs(fqdn: string, ipSans: string[]): Uint8Array {
  const names: Uint8Array[] = [
    tlv(0x82, new TextEncoder().encode(fqdn)), // dNSName [2] IMPLICIT
  ];
  for (const ip of ipSans) {
    if (isIPv4(ip)) {
      names.push(tlv(0x87, new Uint8Array(ip.split(".").map(Number)))); // iPAddress [7]
    } else {
      names.push(tlv(0x82, new TextEncoder().encode(ip))); // treat non-IP as DNS SAN
    }
  }
  return seq(concat(encodeOid(OID_SAN), derOctet(seq(concat(...names)))));
}

function buildBasicConstraints(): Uint8Array {
  // critical BasicConstraints with cA:false (empty sequence = CA:false, no pathLen)
  return seq(concat(
    encodeOid(OID_BASIC_CONSTRAINTS),
    derBool(true),
    derOctet(seq(new Uint8Array(0))),
  ));
}

function buildTBSCertificate(
  spkiDer: Uint8Array,
  serial: Uint8Array,
  fqdn: string,
  notBefore: Date,
  notAfter: Date,
  ipSans: string[],
): Uint8Array {
  const version = tlv(0xa0, tlv(0x02, new Uint8Array([0x02]))); // [0] EXPLICIT v3=2
  const extensions = tlv(
    0xa3,
    seq(concat(buildBasicConstraints(), buildSANs(fqdn, ipSans))),
  ); // [3] EXPLICIT
  return seq(concat(
    version,
    derInt(serial),
    algSha256Rsa,
    buildName(fqdn),
    buildValidity(notBefore, notAfter),
    buildName(fqdn),
    spkiDer, // already DER-encoded SubjectPublicKeyInfo
    extensions,
  ));
}

function buildCertificate(
  tbsDer: Uint8Array,
  signatureBytes: Uint8Array,
): Uint8Array {
  return seq(concat(tbsDer, algSha256Rsa, derBits(signatureBytes)));
}

function pemEncode(type: string, der: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...der));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${type}-----\n${
    lines.join("\n")
  }\n-----END ${type}-----\n`;
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const GlobalArgsSchema = z.object({
  fqdn: z.string().min(1).describe(
    "Common Name and primary DNS SAN for the self-signed certificate",
  ),
  ipSans: z.array(z.string()).default([]).describe(
    "Additional IP SANs (IPv4 addresses or extra hostnames)",
  ),
  vaultName: z.string().describe(
    "Swamp vault name where cert and key will be stored",
  ),
  certVaultKey: z.string().default("TLS_CERT").describe(
    "Vault key name for the certificate PEM",
  ),
  keyVaultKey: z.string().default("TLS_KEY").describe(
    "Vault key name for the private key PEM",
  ),
  days: z.number().int().positive().default(3650).describe(
    "Certificate validity period in days",
  ),
});

const GenerateArgsSchema = z.object({
  _vaultPut: z.unknown().optional(),
  _vaultDelete: z.unknown().optional(),
});

const CertResourceSchema = z.object({
  fqdn: z.string(),
  vaultName: z.string(),
  certVaultKey: z.string(),
  keyVaultKey: z.string(),
  generatedAt: z.string(),
  expiresAt: z.string(),
});

/** Self-signed TLS certificate generator: creates an RSA-4096 cert + key locally using node:crypto and stores both in a swamp vault. */
export const model = {
  type: "@evrardjp/selfcert",
  version: "2026.07.06.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.03.1",
      description:
        "Move extension source to swamp-extensions with no argument or resource schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.07.06.1",
      description:
        "Use the runtime vaultService API for storing generated certificate material with no argument or resource schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    cert: {
      description:
        "Self-signed certificate metadata (cert and key stored in vault)",
      schema: CertResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  files: {
    log: {
      description: "Certificate generation log",
      contentType: "text/plain",
      lifetime: "7d",
      garbageCollection: 5,
      streaming: true,
    },
  },
  checks: {
    "fqdn-valid": {
      description: "Verify that fqdn is non-empty",
      execute: (context) => {
        const { fqdn } = context.globalArgs;
        if (!fqdn || fqdn.trim().length === 0) {
          return Promise.resolve({
            pass: false,
            errors: ["fqdn must not be empty"],
          });
        }
        return Promise.resolve({ pass: true, errors: [] });
      },
    },
  },
  methods: {
    generate: {
      description:
        "Generate a self-signed RSA-4096 certificate and store cert + key in vault (idempotent — skips if cert resource already exists)",
      arguments: GenerateArgsSchema,
      execute: async (args, context) => {
        const { fqdn, ipSans, vaultName, certVaultKey, keyVaultKey, days } =
          context.globalArgs;
        const logWriter = context.createFileWriter("log", "generate");
        let finalizedLog = false;
        const finalizeLog = async () => {
          if (finalizedLog) return undefined;
          finalizedLog = true;
          return await logWriter.finalize();
        };
        const log = async (msg: string, props?: Record<string, unknown>) => {
          context.logger.info(msg, props);
          await logWriter.writeLine(
            props ? `${msg} ${JSON.stringify(props)}` : msg,
          );
        };

        const typedArgs = args as {
          _vaultPut?: VaultPut;
          _vaultDelete?: VaultDelete;
        };
        const runtime = context as typeof context & {
          vaultService?: RuntimeVaultService;
        };
        const runtimePutSecret = typedArgs._vaultPut;
        const runtimeDeleteSecret = typedArgs._vaultDelete;
        const vaultService = runtime.vaultService;
        const storedKeys: string[] = [];

        try {
          await log("Checking for existing cert resource", { fqdn });
          if (context.readResource) {
            const existing = await context.readResource("current");
            if (existing) {
              await log("Certificate already generated — skipping", {
                fqdn,
                reason: "existing-resource",
              });
              const logHandle = await finalizeLog();
              return { dataHandles: logHandle ? [logHandle] : [] };
            }
          }

          await log("Generating RSA-4096 certificate", { fqdn, days });
          const { publicKey: spkiDer, privateKey: pkeyPem } =
            generateKeyPairSync(
              "rsa",
              {
                modulusLength: 4096,
                publicKeyEncoding: { type: "spki", format: "der" },
                privateKeyEncoding: { type: "pkcs8", format: "pem" },
              },
            ) as unknown as { publicKey: Uint8Array; privateKey: string };

          const notBefore = new Date();
          const notAfter = new Date(notBefore.getTime() + days * 86_400_000);

          const serial = randomBytes(16) as unknown as Uint8Array;
          serial[0] &= 0x7f; // ensure positive integer (clear high bit)

          const tbsDer = buildTBSCertificate(
            spkiDer,
            serial,
            fqdn,
            notBefore,
            notAfter,
            ipSans,
          );

          const signer = createSign("sha256");
          signer.update(tbsDer);
          const signature = signer.sign(pkeyPem) as unknown as Uint8Array;

          const certDer = buildCertificate(tbsDer, new Uint8Array(signature));
          const certPem = pemEncode("CERTIFICATE", certDer);

          await log("Storing certificate in vault", {
            vaultName,
            key: certVaultKey,
          });
          await putSecret(
            vaultName,
            certVaultKey,
            certPem,
            runtimePutSecret,
            vaultService,
          );
          storedKeys.push(certVaultKey);

          await log("Storing private key in vault", {
            vaultName,
            key: keyVaultKey,
          });
          await putSecret(
            vaultName,
            keyVaultKey,
            pkeyPem,
            runtimePutSecret,
            vaultService,
          );
          storedKeys.push(keyVaultKey);

          const certHandle = await context.writeResource("cert", "current", {
            fqdn,
            vaultName,
            certVaultKey,
            keyVaultKey,
            generatedAt: notBefore.toISOString(),
            expiresAt: notAfter.toISOString(),
          });

          await log("Certificate generation complete", { fqdn });
          const logHandle = await finalizeLog();
          return {
            dataHandles: logHandle ? [certHandle, logHandle] : [certHandle],
          };
        } catch (error) {
          await log("Certificate generation failed", {
            fqdn,
            error: error instanceof Error ? error.message : String(error),
          });
          for (const key of storedKeys.reverse()) {
            try {
              await deleteSecret(
                vaultName,
                key,
                runtimeDeleteSecret,
                vaultService,
              );
              await log("Cleaned up vault key after failure", {
                vaultName,
                key,
              });
            } catch (cleanupError) {
              context.logger.info("Failed to clean up vault key", {
                vaultName,
                key,
                error: cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError),
              });
            }
          }
          await finalizeLog();
          throw error;
        }
      },
    },
  },
} satisfies ModelDefinition<typeof GlobalArgsSchema>;
