/**
 * Strict OpenSSH CA lifecycle for Swamp-managed local labs.
 *
 * One model instance represents one OpenSSH CA keypair. There is no root CA or
 * intermediate hierarchy because OpenSSH verifies certificates directly against
 * a trusted CA public key. This model shells out only to `ssh-keygen`.
 *
 * @module
 */
import { z } from "npm:zod@4";

const DenoCommand = Deno.Command;
const DenoFs = {
  makeTempDir: () => Deno.makeTempDir(),
  remove: (path: string, opts?: { recursive?: boolean }) =>
    Deno.remove(path, opts).catch(() => {}),
  readTextFile: (path: string) => Deno.readTextFile(path),
  readFile: (path: string) => Deno.readFile(path),
  writeTextFile: (path: string, data: string, opts?: { mode?: number }) =>
    Deno.writeTextFile(path, data, opts),
  chmod: (path: string, mode: number) => Deno.chmod(path, mode),
};

const IsoDateTimeSchema = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  {
    message: "Expected an ISO-8601 timestamp",
  },
);
const DurationSchema = z.string().regex(
  /^\d+(m|h|d|w|mo|y)$/,
  "Use a duration like 30m, 24h, 30d, 7w, 3mo, or 1y",
);
const KeyAlgorithmSchema = z.enum(["ed25519", "rsa", "ecdsa"]);
const CertificateTypeSchema = z.enum(["host", "user"]);
const OutputTargetSchema = z.enum(["data", "vault", "both"]);
const SerialStrategySchema = z.enum(["monotonic", "random"]);

const VaultRefSchema = z.object({
  vaultName: z.string().min(1),
  key: z.string().min(1),
});

const GenerateKeypairArgsSchema = z.object({
  algorithm: KeyAlgorithmSchema.optional(),
  bits: z.number().int().positive().optional(),
  comment: z.string().optional(),
  passphraseVaultKey: z.string().optional(),
  privateKeyVaultKey: z.string().optional().meta({ sensitive: true }),
  force: z.boolean().default(false),
});

const ImportKeypairArgsSchema = z.object({
  privateKey: z.string().min(1).optional().meta({ sensitive: true }),
  privateKeyVault: VaultRefSchema.optional().meta({ sensitive: true }),
  passphrase: z.string().default("").meta({ sensitive: true }),
  publicKey: z.string().min(1),
  algorithm: KeyAlgorithmSchema.optional(),
  bits: z.number().int().positive().optional(),
  comment: z.string().optional(),
  privateKeyVaultKey: z.string().optional().meta({ sensitive: true }),
  passphraseVaultKey: z.string().optional(),
});

