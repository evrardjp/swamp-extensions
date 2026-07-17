import { z } from "npm:zod@4";
import type { ModelDefinition } from "jsr:@systeminit/swamp-testing@0.20260518.13";

// @ts-ignore: Deno global available at bundle runtime
const DenoFs = {
  stat: (p: string) => Deno.stat(p),
  open: (p: string, o: Deno.OpenOptions) => Deno.open(p, o),
  writeFile: (p: string, d: Uint8Array, o?: Deno.WriteFileOptions) =>
    Deno.writeFile(p, d, o),
  readTextFile: (p: string) => Deno.readTextFile(p),
  realPath: (p: string) => Deno.realPath(p),
  link: (oldpath: string, newpath: string) => Deno.link(oldpath, newpath),
  remove: (p: string) => Deno.remove(p),
  env: Deno.env,
};

// ─── ISO 9660 builder ─────────────────────────────────────────────────────────
// Generates a minimal cloud-init NoCloud seed image supporting 2 or 3 files.
// Uppercased filenames; Linux isofs map=normal lowercases on mount.

/** Build a minimal ISO 9660 CIDATA image from cloud-init file contents. */
export function makeCloudInitIso(files: Array<[string, string]>): Uint8Array {
  const S = 2048;
  const enc = new TextEncoder();

  const encoded: Array<[Uint8Array, Uint8Array]> = files
    .map(([name, content]): [Uint8Array, Uint8Array] => [
      enc.encode(name.toUpperCase()),
      enc.encode(content),
    ])
    .sort((a, b) =>
      new TextDecoder().decode(a[0]).localeCompare(
        new TextDecoder().decode(b[0]),
      )
    );

  let lba = 19;
  const extents: number[] = [];
  for (const [, data] of encoded) {
    extents.push(lba);
    lba += Math.ceil(data.length / S) || 1;
  }
  // Some ISO readers perform sector-aligned lookahead beyond the final extent.
  const totalSectors = Math.max(lba, 64);

  const u32b = (v: number) =>
    new Uint8Array([
      v & 0xFF,
      (v >> 8) & 0xFF,
      (v >> 16) & 0xFF,
      (v >> 24) & 0xFF,
      (v >> 24) & 0xFF,
      (v >> 16) & 0xFF,
      (v >> 8) & 0xFF,
      v & 0xFF,
    ]);
  const u16b = (v: number) =>
    new Uint8Array([v & 0xFF, (v >> 8) & 0xFF, (v >> 8) & 0xFF, v & 0xFF]);

  const dirRecord = (
    nameBytes: Uint8Array,
    isDir: boolean,
    extentLba: number,
    dataLen: number,
  ) => {
    const nl = nameBytes.length;
    const rec = new Uint8Array(33 + nl + (nl % 2 === 0 ? 1 : 0));
    let i = 0;
    rec[i++] = rec.length;
    rec[i++] = 0;
    rec.set(u32b(extentLba), i);
    i += 8;
    rec.set(u32b(dataLen), i);
    i += 8;
    rec[i++] = 126;
    rec[i++] = 2;
    rec[i++] = 21; // date 2026-02-21
    rec[i++] = 0;
    rec[i++] = 0;
    rec[i++] = 0;
    rec[i++] = 0;
    rec[i++] = isDir ? 2 : 0;
    rec[i++] = 0;
    rec[i++] = 0;
    rec.set(u16b(1), i);
    i += 4;
    rec[i++] = nl;
    rec.set(nameBytes, i);
    return rec;
  };

  const dotRec = dirRecord(new Uint8Array([0x00]), true, 18, S);
  const dotdotRec = dirRecord(new Uint8Array([0x01]), true, 18, S);

  const rootDir = new Uint8Array(S);
  let doff = 0;
  rootDir.set(dotRec, doff);
  doff += dotRec.length;
  rootDir.set(dotdotRec, doff);
  doff += dotdotRec.length;
  for (let i = 0; i < encoded.length; i++) {
    const rec = dirRecord(
      encoded[i][0],
      false,
      extents[i],
      encoded[i][1].length,
    );
    rootDir.set(rec, doff);
    doff += rec.length;
  }

  const pvd = new Uint8Array(S);
  pvd[0] = 1;
  pvd.set(enc.encode("CD001"), 1);
  pvd[6] = 1;
  pvd.fill(0x20, 8, 40);
  pvd.set(enc.encode("CIDATA"), 40);
  pvd.fill(0x20, 46, 72);
  pvd.set(u32b(totalSectors), 80);
  pvd.set(u16b(1), 120);
  pvd.set(u16b(1), 124);
  pvd.set(u16b(S), 128);
  pvd.set(u32b(0), 132);
  pvd.set(dotRec, 156);
  pvd.fill(0x20, 190, 813);
  const d16 = enc.encode("0000000000000000");
  for (const off of [813, 830, 847, 864]) {
    pvd.set(d16, off);
    pvd[off + 16] = 0;
  }
  pvd[881] = 1;

  const vdst = new Uint8Array(S);
  vdst[0] = 255;
  vdst.set(enc.encode("CD001"), 1);
  vdst[6] = 1;

  const iso = new Uint8Array(totalSectors * S);
  iso.set(pvd, 16 * S);
  iso.set(vdst, 17 * S);
  iso.set(rootDir, 18 * S);
  for (let i = 0; i < encoded.length; i++) {
    iso.set(encoded[i][1], extents[i] * S);
  }
  return iso;
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

function pacmanMirrorlist(mirrors: string[]): string {
  return [
    "## Managed by Swamp arch-cloud-init.",
    "## Prefer Belgian and German Arch Linux mirrors for local lab VMs.",
    ...mirrors.map((mirror) => `Server = ${mirror}`),
    "",
  ].join("\n");
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function isValidOpenSshPublicKey(value: string): boolean {
  const match = value.match(
    /^([A-Za-z0-9@._+-]{1,128})[ \t]+([A-Za-z0-9+/]+={0,2})(?:[ \t]+.*)?$/,
  );
  if (!match || match[2].length % 4 !== 0) return false;

  let blob: Uint8Array;
  try {
    blob = Uint8Array.from(atob(match[2]), (byte) => byte.charCodeAt(0));
  } catch {
    return false;
  }
  if (blob.length === 0 || blob.length > 16384) return false;

  let offset = 0;
  const readString = (): Uint8Array | null => {
    if (offset + 4 > blob.length) return null;
    const length = new DataView(
      blob.buffer,
      blob.byteOffset + offset,
      4,
    ).getUint32(0);
    offset += 4;
    if (length === 0 || length > blob.length - offset) return null;
    const result = blob.subarray(offset, offset + length);
    offset += length;
    return result;
  };
  const decode = (bytes: Uint8Array | null): string | null => {
    if (!bytes) return null;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  };

  const wireType = decode(readString());
  if (wireType !== match[1]) return false;

  if (wireType === "ssh-ed25519") {
    return readString()?.length === 32 && offset === blob.length;
  }
  if (wireType === "ssh-rsa") {
    return readString() !== null && readString() !== null &&
      offset === blob.length;
  }
  if (wireType === "ssh-dss") {
    return readString() !== null && readString() !== null &&
      readString() !== null && readString() !== null &&
      offset === blob.length;
  }
  const ecdsa = wireType?.match(/^ecdsa-sha2-(nistp(?:256|384|521))$/);
  if (ecdsa) {
    return decode(readString()) === ecdsa[1] && readString() !== null &&
      offset === blob.length;
  }
  if (wireType === "sk-ssh-ed25519@openssh.com") {
    return readString()?.length === 32 && readString() !== null &&
      offset === blob.length;
  }
  if (wireType === "sk-ecdsa-sha2-nistp256@openssh.com") {
    return decode(readString()) === "nistp256" && readString() !== null &&
      readString() !== null && offset === blob.length;
  }
  return false;
}

/** Render the cloud-config user-data installed in the NoCloud seed image. */
export function makeCloudInitUserData(args: {
  sshUser: string;
  sshPubKey: string;
  pacmanMirrors: string[];
  extraRuncmd: string[];
}): string {
  return [
    "#cloud-config",
    "users:",
    `  - name: ${yamlScalar(args.sshUser)}`,
    `    sudo: ${yamlScalar("ALL=(ALL) NOPASSWD:ALL")}`,
    "    groups: [wheel]",
    `    shell: ${yamlScalar("/bin/bash")}`,
    "    ssh_authorized_keys:",
    `      - ${yamlScalar(args.sshPubKey)}`,
    "write_files:",
    `  - path: ${yamlScalar("/etc/pacman.d/mirrorlist")}`,
    `    owner: ${yamlScalar("root:root")}`,
    `    permissions: ${yamlScalar("0644")}`,
    `    content: ${yamlScalar(pacmanMirrorlist(args.pacmanMirrors))}`,
    "packages:",
    `  - ${yamlScalar("openssh")}`,
    "runcmd:",
    `  - ${yamlScalar("systemctl enable --now sshd")}`,
    ...args.extraRuncmd.map((cmd) => `  - ${yamlScalar(cmd)}`),
    "",
  ].join("\n");
}

/** Render cloud-init metadata with safely encoded scalar values. */
export function makeCloudInitMetaData(
  vmName: string,
  hostname: string,
): string {
  return [
    `instance-id: ${yamlScalar(`${vmName}-1`)}`,
    `local-hostname: ${yamlScalar(hostname)}`,
    "",
  ].join("\n");
}

/** Render cloud-init v2 network configuration for matching interfaces. */
export function makeCloudInitNetworkConfig(args: {
  interfaceMatch: string;
  ipAddress: string;
  gateway: string;
  nameserver: string;
}): string {
  return [
    "version: 2",
    "ethernets:",
    "  primary:",
    "    match:",
    `      name: ${yamlScalar(args.interfaceMatch)}`,
    "    addresses:",
    `      - ${yamlScalar(args.ipAddress)}`,
    "    routes:",
    `      - to: ${yamlScalar("default")}`,
    `        via: ${yamlScalar(args.gateway)}`,
    "    nameservers:",
    "      addresses:",
    `        - ${yamlScalar(args.nameserver)}`,
    "",
  ].join("\n");
}

const GlobalArgsSchema = z.object({
  vmName: z.string().min(1).max(64).regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$/,
    "VM name must be a path-safe name",
  ).describe(
    "VM name — used as prefix for disk and ISO filenames",
  ),
  hostname: z.string().min(1).max(253).refine(
    (value) =>
      value.split(".").every((label) =>
        /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)
      ),
    "Hostname must be a valid DNS hostname",
  ).describe("cloud-init local-hostname"),
  ipAddress: z.string().refine(
    (value) =>
      z.cidrv4().safeParse(value).success ||
      z.cidrv6().safeParse(value).success,
    "Static IP address must be IPv4 or IPv6 CIDR notation",
  ).describe(
    "Static IP address with prefix length (e.g. 192.0.2.12/24)",
  ),
  gateway: z.string().refine(
    (value) =>
      z.ipv4().safeParse(value).success ||
      z.ipv6().safeParse(value).success,
    "Default gateway must be an IPv4 or IPv6 address",
  ).describe("Default gateway IP"),
  nameserver: z.string().refine(
    (value) =>
      z.ipv4().safeParse(value).success ||
      z.ipv6().safeParse(value).success,
    "DNS nameserver must be an IPv4 or IPv6 address",
  ).describe("DNS nameserver IP"),
  networkInterfaceMatch: z.string().min(1).max(64).regex(
    /^[A-Za-z0-9*?_.:-]+$/,
    "Interface match must be a simple interface-name glob",
  ).default("en*").describe(
    "cloud-init interface-name glob; defaults to common predictable libvirt names",
  ),
  sshUser: z.string().min(1).max(32).regex(
    /^[a-z_][a-z0-9_-]*[$]?$/,
    "SSH user must be a valid Linux username",
  ).default("admin").describe(
    "Non-root user to create via cloud-init",
  ),
  sshPubKeyPath: z.string().min(1).max(4096).regex(
    /^[^\0\r\n]+$/,
    "Paths must not contain NUL or newlines",
  ).default("~/.ssh/id_ed25519.pub").describe(
    "Path to SSH public key for the created user",
  ),
  diskSizeGb: z.number().int().min(1).max(16384).default(20).describe(
    "Overlay disk size in GiB",
  ),
  imagesDir: z.string().min(1).max(4096).regex(
    /^[^\0\r\n]+$/,
    "Paths must not contain NUL or newlines",
  ).default("/var/lib/libvirt/images").describe(
    "Directory where VM images are stored",
  ),
  baseImagePath: z.string().min(1).max(4096).regex(
    /^[^\0\r\n]+$/,
    "Paths must not contain NUL or newlines",
  ).default(
    "/var/lib/libvirt/images/arch-cloud-base.qcow2",
  ).describe("Path for the shared Arch Linux base image"),
  baseImageUrl: z.string().url().max(2048).regex(/^https?:\/\//).refine(
    (value) => {
      const url = new URL(value);
      return !url.username && !url.password;
    },
    "Base image URL must not contain embedded credentials",
  ).default(
    "https://geo.mirror.pkgbuild.com/images/latest/Arch-Linux-x86_64-cloudimg.qcow2",
  ).describe("URL for downloading the Arch Linux cloud image"),
  extraRuncmd: z.array(
    z.string().max(4096).refine(
      (value) => value.trim().length > 0,
      "Commands must not be empty",
    ),
  ).max(100).default([])
    .describe(
      "Additional cloud-init runcmd entries appended after enabling sshd",
    ),
  pacmanMirrors: z.array(
    z.string().url().max(2048).regex(
      /^https?:\/\/\S+$/,
      "Mirror URLs must be HTTP(S) URLs without whitespace",
    ),
  ).min(1).max(20).default([
    "https://archlinux.cu.be/$repo/os/$arch",
    "https://mirror.netcologne.de/archlinux/$repo/os/$arch",
    "https://ftp.halifax.rwth-aachen.de/archlinux/$repo/os/$arch",
  ]).describe(
    "Ordered Arch Linux pacman mirrors written to /etc/pacman.d/mirrorlist during cloud-init",
  ),
  fileAclUser: z.string().min(1).max(32).regex(
    /^[a-z_][a-z0-9_-]*[$]?$/,
    "ACL user must be a valid Linux username",
  ).optional().describe(
    "Optional user to grant rw ACLs on generated image files, e.g. qemu",
  ),
}).superRefine((args, context) => {
  if (args.ipAddress.includes(":") !== args.gateway.includes(":")) {
    context.addIssue({
      code: "custom",
      path: ["gateway"],
      message: "Gateway IP family must match ipAddress",
    });
  }
});

