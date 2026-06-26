import { z } from "npm:zod@4";
import type { ModelDefinition } from "jsr:@systeminit/swamp-testing@0.20260518.13";

// @ts-ignore: Deno global available at bundle runtime
const DenoCmd = Deno.Command;
// @ts-ignore: Deno global available at bundle runtime
const DenoFs = {
  stat: (p: string) => Deno.stat(p),
  open: (p: string, o: Deno.OpenOptions) => Deno.open(p, o),
  writeFile: (p: string, d: Uint8Array) => Deno.writeFile(p, d),
  readTextFile: (p: string) => Deno.readTextFile(p),
  remove: (p: string) => Deno.remove(p),
  env: Deno.env,
};

// ─── ISO 9660 builder ─────────────────────────────────────────────────────────
// Generates a minimal cloud-init NoCloud seed image supporting 2 or 3 files.
// Uppercased filenames; Linux isofs map=normal lowercases on mount.

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
  const totalSectors = lba;

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

const GlobalArgsSchema = z.object({
  vmName: z.string().describe(
    "VM name — used as prefix for disk and ISO filenames",
  ),
  hostname: z.string().describe("cloud-init local-hostname"),
  ipAddress: z.string().describe(
    "Static IP address with prefix length (e.g. 192.168.164.12/24)",
  ),
  gateway: z.string().describe("Default gateway IP"),
  nameserver: z.string().describe("DNS nameserver IP"),
  sshUser: z.string().default("admin").describe(
    "Non-root user to create via cloud-init",
  ),
  sshPubKeyPath: z.string().default("~/.ssh/id_ed25519.pub").describe(
    "Path to SSH public key for the created user",
  ),
  diskSizeGb: z.number().int().default(20).describe("Overlay disk size in GiB"),
  imagesDir: z.string().default("/var/lib/libvirt/images").describe(
    "Directory where VM images are stored",
  ),
  baseImagePath: z.string().default(
    "/var/lib/libvirt/images/arch-cloud-base.qcow2",
  ).describe("Path for the shared Arch Linux base image"),
  baseImageUrl: z.string().default(
    "https://geo.mirror.pkgbuild.com/images/latest/Arch-Linux-x86_64-cloudimg.qcow2",
  ).describe("URL for downloading the Arch Linux cloud image"),
  extraRuncmd: z.array(z.string()).default([]).describe(
    "Additional cloud-init runcmd entries appended after enabling sshd",
  ),
  fileAclUser: z.string().optional().describe(
    "Optional user to grant rw ACLs on generated image files, e.g. qemu",
  ),
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

// ─── Model ────────────────────────────────────────────────────────────────────

/** Arch Linux cloud-init image prep: downloads base image, creates qcow2 overlay, and generates NoCloud seed ISO. Idempotent — skips steps that are already complete. */
export const model = {
  type: "@evrardjp/arch-cloud-init",
  version: "2026.06.25.1",
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
          sshUser,
          sshPubKeyPath,
          diskSizeGb,
          imagesDir,
          baseImagePath,
          baseImageUrl,
          extraRuncmd,
          fileAclUser,
        } = context.globalArgs;

        const diskPath = `${imagesDir}/${vmName}.qcow2`;
        const isoPath = `${imagesDir}/${vmName}-cloud-init.iso`;
        const resolvedKeyPath = sshPubKeyPath.replace(
          /^~/,
          DenoFs.env.get("HOME") ?? "",
        );

        const logWriter = context.createFileWriter("log", "prepare");
        const log = async (msg: string) => {
          context.logger.info(msg);
          await logWriter.writeLine(msg);
        };

        let baseImageDownloaded = false;
        let diskCreated = false;
        let isoCreated = false;

        // 1. Download base image
        const baseStat = await DenoFs.stat(baseImagePath).catch(() => null);
        if (!baseStat) {
          await log(`Downloading Arch Linux cloud image from ${baseImageUrl}…`);
          const resp = await fetch(baseImageUrl);
          if (!resp.ok || !resp.body) {
            throw new Error(
              `Failed to download base image: HTTP ${resp.status} from ${baseImageUrl}`,
            );
          }
          const file = await DenoFs.open(baseImagePath, {
            write: true,
            create: true,
          });
          try {
            await resp.body.pipeTo(file.writable);
          } catch (err) {
            await DenoFs.remove(baseImagePath).catch(() => {});
            throw new Error(
              `Base image download interrupted and partial file removed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          baseImageDownloaded = true;
          await log(`Base image saved to ${baseImagePath}`);
        } else {
          await log(`Base image already present: ${baseImagePath}`);
        }

        // 2. Create qcow2 overlay
        const diskStat = await DenoFs.stat(diskPath).catch(() => null);
        if (!diskStat) {
          await log(`Creating ${diskSizeGb}G qcow2 overlay at ${diskPath}…`);
          const proc = new DenoCmd("qemu-img", {
            args: [
              "create",
              "-f",
              "qcow2",
              "-b",
              baseImagePath,
              "-F",
              "qcow2",
              diskPath,
              `${diskSizeGb}G`,
            ],
            stdout: "piped",
            stderr: "piped",
          });
          const result = await proc.output();
          if (result.code !== 0) {
            throw new Error(
              `qemu-img failed (exit ${result.code}): ${
                new TextDecoder().decode(result.stderr).slice(-500)
              }`,
            );
          }
          diskCreated = true;
          await log(`Overlay disk created: ${diskPath}`);
        } else {
          await log(`Overlay disk already present: ${diskPath}`);
        }

        // 3. Generate cloud-init ISO
        const isoStat = await DenoFs.stat(isoPath).catch(() => null);
        if (!isoStat) {
          const sshPubKey = (await DenoFs.readTextFile(resolvedKeyPath)).trim();

          const metaData = [
            `instance-id: ${vmName}-1`,
            `local-hostname: ${hostname}`,
            "",
          ].join("\n");

          const networkConfig = [
            "version: 2",
            "ethernets:",
            "  eth0:",
            `    addresses: [${ipAddress}]`,
            `    gateway4: ${gateway}`,
            "    nameservers:",
            `      addresses: [${nameserver}]`,
            "",
          ].join("\n");

          const userData = [
            "#cloud-config",
            "users:",
            `  - name: ${sshUser}`,
            "    sudo: ALL=(ALL) NOPASSWD:ALL",
            "    groups: [wheel]",
            "    shell: /bin/bash",
            "    ssh_authorized_keys:",
            `      - ${sshPubKey}`,
            "packages:",
            "  - openssh",
            "runcmd:",
            "  - systemctl enable --now sshd",
            ...extraRuncmd.map((cmd) => `  - ${cmd}`),
            "",
          ].join("\n");

          await log(`Generating cloud-init ISO at ${isoPath}…`);
          const isoBytes = makeCloudInitIso([
            ["meta-data", metaData],
            ["network-config", networkConfig],
            ["user-data", userData],
          ]);
          await DenoFs.writeFile(isoPath, isoBytes);
          isoCreated = true;
          await log(
            `Cloud-init ISO created: ${isoPath} (${isoBytes.length} bytes)`,
          );
        } else {
          await log(`Cloud-init ISO already present: ${isoPath}`);
        }

        if (fileAclUser) {
          await log(`Granting ${fileAclUser} rw ACLs on image artifacts…`);
          const proc = new DenoCmd("setfacl", {
            args: [
              "-m",
              `u:${fileAclUser}:rw`,
              baseImagePath,
              diskPath,
              isoPath,
            ],
            stdout: "piped",
            stderr: "piped",
          });
          const result = await proc.output();
          if (result.code !== 0) {
            throw new Error(
              `setfacl failed (exit ${result.code}): ${
                new TextDecoder().decode(result.stderr).slice(-500)
              }`,
            );
          }
        }

        const logHandle = await logWriter.finalize();
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

        return { dataHandles: [handle, logHandle] };
      },
    },
  },
} satisfies ModelDefinition<typeof GlobalArgsSchema>;