const GlobalArgsSchema = z.object({
  caName: z.string().min(1).describe("Logical OpenSSH CA name"),
  vaultName: z.string().min(1).describe(
    "Swamp vault for private keys, passphrases, and optional certificates",
  ),
  keyAlgorithm: KeyAlgorithmSchema.default("ed25519"),
  bits: z.number().int().positive().optional().describe(
    "ssh-keygen -b bits; useful for rsa and ecdsa",
  ),
  comment: z.string().optional().describe(
    "ssh-keygen -C comment; defaults to caName",
  ),
  defaultValidity: DurationSchema.default("30d"),
  serialStrategy: SerialStrategySchema.default("monotonic"),
  metadataLabels: z.record(z.string(), z.string()).default({}),
  sshKeygenBinary: z.string().default("ssh-keygen"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

type MethodContext = {
  globalArgs: GlobalArgs;
  logger: {
    info: (message: string, fields?: Record<string, unknown>) => void;
    warning?: (message: string, fields?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource?: (
    name: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  putSecret?: (vaultName: string, key: string, value: string) => Promise<void>;
  readSecret?: (vaultName: string, key: string) => Promise<string>;
};

const CaSchema = z.object({
  caName: z.string(),
  publicKey: z.string(),
  publicKeyFingerprint: z.string(),
  privateKeyVaultRef: z.string().meta({ sensitive: true }),
  passphraseVaultRef: z.string().meta({ sensitive: true }),
  keyAlgorithm: KeyAlgorithmSchema,
  bits: z.number().int().positive().optional(),
  comment: z.string(),
  createdAt: IsoDateTimeSchema,
  metadataLabels: z.record(z.string(), z.string()),
});

const CertificateSchema = z.object({
  caName: z.string(),
  certificateType: CertificateTypeSchema,
  certificate: z.string().optional(),
  certificateVaultRef: z.string().optional(),
  subjectPublicKey: z.string(),
  subjectPublicKeyFingerprint: z.string(),
  serial: z.number().int().nonnegative(),
  keyId: z.string(),
  principals: z.array(z.string()),
  validAfter: IsoDateTimeSchema,
  validBefore: IsoDateTimeSchema,
  issuedAt: IsoDateTimeSchema,
  caFingerprint: z.string(),
  metadataLabels: z.record(z.string(), z.string()),
});

const CertAuthoritySchema = z.object({
  caName: z.string(),
  hostPattern: z.string(),
  certAuthorityLine: z.string(),
  caPublicKey: z.string(),
  caFingerprint: z.string(),
  generatedAt: IsoDateTimeSchema,
  metadataLabels: z.record(z.string(), z.string()),
});

const TrustedUserCAKeysSchema = z.object({
  caName: z.string(),
  trustedUserCAKeys: z.string(),
  caPublicKey: z.string(),
  caFingerprint: z.string(),
  generatedAt: IsoDateTimeSchema,
  metadataLabels: z.record(z.string(), z.string()),
});

const RevocationEntrySchema = z.object({
  serial: z.number().int().positive().optional(),
  keyId: z.string().min(1).optional(),
  publicKey: z.string().min(1).optional(),
  certificate: z.string().min(1).optional(),
  targetDataName: z.string().min(1).optional(),
});

type RevocationEntry = z.infer<typeof RevocationEntrySchema>;

type CertificateData = z.infer<typeof CertificateSchema>;
type CaData = z.infer<typeof CaSchema>;
type GenerateKeypairMethodArgs = z.infer<typeof GenerateKeypairArgsSchema>;
type ImportKeypairMethodArgs = z.infer<typeof ImportKeypairArgsSchema>;
type IssueCertificateMethodArgs = {
  publicKey?: string;
  publicKeyDataName?: string;
  publicKeyVault?: z.infer<typeof VaultRefSchema>;
  principals: string[];
  keyId?: string;
  serial?: number;
  validity?: string;
  options?: string[];
  outputTarget?: "data" | "vault" | "both";
  certificateVaultKey?: string;
};

const KeyRevocationListSchema = z.object({
  caName: z.string(),
  caFingerprint: z.string(),
  krlBase64: z.string(),
  krlFormat: z.literal("openssh-krl"),
  entries: z.array(RevocationEntrySchema),
  generatedAt: IsoDateTimeSchema,
  metadataLabels: z.record(z.string(), z.string()),
});

const RevocationSchema = z.object({
  caName: z.string(),
  caFingerprint: z.string(),
  reason: z.string(),
  revokedAt: IsoDateTimeSchema,
  entries: z.array(RevocationEntrySchema),
  krlBase64: z.string(),
  krlFormat: z.literal("openssh-krl"),
  metadataLabels: z.record(z.string(), z.string()),
});

const CaSummarySchema = z.object({
  caName: z.string(),
  ca: CaSchema,
  activeCertificates: z.array(CertificateSchema),
  knownHostsCertAuthority: z.string(),
  trustedUserCAKeys: z.string(),
  generatedAt: IsoDateTimeSchema,
  metadataLabels: z.record(z.string(), z.string()),
});

async function runSshKeygen(
  binary: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  if (binary.includes("/") && !binary.endsWith("ssh-keygen")) {
    throw new Error("sshKeygenBinary must point to ssh-keygen");
  }
  if (!binary.endsWith("ssh-keygen") && binary !== "ssh-keygen") {
    throw new Error("Only ssh-keygen is allowed for SSH CA operations");
  }
  const result = await new DenoCommand(binary, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.code !== 0) {
    throw new Error(
      `ssh-keygen ${args.join(" ")} failed: ${stderr || stdout}`.slice(0, 1200),
    );
  }
  return { stdout, stderr };
}

async function runSwamp(
  args: string[],
  input?: string,
): Promise<{ stdout: string; stderr: string }> {
  const command = new DenoCommand("swamp", {
    args,
    stdin: input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  if (input !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  }
  const result = await child.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.code !== 0) {
    throw new Error(
      `swamp ${args.join(" ")} failed: ${stderr || stdout}`.slice(0, 1200),
    );
  }
  return { stdout, stderr };
}

function now(): Date {
  return new Date();
}

/** Add an OpenSSH-style validity duration such as 30m, 12h, 7d, 2w, 3mo, or 1y to a date. */
export function addDuration(from: Date, duration: string): Date {
  const match = /^(\d+)(m|h|d|w|mo|y)$/.exec(duration);
  if (!match) throw new Error(`Invalid duration: ${duration}`);
  const amount = Number(match[1]);
  const unit = match[2];
  const out = new Date(from.getTime());
  if (unit === "m") out.setMinutes(out.getMinutes() + amount);
  if (unit === "h") out.setHours(out.getHours() + amount);
  if (unit === "d") out.setDate(out.getDate() + amount);
  if (unit === "w") out.setDate(out.getDate() + amount * 7);
  if (unit === "mo") out.setMonth(out.getMonth() + amount);
  if (unit === "y") out.setFullYear(out.getFullYear() + amount);
  return out;
}

function validitySpec(validAfter: Date, validBefore: Date): string {
  const fmt = (d: Date) =>
    d.toISOString().replace(/[-:]/g, "").replace("T", "").replace(
      /\.\d{3}Z$/,
      "",
    );
  return `${fmt(validAfter)}:${fmt(validBefore)}`;
}

/** Generate a certificate serial number using either random entropy or a deterministic FNV-1a seed hash. */
export function serialFor(
  strategy: z.infer<typeof SerialStrategySchema>,
  seed: string,
): number {
  if (strategy === "random") {
    return crypto.getRandomValues(new Uint32Array(1))[0];
  }
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  ) || "default";
}

function vaultRef(vaultName: string, key: string): string {
  return `\${{ vault.get('${vaultName}', '${key}') }}`;
}

function parseVaultRef(ref: string): { vaultName: string; key: string } | null {
  const match = /^\$\{\{\s*vault\.get\('([^']+)'\s*,\s*'([^']+)'\)\s*\}\}$/
    .exec(ref.trim());
  return match ? { vaultName: match[1], key: match[2] } : null;
}

async function putSecret(
  context: MethodContext,
  key: string,
  value: string,
): Promise<string> {
  const vaultName = context.globalArgs.vaultName;
  if (context.putSecret) await context.putSecret(vaultName, key, value);
  else await runSwamp(["vault", "put", vaultName, key, "--json"], value);
  return vaultRef(vaultName, key);
}

async function readSecret(
  context: MethodContext,
  vaultName: string,
  key: string,
): Promise<string> {
  if (context.readSecret) return await context.readSecret(vaultName, key);
  const { stdout } = await runSwamp([
    "vault",
    "read-secret",
    vaultName,
    key,
    "--force",
    "--json",
  ]);
  return (JSON.parse(stdout) as { value: string }).value;
}

async function resolveVaultRef(
  context: MethodContext,
  valueOrRef: string,
): Promise<string> {
  const parsed = parseVaultRef(valueOrRef);
  return parsed
    ? await readSecret(context, parsed.vaultName, parsed.key)
    : valueOrRef;
}

function randomPassphrase(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}

async function writePrivateKey(
  dir: string,
  name: string,
  privateKey: string,
): Promise<string> {
  const path = `${dir}/${name}`;
  await DenoFs.writeTextFile(path, privateKey, { mode: 0o600 });
  await DenoFs.chmod(path, 0o600).catch(() => {});
  return path;
}

async function writePublicKey(
  dir: string,
  name: string,
  publicKey: string,
): Promise<string> {
  const path = `${dir}/${name}.pub`;
  await DenoFs.writeTextFile(
    path,
    publicKey.endsWith("\n") ? publicKey : `${publicKey}\n`,
  );
  return path;
}

async function fingerprint(binary: string, publicKey: string): Promise<string> {
  const dir = await DenoFs.makeTempDir();
  try {
    const path = await writePublicKey(dir, "key", publicKey);
    const { stdout } = await runSshKeygen(binary, ["-l", "-f", path]);
    return stdout.trim().split(/\s+/)[1] ?? stdout.trim();
  } finally {
    await DenoFs.remove(dir, { recursive: true });
  }
}

async function readCa(context: MethodContext): Promise<CaData> {
  const raw = await context.readResource?.("ca-current");
  if (!raw) {
    throw new Error(
      "CA keypair not initialized. Run generate-keypair or import-keypair first.",
    );
  }
  return CaSchema.parse(raw);
}

async function resolvePublicKey(context: MethodContext, args: {
  publicKey?: string;
  publicKeyDataName?: string;
  publicKeyVault?: z.infer<typeof VaultRefSchema>;
}): Promise<string> {
  if (args.publicKey) return args.publicKey.trim();
  if (args.publicKeyVault) {
    return (await readSecret(
      context,
      args.publicKeyVault.vaultName,
      args.publicKeyVault.key,
    )).trim();
  }
  if (args.publicKeyDataName) {
    const raw = await context.readResource?.(args.publicKeyDataName);
    if (!raw) {
      throw new Error(`Public key data '${args.publicKeyDataName}' not found`);
    }
    if (typeof raw.publicKey === "string") return raw.publicKey.trim();
    if (typeof raw.subjectPublicKey === "string") {
      return raw.subjectPublicKey.trim();
    }
    throw new Error(
      `Data '${args.publicKeyDataName}' does not contain publicKey or subjectPublicKey`,
    );
  }
  throw new Error(
    "Provide one of publicKey, publicKeyDataName, or publicKeyVault",
  );
}

async function resolveCertificateOrPublicKeyFile(
  context: MethodContext,
  dir: string,
  entry: RevocationEntry,
  index: number,
): Promise<string | null> {
  let material = entry.certificate ?? entry.publicKey;
  if (!material && entry.targetDataName) {
    const raw = await context.readResource?.(entry.targetDataName);
    if (!raw) {
      throw new Error(
        `Revocation target data '${entry.targetDataName}' not found`,
      );
    }
    const cert = CertificateSchema.safeParse(raw);
    if (cert.success) {
      material = cert.data.certificate ??
        (cert.data.certificateVaultRef
          ? await resolveVaultRef(context, cert.data.certificateVaultRef)
          : undefined);
    } else if (typeof raw.publicKey === "string") material = raw.publicKey;
    else if (typeof raw.certificate === "string") material = raw.certificate;
  }
  if (!material) return null;
  const path = `${dir}/revoked-${index}.pub`;
  await DenoFs.writeTextFile(
    path,
    material.endsWith("\n") ? material : `${material}\n`,
  );
  return path;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function generateKrl(
  context: MethodContext,
  ca: CaData,
  entries: RevocationEntry[],
): Promise<string> {
  if (entries.length === 0) {
    throw new Error("At least one revocation entry is required");
  }
  const dir = await DenoFs.makeTempDir();
  try {
    const caPub = await writePublicKey(dir, "ca", ca.publicKey);
    const krlPath = `${dir}/revoked.krl`;
    const specLines: string[] = [];
    const fileArgs: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.serial !== undefined) specLines.push(`serial: ${entry.serial}`);
      if (entry.keyId) specLines.push(`id: ${entry.keyId}`);
      const materialPath = await resolveCertificateOrPublicKeyFile(
        context,
        dir,
        entry,
        i,
      );
      if (materialPath) fileArgs.push(materialPath);
    }
    const args = ["-q", "-k", "-f", krlPath, "-s", caPub];
    if (specLines.length > 0) {
      const specPath = `${dir}/revocations.krlspec`;
      await DenoFs.writeTextFile(specPath, `${specLines.join("\n")}\n`);
      args.push(specPath);
    }
    args.push(...fileArgs);
    if (specLines.length === 0 && fileArgs.length === 0) {
      throw new Error(
        "No serial, keyId, publicKey, certificate, or targetDataName material found",
      );
    }
    await runSshKeygen(context.globalArgs.sshKeygenBinary, args);
    return base64Encode(await DenoFs.readFile(krlPath));
  } finally {
    await DenoFs.remove(dir, { recursive: true });
  }
}

async function signCertificate(context: MethodContext, ca: CaData, args: {
  certificateType: "host" | "user";
  publicKey: string;
  principals: string[];
  keyId: string;
  serial: number;
  validAfter: Date;
  validBefore: Date;
  options: string[];
}): Promise<string> {
  const dir = await DenoFs.makeTempDir();
  try {
    const privateKey = await resolveVaultRef(context, ca.privateKeyVaultRef);
    const passphrase = await resolveVaultRef(context, ca.passphraseVaultRef);
    const caKeyPath = await writePrivateKey(dir, "ca", privateKey);
    const subjectPath = await writePublicKey(dir, "subject", args.publicKey);
    const keygenArgs = [
      "-q",
      "-s",
      caKeyPath,
      "-P",
      passphrase,
      "-I",
      args.keyId,
      "-z",
      String(args.serial),
      "-V",
      validitySpec(args.validAfter, args.validBefore),
    ];
    if (args.certificateType === "host") keygenArgs.push("-h");
    for (const option of args.options) keygenArgs.push("-O", option);
    if (args.principals.length > 0) {
      keygenArgs.push("-n", args.principals.join(","));
    }
    keygenArgs.push(subjectPath);
    await runSshKeygen(context.globalArgs.sshKeygenBinary, keygenArgs);
    return (await DenoFs.readTextFile(`${dir}/subject-cert.pub`)).trim();
  } finally {
    await DenoFs.remove(dir, { recursive: true });
  }
}

async function issueCertificate(args: {
  certificateType: "host" | "user";
  publicKey?: string;
  publicKeyDataName?: string;
  publicKeyVault?: z.infer<typeof VaultRefSchema>;
  principals: string[];
  keyId?: string;
  serial?: number;
  validity?: string;
  options?: string[];
  outputTarget?: "data" | "vault" | "both";
  certificateVaultKey?: string;
}, context: MethodContext): Promise<{ dataHandles: Array<{ name: string }> }> {
  const ca = await readCa(context);
  const issuedAt = now();
  const publicKey = await resolvePublicKey(context, args);
  const keyId = args.keyId ??
    `${context.globalArgs.caName}:${args.certificateType}:${
      args.principals.join(",")
    }:${issuedAt.toISOString()}`;
  const serial = args.serial ??
    serialFor(context.globalArgs.serialStrategy, keyId);
  const validBefore = addDuration(
    issuedAt,
    args.validity ?? context.globalArgs.defaultValidity,
  );
  const certificate = await signCertificate(context, ca, {
    certificateType: args.certificateType,
    publicKey,
    principals: args.principals,
    keyId,
    serial,
    validAfter: issuedAt,
    validBefore,
    options: args.options ?? [],
  });
  const outputTarget = args.outputTarget ?? "data";
  const certificateVaultRef = outputTarget !== "data"
    ? await putSecret(
      context,
      args.certificateVaultKey ??
        `ssh-ca-${safeName(context.globalArgs.caName)}-cert-${safeName(keyId)}`,
      certificate,
    )
    : undefined;
  const data: CertificateData = {
    caName: context.globalArgs.caName,
    certificateType: args.certificateType,
    certificate: outputTarget === "vault" ? undefined : certificate,
    certificateVaultRef,
    subjectPublicKey: publicKey,
    subjectPublicKeyFingerprint: await fingerprint(
      context.globalArgs.sshKeygenBinary,
      publicKey,
    ),
    serial,
    keyId,
    principals: args.principals,
    validAfter: issuedAt.toISOString(),
    validBefore: validBefore.toISOString(),
    issuedAt: issuedAt.toISOString(),
    caFingerprint: ca.publicKeyFingerprint,
    metadataLabels: context.globalArgs.metadataLabels,
  };
  const handle = await context.writeResource(
    "certificate",
    `cert-${safeName(keyId)}`,
    data,
  );
  return { dataHandles: [handle] };
}

/** OpenSSH CA lifecycle model for CA keys, host/user certificates, trust snippets, KRLs, and inventory data. */
export const model = {
  type: "@evrardjp/ssh-ca",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.17.1",
      description: "Version bump with no global argument schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    ca: {
      description:
        "OpenSSH CA public metadata; private key and passphrase are vault references",
      schema: CaSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    certificate: {
      description: "Issued OpenSSH host/user certificate and issuance metadata",
      schema: CertificateSchema,
      lifetime: "infinite",
      garbageCollection: 1000,
    },
    certificateauthority: {
      description: "OpenSSH known_hosts @cert-authority line for this CA",
      schema: CertAuthoritySchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
    trustedusercakeys: {
      description: "OpenSSH TrustedUserCAKeys material for this CA",
      schema: TrustedUserCAKeysSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
    revocation: {
      description:
        "OpenSSH certificate/key revocation event including generated KRL",
      schema: RevocationSchema,
      lifetime: "infinite",
      garbageCollection: 500,
    },
    keyrevocationlist: {
      description: "OpenSSH binary Key Revocation List (KRL), base64 encoded",
      schema: KeyRevocationListSchema,
      lifetime: "infinite",
      garbageCollection: 500,
    },
    casummary: {
      description:
        "Summary of this CA, active certificates, and OpenSSH configuration snippets",
      schema: CaSummarySchema,
      lifetime: "30d",
      garbageCollection: 50,
    },
  },
  methods: {
    "generate-keypair": {
      description:
        "Generate this OpenSSH CA keypair with ssh-keygen and store private key/passphrase in the Swamp vault",
      arguments: GenerateKeypairArgsSchema,
      execute: async (
        args: GenerateKeypairMethodArgs,
        context: MethodContext,
      ) => {
        context.logger.info("Generating OpenSSH CA keypair", {
          caName: context.globalArgs.caName,
        });
        if (!args.force) {
          const existing = await context.readResource?.("ca-current");
          if (existing) {
            return {
              dataHandles: [
                await context.writeResource("ca", "ca-current", existing),
              ],
            };
          }
        }
        const algorithm = args.algorithm ?? context.globalArgs.keyAlgorithm;
        const bits = args.bits ?? context.globalArgs.bits;
        const comment = args.comment ?? context.globalArgs.comment ??
          context.globalArgs.caName;
        const passphrase = randomPassphrase();
        const dir = await DenoFs.makeTempDir();
        try {
          const keyPath = `${dir}/ca`;
          const keygenArgs = [
            "-q",
            "-t",
            algorithm,
            "-N",
            passphrase,
            "-C",
            comment,
            "-f",
            keyPath,
          ];
          if (bits !== undefined) keygenArgs.splice(4, 0, "-b", String(bits));
          await runSshKeygen(context.globalArgs.sshKeygenBinary, keygenArgs);
          const publicKey = (await DenoFs.readTextFile(`${keyPath}.pub`))
            .trim();
          const privateKey = await DenoFs.readTextFile(keyPath);
          const privateKeyVaultRef = await putSecret(
            context,
            args.privateKeyVaultKey ??
              `ssh-ca-${safeName(context.globalArgs.caName)}-privateKey`,
            privateKey,
          );
          const passphraseVaultRef = await putSecret(
            context,
            args.passphraseVaultKey ??
              `ssh-ca-${safeName(context.globalArgs.caName)}-passphrase`,
            passphrase,
          );
          const ca: CaData = {
            caName: context.globalArgs.caName,
            publicKey,
            publicKeyFingerprint: await fingerprint(
              context.globalArgs.sshKeygenBinary,
              publicKey,
            ),
            privateKeyVaultRef,
            passphraseVaultRef,
            keyAlgorithm: algorithm,
            bits,
            comment,
            createdAt: now().toISOString(),
            metadataLabels: context.globalArgs.metadataLabels,
          };
          return {
            dataHandles: [await context.writeResource("ca", "ca-current", ca)],
          };
        } finally {
          await DenoFs.remove(dir, { recursive: true });
        }
      },
    },
    "import-keypair": {
      description:
        "Import an existing OpenSSH CA private/public key into the Swamp vault/data model",
      arguments: ImportKeypairArgsSchema,
      execute: async (
        args: ImportKeypairMethodArgs,
        context: MethodContext,
      ) => {
        const privateKey = args.privateKey ??
          (args.privateKeyVault
            ? await readSecret(
              context,
              args.privateKeyVault.vaultName,
              args.privateKeyVault.key,
            )
            : undefined);
        if (!privateKey) {
          throw new Error("import-keypair needs privateKey or privateKeyVault");
        }
        const privateKeyVaultRef = await putSecret(
          context,
          args.privateKeyVaultKey ??
            `ssh-ca-${safeName(context.globalArgs.caName)}-privateKey`,
          privateKey,
        );
        const passphraseVaultRef = await putSecret(
          context,
          args.passphraseVaultKey ??
            `ssh-ca-${safeName(context.globalArgs.caName)}-passphrase`,
          args.passphrase,
        );
        const ca: CaData = {
          caName: context.globalArgs.caName,
          publicKey: args.publicKey.trim(),
          publicKeyFingerprint: await fingerprint(
            context.globalArgs.sshKeygenBinary,
            args.publicKey,
          ),
          privateKeyVaultRef,
          passphraseVaultRef,
          keyAlgorithm: args.algorithm ?? context.globalArgs.keyAlgorithm,
          bits: args.bits ?? context.globalArgs.bits,
          comment: args.comment ?? context.globalArgs.comment ??
            context.globalArgs.caName,
          createdAt: now().toISOString(),
          metadataLabels: context.globalArgs.metadataLabels,
        };
        return {
          dataHandles: [await context.writeResource("ca", "ca-current", ca)],
        };
      },
    },
    "issue-host-certificate": {
      description: "Sign an OpenSSH host certificate with ssh-keygen -s ... -h",
      arguments: z.object({
        publicKey: z.string().min(1).optional(),
        publicKeyDataName: z.string().min(1).optional(),
        publicKeyVault: VaultRefSchema.optional(),
        principals: z.array(z.string().min(1)).min(1),
        keyId: z.string().optional(),
        serial: z.number().int().nonnegative().optional(),
        validity: DurationSchema.optional(),
        options: z.array(z.string()).default([]).describe(
          "ssh-keygen -O option values",
        ),
        outputTarget: OutputTargetSchema.default("data"),
        certificateVaultKey: z.string().optional(),
      }),
      execute: async (
        args: IssueCertificateMethodArgs,
        context: MethodContext,
      ) =>
        await issueCertificate({ ...args, certificateType: "host" }, context),
    },
    "issue-user-certificate": {
      description: "Sign an OpenSSH user certificate with ssh-keygen -s",
      arguments: z.object({
        publicKey: z.string().min(1).optional(),
        publicKeyDataName: z.string().min(1).optional(),
        publicKeyVault: VaultRefSchema.optional(),
        principals: z.array(z.string().min(1)).min(1),
        keyId: z.string().optional(),
        serial: z.number().int().nonnegative().optional(),
        validity: DurationSchema.optional(),
        options: z.array(z.string()).default([]).describe(
          "ssh-keygen -O option values",
        ),
        outputTarget: OutputTargetSchema.default("data"),
        certificateVaultKey: z.string().optional(),
      }),
      execute: async (
        args: IssueCertificateMethodArgs,
        context: MethodContext,
      ) =>
        await issueCertificate({ ...args, certificateType: "user" }, context),
    },
    "generate-cert-authority": {
      description:
        "Generate an OpenSSH known_hosts @cert-authority line for this CA",
      arguments: z.object({ hostPattern: z.string().min(1) }),
      execute: async (
        args: { hostPattern: string },
        context: MethodContext,
      ) => {
        const ca = await readCa(context);
        const data = {
          caName: context.globalArgs.caName,
          hostPattern: args.hostPattern,
          certAuthorityLine:
            `@cert-authority ${args.hostPattern} ${ca.publicKey}`,
          caPublicKey: ca.publicKey,
          caFingerprint: ca.publicKeyFingerprint,
          generatedAt: now().toISOString(),
          metadataLabels: context.globalArgs.metadataLabels,
        };
        return {
          dataHandles: [
            await context.writeResource(
              "certificateauthority",
              `cert-authority-${safeName(args.hostPattern)}`,
              data,
            ),
          ],
        };
      },
    },
    "generate-trustedusercakeys": {
      description: "Generate OpenSSH TrustedUserCAKeys material for this CA",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const ca = await readCa(context);
        const data = {
          caName: context.globalArgs.caName,
          trustedUserCAKeys: `${ca.publicKey}\n`,
          caPublicKey: ca.publicKey,
          caFingerprint: ca.publicKeyFingerprint,
          generatedAt: now().toISOString(),
          metadataLabels: context.globalArgs.metadataLabels,
        };
        return {
          dataHandles: [
            await context.writeResource(
              "trustedusercakeys",
              "trustedusercakeys-current",
              data,
            ),
          ],
        };
      },
    },
    "revoke-certificate": {
      description:
        "Record revocation entries and generate an OpenSSH KRL for this CA",
      arguments: z.object({
        reason: z.string().min(1),
        entries: z.array(RevocationEntrySchema).min(1),
      }),
      execute: async (
        args: { reason: string; entries: RevocationEntry[] },
        context: MethodContext,
      ) => {
        const ca = await readCa(context);
        const krlBase64 = await generateKrl(context, ca, args.entries);
        const data = {
          caName: context.globalArgs.caName,
          caFingerprint: ca.publicKeyFingerprint,
          reason: args.reason,
          revokedAt: now().toISOString(),
          entries: args.entries,
          krlBase64,
          krlFormat: "openssh-krl" as const,
          metadataLabels: context.globalArgs.metadataLabels,
        };
        return {
          dataHandles: [
            await context.writeResource(
              "revocation",
              `revocation-${safeName(args.reason)}-${Date.now()}`,
              data,
            ),
          ],
        };
      },
    },
    "generate-revocation-list": {
      description:
        "Generate an OpenSSH KRL for this CA without adding a revocation event reason",
      arguments: z.object({ entries: z.array(RevocationEntrySchema).min(1) }),
      execute: async (
        args: { entries: RevocationEntry[] },
        context: MethodContext,
      ) => {
        const ca = await readCa(context);
        const data = {
          caName: context.globalArgs.caName,
          caFingerprint: ca.publicKeyFingerprint,
          krlBase64: await generateKrl(context, ca, args.entries),
          krlFormat: "openssh-krl" as const,
          entries: args.entries,
          generatedAt: now().toISOString(),
          metadataLabels: context.globalArgs.metadataLabels,
        };
        return {
          dataHandles: [
            await context.writeResource(
              "keyrevocationlist",
              "krl-current",
              data,
            ),
          ],
        };
      },
    },
    "describe-ca": {
      description:
        "Produce a Swamp data summary of this CA, active certificates, and OpenSSH configuration snippets",
      arguments: z.object({ hostPattern: z.string().default("*") }),
      execute: async (
        args: { hostPattern: string },
        context: MethodContext,
      ) => {
        const ca = await readCa(context);
        const certs: CertificateData[] = [];
        // Method contexts expose point reads only today, so this method records the CA and config snippets.
        // The companion report reads all model data to list certificates.
        const data = {
          caName: context.globalArgs.caName,
          ca,
          activeCertificates: certs,
          knownHostsCertAuthority:
            `@cert-authority ${args.hostPattern} ${ca.publicKey}`,
          trustedUserCAKeys: `${ca.publicKey}\n`,
          generatedAt: now().toISOString(),
          metadataLabels: context.globalArgs.metadataLabels,
        };
        return {
          dataHandles: [
            await context.writeResource("casummary", "ca-summary", data),
          ],
        };
      },
    },
  },
};
