/**
 * OpenSSH certificate authority lifecycle for Swamp-managed local labs.
 *
 * The model intentionally shells out only to `ssh-keygen` and persists private
 * key material only through fields marked sensitive, allowing Swamp to vault the
 * secret values while ordinary resources expose public keys, certificates,
 * fingerprints, serials, principals, and audit metadata.
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
const UsageSchema = z.enum(["host", "user"]);
const CaStateSchema = z.enum([
  "active",
  "deprecated",
  "deactivated",
  "revoked",
]);
const SerialStrategySchema = z.enum(["monotonic", "random"]);

const SubCaDefinitionSchema = z.object({
  name: z.string().min(1),
  usage: UsageSchema,
  validity: DurationSchema.optional(),
  principals: z.array(z.string()).default([]),
});

const GlobalArgsSchema = z.object({
  caName: z.string().min(1).describe("Logical SSH CA name"),
  vaultName: z.string().min(1).optional().describe(
    "Swamp vault expected to hold sensitive output fields",
  ),
  rootKeyRef: z.string().optional().describe(
    "Optional existing root key vault reference",
  ),
  hostSubCas: z.array(
    SubCaDefinitionSchema.omit({ usage: true }).extend({
      usage: z.literal("host").default("host"),
    }),
  ).default([]),
  userSubCas: z.array(
    SubCaDefinitionSchema.omit({ usage: true }).extend({
      usage: z.literal("user").default("user"),
    }),
  ).default([]),
  keyAlgorithm: KeyAlgorithmSchema.default("ed25519"),
  defaultHostValidity: DurationSchema.default("30d"),
  defaultUserValidity: DurationSchema.default("24h"),
  rootValidity: DurationSchema.default("1y"),
  hostSubCaValidity: DurationSchema.default("90d"),
  userSubCaValidity: DurationSchema.default("30d"),
  allowedPrincipals: z.array(z.string()).default([]),
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
};

const RootSchema = z.object({
  caName: z.string(),
  rootName: z.string(),
  publicKey: z.string(),
  privateKeyMaterial: z.string().meta({ sensitive: true }),
  fingerprint: z.string(),
  keyAlgorithm: KeyAlgorithmSchema,
  createdAt: IsoDateTimeSchema,
  validAfter: IsoDateTimeSchema,
  validBefore: IsoDateTimeSchema,
  state: CaStateSchema,
  vaultName: z.string().optional(),
  rootKeyRef: z.string().optional(),
  metadataLabels: z.record(z.string(), z.string()),
});

const SubCaSchema = z.object({
  caName: z.string(),
  subCaName: z.string(),
  usage: UsageSchema,
  publicKey: z.string(),
  privateKeyMaterial: z.string().meta({ sensitive: true }),
  fingerprint: z.string(),
  parentRootFingerprint: z.string(),
  keyAlgorithm: KeyAlgorithmSchema,
  createdAt: IsoDateTimeSchema,
  validAfter: IsoDateTimeSchema,
  validBefore: IsoDateTimeSchema,
  state: CaStateSchema,
  metadataLabels: z.record(z.string(), z.string()),
});

const CertSchema = z.object({
  caName: z.string(),
  certificateType: UsageSchema,
  certificate: z.string(),
  publicKey: z.string(),
  publicKeyFingerprint: z.string(),
  serial: z.number().int().nonnegative(),
  keyId: z.string(),
  principals: z.array(z.string()),
  signerSubCaName: z.string(),
  signerFingerprint: z.string(),
  validAfter: IsoDateTimeSchema,
  validBefore: IsoDateTimeSchema,
  issuedAt: IsoDateTimeSchema,
  metadataLabels: z.record(z.string(), z.string()),
});

const ClientTrustBundleSchema = z.object({
  caName: z.string(),
  hostPattern: z.string(),
  knownHosts: z.string(),
  trustedHostCas: z.array(z.object({
    subCaName: z.string(),
    fingerprint: z.string(),
    publicKey: z.string(),
    state: CaStateSchema,
  })),
  renderedAt: IsoDateTimeSchema,
  metadataLabels: z.record(z.string(), z.string()),
});

const ServerUserCaTrustBundleSchema = z.object({
  caName: z.string(),
  trustedUserCaKeys: z.string(),
  trustedUserCas: z.array(z.object({
    subCaName: z.string(),
    fingerprint: z.string(),
    publicKey: z.string(),
    state: CaStateSchema,
  })),
  renderedAt: IsoDateTimeSchema,
  metadataLabels: z.record(z.string(), z.string()),
});

const ReconcileSchema = z.object({
  caName: z.string(),
  checkedAt: IsoDateTimeSchema,
  status: z.enum(["ok", "warning"]),
  findings: z.array(z.string()),
  expiringSoon: z.array(
    z.object({
      name: z.string(),
      kind: z.string(),
      validBefore: IsoDateTimeSchema,
    }),
  ),
  metadataLabels: z.record(z.string(), z.string()),
});

const RotationSchema = z.object({
  caName: z.string(),
  usage: UsageSchema,
  oldSubCaName: z.string(),
  newSubCaName: z.string(),
  overlapUntil: IsoDateTimeSchema,
  rotatedAt: IsoDateTimeSchema,
  metadataLabels: z.record(z.string(), z.string()),
});

const RevocationSchema = z.object({
  caName: z.string(),
  targetKind: z.enum(["certificate", "subca"]),
  target: z.string(),
  reason: z.string(),
  revokedAt: IsoDateTimeSchema,
  krl: z.string().optional(),
  metadataLabels: z.record(z.string(), z.string()),
});

type RootData = z.infer<typeof RootSchema>;
type SubCaData = z.infer<typeof SubCaSchema>;

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

function now(): Date {
  return new Date();
}

/** Add a compact operational duration (for example 24h or 30d) to a Date. */
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