const PrepResultSchema = z.object({
  vmName: z.string(),
  diskPath: z.string(),
  isoPath: z.string(),
  baseImagePath: z.string(),
  baseImageDownloaded: z.boolean(),
  diskCreated: z.boolean(),
  isoCreated: z.boolean(),
  fileAclUser: z.string().optional(),
  preparedAt: z.string(),
});

function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const separator = trimmed.lastIndexOf("/");
  if (separator < 0) return ".";
  return separator === 0 ? "/" : trimmed.slice(0, separator);
}

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

async function canonicalTargetPath(path: string): Promise<string> {
  try {
    return await DenoFs.realPath(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  const canonicalParent = await DenoFs.realPath(parentPath(path));
  return `${canonicalParent.replace(/\/+$/, "")}/${baseName(path)}`;
}

function redactUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function requireDirectory(path: string, label: string): Promise<void> {
  let stat: Deno.FileInfo;
  try {
    stat = await DenoFs.stat(path);
  } catch (err) {
    throw new Error(
      `${label} is not accessible at ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!stat.isDirectory) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
}

async function requireWritableDirectory(
  path: string,
  label: string,
): Promise<void> {
  await requireDirectory(path, label);
  const probePath = `${path}/.arch-cloud-init-${crypto.randomUUID()}.tmp`;
  try {
    const probe = await DenoFs.open(probePath, {
      write: true,
      createNew: true,
    });
    probe.close();
  } catch (err) {
    throw new Error(
      `${label} is not writable at ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    await DenoFs.remove(probePath).catch(() => {});
  }
}

async function artifactExists(path: string, label: string): Promise<boolean> {
  let stat: Deno.FileInfo;
  try {
    stat = await DenoFs.stat(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw new Error(
      `Cannot inspect ${label} at ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!stat.isFile || stat.size <= 0) {
    throw new Error(`${label} must be a regular non-empty file: ${path}`);
  }
  return true;
}

async function requireValidIso(path: string): Promise<void> {
  await artifactExists(path, "cloud-init ISO");
  const file = await DenoFs.open(path, { read: true });
  const signatureBytes = new Uint8Array(5);
  let bytesRead: number | null;
  try {
    await file.seek(16 * 2048 + 1, Deno.SeekMode.Start);
    bytesRead = await file.read(signatureBytes);
  } finally {
    file.close();
  }
  const signature = new TextDecoder().decode(signatureBytes);
  if (bytesRead !== signatureBytes.length || signature !== "CD001") {
    throw new Error(
      `Cloud-init ISO has an invalid ISO 9660 signature: ${path}`,
    );
  }
}

async function runCommand(
  command: string,
  args: string[],
  description: string,
): Promise<Deno.CommandOutput> {
  const result = await new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (result.code !== 0) {
    throw new Error(
      `${description} failed (exit ${result.code}): ${
        new TextDecoder().decode(result.stderr).slice(-500)
      }`,
    );
  }
  return result;
}

interface Qcow2Info {
  format?: unknown;
  "backing-filename"?: unknown;
  "full-backing-filename"?: unknown;
  "virtual-size"?: unknown;
}

async function readQcow2Info(path: string, label: string): Promise<Qcow2Info> {
  await artifactExists(path, label);
  const result = await runCommand(
    "qemu-img",
    ["info", "--output=json", path],
    `Validating ${label}`,
  );
  let info: Qcow2Info;
  try {
    info = JSON.parse(new TextDecoder().decode(result.stdout));
  } catch {
    throw new Error(`qemu-img returned invalid metadata for ${label}: ${path}`);
  }
  if (info.format !== "qcow2") {
    throw new Error(`${label} is not a qcow2 image: ${path}`);
  }
  return info;
}

async function requireValidBaseQcow2(
  path: string,
  label: string,
): Promise<void> {
  await readQcow2Info(path, label);
}

async function requireValidOverlayQcow2(
  path: string,
  expectedBasePath: string,
  diskSizeGb: number,
  label: string,
): Promise<void> {
  const info = await readQcow2Info(path, label);
  const fullBacking = info["full-backing-filename"];
  const backing = info["backing-filename"];
  const backingPath = typeof fullBacking === "string"
    ? fullBacking
    : typeof backing === "string"
    ? backing.startsWith("/") ? backing : `${parentPath(path)}/${backing}`
    : null;
  if (!backingPath) {
    throw new Error(`${label} has no backing image: ${path}`);
  }
  const canonicalBacking = await canonicalTargetPath(backingPath);
  if (canonicalBacking !== expectedBasePath) {
    throw new Error(
      `${label} backing image ${canonicalBacking} does not match configured base image ${expectedBasePath}`,
    );
  }
  const minimumSize = diskSizeGb * 1024 ** 3;
  if (
    typeof info["virtual-size"] !== "number" ||
    !Number.isFinite(info["virtual-size"]) ||
    info["virtual-size"] < minimumSize
  ) {
    throw new Error(
      `${label} virtual size must be at least ${diskSizeGb} GiB: ${path}`,
    );
  }
}

async function publishTemporaryFile(
  temporaryPath: string,
  finalPath: string,
  label: string,
): Promise<boolean> {
  try {
    await DenoFs.link(temporaryPath, finalPath);
    return true;
  } catch (linkError) {
    if (await artifactExists(finalPath, label)) return false;
    throw linkError;
  }
}

// ─── Model ────────────────────────────────────────────────────────────────────

/** Arch Linux cloud-init image prep: downloads base image, creates qcow2 overlay, and generates NoCloud seed ISO. Idempotent — skips steps that are already complete. */
export const model = {
  type: "@evrardjp/arch-cloud-init",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    prep: {
      description:
        "Result of the image preparation (disk and ISO paths, what was created)",
      schema: PrepResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  files: {
    log: {
      description: "Preparation log",
      contentType: "text/plain",
      lifetime: "7d",
      garbageCollection: 5,
      streaming: true,
    },
  },
  methods: {
    prepare: {
      description:
        "Download base Arch image if absent, create qcow2 overlay, and write cloud-init NoCloud seed ISO to disk",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const {
          vmName,
          hostname,
          ipAddress,
          gateway,
          nameserver,
          networkInterfaceMatch,
          sshUser,
          sshPubKeyPath,
          diskSizeGb,
          imagesDir,
          baseImagePath,
          baseImageUrl,
          extraRuncmd,
          pacmanMirrors,
          fileAclUser,
        } = context.globalArgs;

        const diskPath = `${imagesDir}/${vmName}.qcow2`;
        const isoPath = `${imagesDir}/${vmName}-cloud-init.iso`;
        const displayedBaseImageUrl = redactUrl(baseImageUrl);

        const logWriter = context.createFileWriter("log", "prepare");
        const log = async (msg: string) => {
          context.logger.info(msg);
          await logWriter.writeLine(msg);
        };
        let logFinalized = false;
        const finalizeLog = async () => {
          logFinalized = true;
          return await logWriter.finalize();
        };

        let baseImageDownloaded = false;
        let diskCreated = false;
        let isoCreated = false;
        try {
          if (
            sshPubKeyPath.startsWith("~") && !sshPubKeyPath.startsWith("~/")
          ) {
            throw new Error("sshPubKeyPath only supports the ~/ tilde form");
          }
          const home = sshPubKeyPath.startsWith("~/")
            ? DenoFs.env.get("HOME")
            : undefined;
          if (sshPubKeyPath.startsWith("~/") && !home) {
            throw new Error("HOME is required to expand sshPubKeyPath");
          }
          const resolvedKeyPath = sshPubKeyPath.startsWith("~/")
            ? `${home}${sshPubKeyPath.slice(1)}`
            : sshPubKeyPath;

          await requireWritableDirectory(imagesDir, "imagesDir");
          const baseImageDirectory = parentPath(baseImagePath);
          if (baseImageDirectory !== imagesDir) {
            await requireWritableDirectory(
              baseImageDirectory,
              "base image directory",
            );
          }
          const [canonicalBasePath, canonicalDiskPath, canonicalIsoPath] =
            await Promise.all([
              canonicalTargetPath(baseImagePath),
              canonicalTargetPath(diskPath),
              canonicalTargetPath(isoPath),
            ]);
          if (
            new Set([
              canonicalBasePath,
              canonicalDiskPath,
              canonicalIsoPath,
            ]).size !== 3
          ) {
            throw new Error(
              "Base image, overlay disk, and cloud-init ISO paths must resolve to distinct files",
            );
          }

          await artifactExists(resolvedKeyPath, "SSH public key");
          const sshPubKey = (await DenoFs.readTextFile(resolvedKeyPath)).trim();
          if (
            sshPubKey.length > 16384 || sshPubKey.includes("\n") ||
            !isValidOpenSshPublicKey(sshPubKey)
          ) {
            throw new Error(
              `SSH public key must contain one valid OpenSSH public-key line: ${resolvedKeyPath}`,
            );
          }

          // Inspect every existing artifact before making durable changes.
          const baseExists = await artifactExists(baseImagePath, "base image");
          const diskExists = await artifactExists(diskPath, "overlay disk");
          const isoExists = await artifactExists(isoPath, "cloud-init ISO");
          if (isoExists) await requireValidIso(isoPath);

          await runCommand("qemu-img", ["--version"], "qemu-img preflight");
          if (fileAclUser) {
            await runCommand("setfacl", ["--version"], "setfacl preflight");
          }
          if (baseExists) {
            await requireValidBaseQcow2(baseImagePath, "base image");
          }
          if (diskExists) {
            await requireValidOverlayQcow2(
              diskPath,
              canonicalBasePath,
              diskSizeGb,
              "overlay disk",
            );
          }

          // 1. Download and atomically publish the shared base image.
          if (!baseExists) {
            await log(
              `Downloading Arch Linux cloud image from ${displayedBaseImageUrl}…`,
            );
            const temporaryBasePath =
              `${baseImagePath}.${crypto.randomUUID()}.tmp`;
            try {
              const resp = await fetch(baseImageUrl, {
                signal: context.signal,
              });
              if (!resp.ok || !resp.body) {
                await resp.body?.cancel().catch(() => {});
                throw new Error(
                  `Failed to download base image: HTTP ${resp.status} from ${displayedBaseImageUrl}`,
                );
              }
              const file = await DenoFs.open(temporaryBasePath, {
                write: true,
                createNew: true,
              });
              await resp.body.pipeTo(file.writable);
              await requireValidBaseQcow2(
                temporaryBasePath,
                "downloaded base image",
              );
              baseImageDownloaded = await publishTemporaryFile(
                temporaryBasePath,
                baseImagePath,
                "base image",
              );
              await requireValidBaseQcow2(baseImagePath, "base image");
              await log(
                baseImageDownloaded
                  ? `Base image saved to ${baseImagePath}`
                  : `Base image already published concurrently: ${baseImagePath}`,
              );
            } finally {
              await DenoFs.remove(temporaryBasePath).catch(() => {});
            }
          } else {
            await log(`Base image already present and valid: ${baseImagePath}`);
          }

          // 2. Create and atomically publish the qcow2 overlay.
          if (!diskExists) {
            await log(`Creating ${diskSizeGb}G qcow2 overlay at ${diskPath}…`);
            const temporaryDiskPath = `${diskPath}.${crypto.randomUUID()}.tmp`;
            try {
              await runCommand(
                "qemu-img",
                [
                  "create",
                  "-f",
                  "qcow2",
                  "-b",
                  canonicalBasePath,
                  "-F",
                  "qcow2",
                  temporaryDiskPath,
                  `${diskSizeGb}G`,
                ],
                "qemu-img create",
              );
              await requireValidOverlayQcow2(
                temporaryDiskPath,
                canonicalBasePath,
                diskSizeGb,
                "new overlay disk",
              );
              diskCreated = await publishTemporaryFile(
                temporaryDiskPath,
                diskPath,
                "overlay disk",
              );
              await requireValidOverlayQcow2(
                diskPath,
                canonicalBasePath,
                diskSizeGb,
                "overlay disk",
              );
              await log(
                diskCreated
                  ? `Overlay disk created: ${diskPath}`
                  : `Overlay disk already published concurrently: ${diskPath}`,
              );
            } finally {
              await DenoFs.remove(temporaryDiskPath).catch(() => {});
            }
          } else {
            await log(`Overlay disk already present and valid: ${diskPath}`);
          }

          // 3. Generate and atomically publish the cloud-init ISO.
          if (!isoExists) {
            const metaData = makeCloudInitMetaData(vmName, hostname);
            const networkConfig = makeCloudInitNetworkConfig({
              interfaceMatch: networkInterfaceMatch,
              ipAddress,
              gateway,
              nameserver,
            });
            const userData = makeCloudInitUserData({
              sshUser,
              sshPubKey,
              pacmanMirrors,
              extraRuncmd,
            });
            const isoBytes = makeCloudInitIso([
              ["meta-data", metaData],
              ["network-config", networkConfig],
              ["user-data", userData],
            ]);
            const temporaryIsoPath = `${isoPath}.${crypto.randomUUID()}.tmp`;
            await log(`Generating cloud-init ISO at ${isoPath}…`);
            try {
              await DenoFs.writeFile(temporaryIsoPath, isoBytes, {
                createNew: true,
              });
              await requireValidIso(temporaryIsoPath);
              isoCreated = await publishTemporaryFile(
                temporaryIsoPath,
                isoPath,
                "cloud-init ISO",
              );
              await requireValidIso(isoPath);
              await log(
                isoCreated
                  ? `Cloud-init ISO created: ${isoPath} (${isoBytes.length} bytes)`
                  : `Cloud-init ISO already published concurrently: ${isoPath}`,
              );
            } finally {
              await DenoFs.remove(temporaryIsoPath).catch(() => {});
            }
          } else {
            await log(`Cloud-init ISO already present and valid: ${isoPath}`);
          }

          if (fileAclUser) {
            await log(`Granting ${fileAclUser} rw ACLs on image artifacts…`);
            await runCommand(
              "setfacl",
              [
                "-m",
                `u:${fileAclUser}:rw`,
                baseImagePath,
                diskPath,
                isoPath,
              ],
              "setfacl",
            );
          }

          const handle = await context.writeResource("prep", "current", {
            vmName,
            diskPath,
            isoPath,
            baseImagePath,
            baseImageDownloaded,
            diskCreated,
            isoCreated,
            fileAclUser,
            preparedAt: new Date().toISOString(),
          });
          const logHandle = await finalizeLog();
          return { dataHandles: [handle, logHandle] };
        } catch (err) {
          const rawMessage = err instanceof Error ? err.message : String(err);
          const message = rawMessage.split(baseImageUrl).join(
            displayedBaseImageUrl,
          );
          context.logger.error(message);
          await logWriter.writeLine(`ERROR: ${message}`).catch(() => {});
          if (message !== rawMessage) throw new Error(message);
          throw err;
        } finally {
          if (!logFinalized) {
            await finalizeLog().catch((err) => {
              context.logger.error(
                `Failed to finalize preparation log: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
          }
        }
      },
    },
  },
} satisfies ModelDefinition<typeof GlobalArgsSchema>;