/** Return a certificate serial number using the configured serial strategy. */
export function serialFor(
  strategy: z.infer<typeof SerialStrategySchema>,
  seed: string,
): number {
  if (strategy === "random") {
    const bytes = crypto.getRandomValues(new Uint32Array(1));
    return bytes[0];
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

async function fingerprint(
  binary: string,
  publicKeyPath: string,
): Promise<string> {
  const { stdout } = await runSshKeygen(binary, ["-l", "-f", publicKeyPath]);
  const parts = stdout.trim().split(/\s+/);
  return parts[1] ?? stdout.trim();
}

async function generateKeyPair(
  binary: string,
  algorithm: string,
  comment: string,
): Promise<{
  publicKey: string;
  privateKeyMaterial: string;
  fingerprint: string;
}> {
  const dir = await DenoFs.makeTempDir();
  const keyPath = `${dir}/key`;
  try {
    await runSshKeygen(binary, [
      "-q",
      "-t",
      algorithm,
      "-N",
      "",
      "-C",
      comment,
      "-f",
      keyPath,
    ]);
    const publicKey = await DenoFs.readTextFile(`${keyPath}.pub`);
    const privateKeyMaterial = await DenoFs.readTextFile(keyPath);
    const fp = await fingerprint(binary, `${keyPath}.pub`);
    return { publicKey: publicKey.trim(), privateKeyMaterial, fingerprint: fp };
  } finally {
    await DenoFs.remove(dir, { recursive: true });
  }
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

function ensureAllowedPrincipals(requested: string[], allowed: string[]): void {
  if (requested.length === 0) {
    throw new Error("At least one principal is required");
  }
  if (allowed.length === 0) return;
  const allowedSet = new Set(allowed);
  const denied = requested.filter((p) => !allowedSet.has(p));
  if (denied.length > 0) {
    throw new Error(`Principal(s) not allowed by policy: ${denied.join(", ")}`);
  }
}

async function readRoot(context: MethodContext): Promise<RootData> {
  const raw = await context.readResource?.("root-current");
  if (!raw) throw new Error("Root CA not initialized. Run init-root first.");
  return RootSchema.parse(raw);
}

async function readSubCa(
  context: MethodContext,
  name: string,
): Promise<SubCaData> {
  const raw = await context.readResource?.(`subca-${safeName(name)}`);
  if (!raw) {
    throw new Error(`Sub-CA '${name}' does not exist. Run ensure-subca first.`);
  }
  const subCa = SubCaSchema.parse(raw);
  if (subCa.state !== "active" && subCa.state !== "deprecated") {
    throw new Error(
      `Sub-CA '${name}' is ${subCa.state} and cannot sign certificates`,
    );
  }
  return subCa;
}

async function signCertificate(args: {
  binary: string;
  usage: "host" | "user";
  caPrivateKey: string;
  publicKey: string;
  principals: string[];
  serial: number;
  keyId: string;
  validAfter: Date;
  validBefore: Date;
}): Promise<string> {
  const dir = await DenoFs.makeTempDir();
  try {
    const caKeyPath = await writePrivateKey(dir, "ca", args.caPrivateKey);
    const publicKeyPath = await writePublicKey(dir, "subject", args.publicKey);
    const certArgs = [
      "-q",
      "-s",
      caKeyPath,
      "-I",
      args.keyId,
      "-z",
      String(args.serial),
      "-V",
      validitySpec(args.validAfter, args.validBefore),
    ];
    if (args.usage === "host") certArgs.push("-h");
    certArgs.push("-n", args.principals.join(","), publicKeyPath);
    await runSshKeygen(args.binary, certArgs);
    return (await DenoFs.readTextFile(`${dir}/subject-cert.pub`)).trim();
  } finally {
    await DenoFs.remove(dir, { recursive: true });
  }
}

async function publicKeyFingerprint(
  binary: string,
  publicKey: string,
): Promise<string> {
  const dir = await DenoFs.makeTempDir();
  try {
    const publicKeyPath = await writePublicKey(dir, "key", publicKey);
    return await fingerprint(binary, publicKeyPath);
  } finally {
    await DenoFs.remove(dir, { recursive: true });
  }
}

function publicSubCaView(
  subCa: SubCaData,
): {
  subCaName: string;
  fingerprint: string;
  publicKey: string;
  state: z.infer<typeof CaStateSchema>;
} {
  return {
    subCaName: subCa.subCaName,
    fingerprint: subCa.fingerprint,
    publicKey: subCa.publicKey,
    state: subCa.state,
  };
}

/** Swamp model definition for managing OpenSSH CA keys and certificates. */
export const model = {
  type: "@evrardjp/ssh-ca",
  version: "2026.06.25.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    root: {
      description:
        "SSH root CA metadata; private key field is sensitive/vaulted",
      schema: RootSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    subca: {
      description:
        "SSH subordinate CA metadata; private key field is sensitive/vaulted",
      schema: SubCaSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
    hostcert: {
      description:
        "Issued OpenSSH host certificate and non-secret issuance metadata",
      schema: CertSchema.extend({ certificateType: z.literal("host") }),
      lifetime: "infinite",
      garbageCollection: 500,
    },
    usercert: {
      description:
        "Issued OpenSSH user certificate and non-secret issuance metadata",
      schema: CertSchema.extend({ certificateType: z.literal("user") }),
      lifetime: "infinite",
      garbageCollection: 1000,
    },
    clienttrust: {
      description:
        "known_hosts trust bundle containing active host CA marker lines",
      schema: ClientTrustBundleSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
    serverusertrust: {
      description: "TrustedUserCAKeys material for OpenSSH-compatible servers",
      schema: ServerUserCaTrustBundleSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
    reconcile: {
      description: "SSH CA state reconciliation result",
      schema: ReconcileSchema,
      lifetime: "30d",
      garbageCollection: 50,
    },
    rotation: {
      description: "Subordinate CA rotation event",
      schema: RotationSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
    revocation: {
      description: "Certificate revocation or sub-CA deactivation event",
      schema: RevocationSchema,
      lifetime: "infinite",
      garbageCollection: 500,
    },
  },
  methods: {
    "init-root": {
      description:
        "Create or read the self-signed root SSH CA key and metadata",
      arguments: z.object({ force: z.boolean().default(false) }),
      execute: async (args: { force: boolean }, context: MethodContext) => {
        context.logger.info("Initializing SSH root CA", {
          caName: context.globalArgs.caName,
        });
        if (!args.force) {
          const existing = await context.readResource?.("root-current");
          if (existing) {
            const handle = await context.writeResource(
              "root",
              "root-current",
              existing,
            );
            return { dataHandles: [handle] };
          }
        }
        const createdAt = now();
        const validBefore = addDuration(
          createdAt,
          context.globalArgs.rootValidity,
        );
        const key = await generateKeyPair(
          context.globalArgs.sshKeygenBinary,
          context.globalArgs.keyAlgorithm,
          `${context.globalArgs.caName} root`,
        );
        const root: RootData = {
          caName: context.globalArgs.caName,
          rootName: "root",
          publicKey: key.publicKey,
          privateKeyMaterial: key.privateKeyMaterial,
          fingerprint: key.fingerprint,
          keyAlgorithm: context.globalArgs.keyAlgorithm,
          createdAt: createdAt.toISOString(),
          validAfter: createdAt.toISOString(),
          validBefore: validBefore.toISOString(),
          state: "active",
          vaultName: context.globalArgs.vaultName,
          rootKeyRef: context.globalArgs.rootKeyRef,
          metadataLabels: context.globalArgs.metadataLabels,
        };
        const handle = await context.writeResource(
          "root",
          "root-current",
          root,
        );
        context.logger.info("Initialized SSH root CA", {
          fingerprint: root.fingerprint,
        });
        return { dataHandles: [handle] };
      },
    },
    "ensure-subca": {
      description: "Create or reconcile a subordinate host or user SSH CA",
      arguments: z.object({
        name: z.string().min(1),
        usage: UsageSchema,
        validity: DurationSchema.optional(),
        force: z.boolean().default(false),
      }),
      execute: async (
        args: {
          name: string;
          usage: "host" | "user";
          validity?: string;
          force: boolean;
        },
        context: MethodContext,
      ) => {
        context.logger.info("Ensuring SSH subordinate CA", {
          name: args.name,
          usage: args.usage,
        });
        const instance = `subca-${safeName(args.name)}`;
        if (!args.force) {
          const existing = await context.readResource?.(instance);
          if (existing) {
            const handle = await context.writeResource(
              "subca",
              instance,
              existing,
            );
            return { dataHandles: [handle] };
          }
        }
        const root = await readRoot(context);
        const createdAt = now();
        const validity = args.validity ??
          (args.usage === "host"
            ? context.globalArgs.hostSubCaValidity
            : context.globalArgs.userSubCaValidity);
        const key = await generateKeyPair(
          context.globalArgs.sshKeygenBinary,
          context.globalArgs.keyAlgorithm,
          `${context.globalArgs.caName} ${args.name} ${args.usage} subca`,
        );
        const subCa: SubCaData = {
          caName: context.globalArgs.caName,
          subCaName: args.name,
          usage: args.usage,
          publicKey: key.publicKey,
          privateKeyMaterial: key.privateKeyMaterial,
          fingerprint: key.fingerprint,
          parentRootFingerprint: root.fingerprint,
          keyAlgorithm: context.globalArgs.keyAlgorithm,
          createdAt: createdAt.toISOString(),
          validAfter: createdAt.toISOString(),
          validBefore: addDuration(createdAt, validity).toISOString(),
          state: "active",
          metadataLabels: context.globalArgs.metadataLabels,
        };
        const handle = await context.writeResource("subca", instance, subCa);
        context.logger.info("Ensured SSH subordinate CA", {
          name: args.name,
          fingerprint: subCa.fingerprint,
        });
        return { dataHandles: [handle] };
      },
    },
    "issue-host-cert": {
      description:
        "Sign an OpenSSH host public key with an active host subordinate CA",
      arguments: z.object({
        hostPublicKey: z.string().min(1),
        principals: z.array(z.string().min(1)).min(1),
        validity: DurationSchema.optional(),
        subCaName: z.string().min(1),
        keyId: z.string().optional(),
        serial: z.number().int().nonnegative().optional(),
      }),
      execute: async (
        args: {
          hostPublicKey: string;
          principals: string[];
          validity?: string;
          subCaName: string;
          keyId?: string;
          serial?: number;
        },
        context: MethodContext,
      ) => {
        context.logger.info("Issuing SSH host certificate", {
          subCaName: args.subCaName,
        });
        ensureAllowedPrincipals(
          args.principals,
          context.globalArgs.allowedPrincipals,
        );
        const subCa = await readSubCa(context, args.subCaName);
        if (subCa.usage !== "host") {
          throw new Error(
            `Sub-CA '${args.subCaName}' is for ${subCa.usage}, not host certificates`,
          );
        }
        const issuedAt = now();
        const keyId = args.keyId ??
          `${context.globalArgs.caName}:host:${
            args.principals.join(",")
          }:${issuedAt.toISOString()}`;
        const serial = args.serial ??
          serialFor(context.globalArgs.serialStrategy, keyId);
        const validBefore = addDuration(
          issuedAt,
          args.validity ?? context.globalArgs.defaultHostValidity,
        );
        const certificate = await signCertificate({
          binary: context.globalArgs.sshKeygenBinary,
          usage: "host",
          caPrivateKey: subCa.privateKeyMaterial,
          publicKey: args.hostPublicKey,
          principals: args.principals,
          serial,
          keyId,
          validAfter: issuedAt,
          validBefore,
        });
        const publicKeyFp = await publicKeyFingerprint(
          context.globalArgs.sshKeygenBinary,
          args.hostPublicKey,
        );
        const data = {
          caName: context.globalArgs.caName,
          certificateType: "host" as const,
          certificate,
          publicKey: args.hostPublicKey.trim(),
          publicKeyFingerprint: publicKeyFp,
          serial,
          keyId,
          principals: args.principals,
          signerSubCaName: subCa.subCaName,
          signerFingerprint: subCa.fingerprint,
          validAfter: issuedAt.toISOString(),
          validBefore: validBefore.toISOString(),
          issuedAt: issuedAt.toISOString(),
          metadataLabels: context.globalArgs.metadataLabels,
        };
        const handle = await context.writeResource(
          "hostcert",
          `hostcert-${safeName(keyId)}`,
          data,
        );
        return { dataHandles: [handle] };
      },
    },
    "issue-user-cert": {
      description:
        "Sign an OpenSSH user public key with an active user subordinate CA",
      arguments: z.object({
        userPublicKey: z.string().min(1),
        principals: z.array(z.string().min(1)).min(1),
        validity: DurationSchema.optional(),
        subCaName: z.string().min(1),
        keyId: z.string().optional(),
        serial: z.number().int().nonnegative().optional(),
        role: z.string().optional(),
      }),
      execute: async (
        args: {
          userPublicKey: string;
          principals: string[];
          validity?: string;
          subCaName: string;
          keyId?: string;
          serial?: number;
          role?: string;
        },
        context: MethodContext,
      ) => {
        context.logger.info("Issuing SSH user certificate", {
          subCaName: args.subCaName,
          role: args.role,
        });
        ensureAllowedPrincipals(
          args.principals,
          context.globalArgs.allowedPrincipals,
        );
        const subCa = await readSubCa(context, args.subCaName);
        if (subCa.usage !== "user") {
          throw new Error(
            `Sub-CA '${args.subCaName}' is for ${subCa.usage}, not user certificates`,
          );
        }
        const issuedAt = now();
        const keyId = args.keyId ??
          `${context.globalArgs.caName}:user:${
            args.principals.join(",")
          }:${issuedAt.toISOString()}`;
        const serial = args.serial ??
          serialFor(context.globalArgs.serialStrategy, keyId);
        const validBefore = addDuration(
          issuedAt,
          args.validity ?? context.globalArgs.defaultUserValidity,
        );
        const certificate = await signCertificate({
          binary: context.globalArgs.sshKeygenBinary,
          usage: "user",
          caPrivateKey: subCa.privateKeyMaterial,
          publicKey: args.userPublicKey,
          principals: args.principals,
          serial,
          keyId,
          validAfter: issuedAt,
          validBefore,
        });
        const publicKeyFp = await publicKeyFingerprint(
          context.globalArgs.sshKeygenBinary,
          args.userPublicKey,
        );
        const data = {
          caName: context.globalArgs.caName,
          certificateType: "user" as const,
          certificate,
          publicKey: args.userPublicKey.trim(),
          publicKeyFingerprint: publicKeyFp,
          serial,
          keyId,
          principals: args.principals,
          signerSubCaName: subCa.subCaName,
          signerFingerprint: subCa.fingerprint,
          validAfter: issuedAt.toISOString(),
          validBefore: validBefore.toISOString(),
          issuedAt: issuedAt.toISOString(),
          metadataLabels: {
            ...context.globalArgs.metadataLabels,
            ...(args.role ? { role: args.role } : {}),
          },
        };
        const handle = await context.writeResource(
          "usercert",
          `usercert-${safeName(keyId)}`,
          data,
        );
        return { dataHandles: [handle] };
      },
    },
    "render-client-trust": {
      description:
        "Render known_hosts CA marker trust for active host subordinate CAs",
      arguments: z.object({
        hostPattern: z.string().min(1),
        subCaNames: z.array(z.string().min(1)).default([]),
      }),
      execute: async (
        args: { hostPattern: string; subCaNames: string[] },
        context: MethodContext,
      ) => {
        context.logger.info("Rendering SSH client trust bundle", {
          hostPattern: args.hostPattern,
        });
        const names = args.subCaNames.length > 0
          ? args.subCaNames
          : context.globalArgs.hostSubCas.map((c) => c.name);
        const cas =
          (await Promise.all(names.map((name) => readSubCa(context, name))))
            .filter((ca) =>
              ca.usage === "host" && ca.state !== "deactivated" &&
              ca.state !== "revoked"
            );
        const knownHosts =
          cas.map((ca) => `@cert-authority ${args.hostPattern} ${ca.publicKey}`)
            .join("\n") + (cas.length ? "\n" : "");
        const data = {
          caName: context.globalArgs.caName,
          hostPattern: args.hostPattern,
          knownHosts,
          trustedHostCas: cas.map(publicSubCaView),
          renderedAt: now().toISOString(),
          metadataLabels: context.globalArgs.metadataLabels,
        };
        const handle = await context.writeResource(
          "clienttrust",
          `clienttrust-${safeName(args.hostPattern)}`,
          data,
        );
        return { dataHandles: [handle] };
      },
    },
    "render-server-user-ca-trust": {
      description:
        "Render TrustedUserCAKeys material for active user subordinate CAs",
      arguments: z.object({
        subCaNames: z.array(z.string().min(1)).default([]),
      }),
      execute: async (
        args: { subCaNames: string[] },
        context: MethodContext,
      ) => {
        context.logger.info("Rendering SSH server user CA trust bundle");
        const names = args.subCaNames.length > 0
          ? args.subCaNames
          : context.globalArgs.userSubCas.map((c) => c.name);
        const cas =
          (await Promise.all(names.map((name) => readSubCa(context, name))))
            .filter((ca) =>
              ca.usage === "user" && ca.state !== "deactivated" &&
              ca.state !== "revoked"
            );
        const data = {
          caName: context.globalArgs.caName,
          trustedUserCaKeys: cas.map((ca) => ca.publicKey).join("\n") +
            (cas.length ? "\n" : ""),
          trustedUserCas: cas.map(publicSubCaView),
          renderedAt: now().toISOString(),
          metadataLabels: context.globalArgs.metadataLabels,
        };
        const handle = await context.writeResource(
          "serverusertrust",
          "serverusertrust-current",
          data,
        );
        return { dataHandles: [handle] };
      },
    },
    "reconcile-certs": {
      description: "Verify known CA state and report expiry warnings",
      arguments: z.object({ warnWithin: DurationSchema.default("7d") }),
      execute: async (args: { warnWithin: string }, context: MethodContext) => {
        context.logger.info("Reconciling SSH CA state");
        const findings: string[] = [];
        const expiringSoon: Array<
          { name: string; kind: string; validBefore: string }
        > = [];
        const root = await readRoot(context).catch((error) => {
          findings.push(error.message);
          return null;
        });
        const threshold = addDuration(now(), args.warnWithin).getTime();
        if (root && Date.parse(root.validBefore) <= threshold) {
          expiringSoon.push({
            name: root.rootName,
            kind: "root",
            validBefore: root.validBefore,
          });
        }
        for (
          const def of [
            ...context.globalArgs.hostSubCas,
            ...context.globalArgs.userSubCas,
          ]
        ) {
          const subCa = await readSubCa(context, def.name).catch((error) => {
            findings.push(error.message);
            return null;
          });
          if (subCa && Date.parse(subCa.validBefore) <= threshold) {
            expiringSoon.push({
              name: subCa.subCaName,
              kind: `${subCa.usage}-subca`,
              validBefore: subCa.validBefore,
            });
          }
        }
        const data = {
          caName: context.globalArgs.caName,
          checkedAt: now().toISOString(),
          status: findings.length === 0 ? "ok" as const : "warning" as const,
          findings,
          expiringSoon,
          metadataLabels: context.globalArgs.metadataLabels,
        };
        const handle = await context.writeResource(
          "reconcile",
          "reconcile-current",
          data,
        );
        return { dataHandles: [handle] };
      },
    },
    "rotate-subca": {
      description: "Create a replacement sub-CA and record the overlap window",
      arguments: z.object({
        oldSubCaName: z.string().min(1),
        newSubCaName: z.string().min(1),
        overlap: DurationSchema.default("7d"),
        validity: DurationSchema.optional(),
      }),
      execute: async (
        args: {
          oldSubCaName: string;
          newSubCaName: string;
          overlap: string;
          validity?: string;
        },
        context: MethodContext,
      ) => {
        context.logger.info("Rotating SSH subordinate CA", {
          oldSubCaName: args.oldSubCaName,
          newSubCaName: args.newSubCaName,
        });
        const oldSubCa = await readSubCa(context, args.oldSubCaName);
        const createdAt = now();
        const key = await generateKeyPair(
          context.globalArgs.sshKeygenBinary,
          context.globalArgs.keyAlgorithm,
          `${context.globalArgs.caName} ${args.newSubCaName} ${oldSubCa.usage} subca`,
        );
        const newSubCa: SubCaData = {
          caName: context.globalArgs.caName,
          subCaName: args.newSubCaName,
          usage: oldSubCa.usage,
          publicKey: key.publicKey,
          privateKeyMaterial: key.privateKeyMaterial,
          fingerprint: key.fingerprint,
          parentRootFingerprint: oldSubCa.parentRootFingerprint,
          keyAlgorithm: context.globalArgs.keyAlgorithm,
          createdAt: createdAt.toISOString(),
          validAfter: createdAt.toISOString(),
          validBefore: addDuration(
            createdAt,
            args.validity ??
              (oldSubCa.usage === "host"
                ? context.globalArgs.hostSubCaValidity
                : context.globalArgs.userSubCaValidity),
          ).toISOString(),
          state: "active",
          metadataLabels: context.globalArgs.metadataLabels,
        };
        const deprecatedOld = { ...oldSubCa, state: "deprecated" as const };
        const overlapUntil = addDuration(createdAt, args.overlap).toISOString();
        const handles = [
          await context.writeResource(
            "subca",
            `subca-${safeName(args.oldSubCaName)}`,
            deprecatedOld,
          ),
          await context.writeResource(
            "subca",
            `subca-${safeName(args.newSubCaName)}`,
            newSubCa,
          ),
          await context.writeResource(
            "rotation",
            `rotation-${safeName(args.oldSubCaName)}-${
              safeName(args.newSubCaName)
            }`,
            {
              caName: context.globalArgs.caName,
              usage: oldSubCa.usage,
              oldSubCaName: args.oldSubCaName,
              newSubCaName: args.newSubCaName,
              overlapUntil,
              rotatedAt: createdAt.toISOString(),
              metadataLabels: context.globalArgs.metadataLabels,
            },
          ),
        ];
        return { dataHandles: handles };
      },
    },
    "revoke-cert": {
      description: "Record certificate revocation metadata by serial/key id",
      arguments: z.object({
        target: z.string().min(1),
        reason: z.string().min(1),
      }),
      execute: async (
        args: { target: string; reason: string },
        context: MethodContext,
      ) => {
        context.logger.info("Recording SSH certificate revocation", {
          target: args.target,
        });
        const data = {
          caName: context.globalArgs.caName,
          targetKind: "certificate" as const,
          target: args.target,
          reason: args.reason,
          revokedAt: now().toISOString(),
          metadataLabels: context.globalArgs.metadataLabels,
        };
        const handle = await context.writeResource(
          "revocation",
          `revocation-cert-${safeName(args.target)}`,
          data,
        );
        return { dataHandles: [handle] };
      },
    },
    "deactivate-subca": {
      description:
        "Mark a subordinate CA as deactivated and record revocation metadata",
      arguments: z.object({
        subCaName: z.string().min(1),
        reason: z.string().min(1),
      }),
      execute: async (
        args: { subCaName: string; reason: string },
        context: MethodContext,
      ) => {
        context.logger.info("Deactivating SSH subordinate CA", {
          subCaName: args.subCaName,
        });
        const subCa = await readSubCa(context, args.subCaName);
        const deactivated = { ...subCa, state: "deactivated" as const };
        const handles = [
          await context.writeResource(
            "subca",
            `subca-${safeName(args.subCaName)}`,
            deactivated,
          ),
          await context.writeResource(
            "revocation",
            `revocation-subca-${safeName(args.subCaName)}`,
            {
              caName: context.globalArgs.caName,
              targetKind: "subca" as const,
              target: args.subCaName,
              reason: args.reason,
              revokedAt: now().toISOString(),
              metadataLabels: context.globalArgs.metadataLabels,
            },
          ),
        ];
        return { dataHandles: handles };
      },
    },
  },
};
