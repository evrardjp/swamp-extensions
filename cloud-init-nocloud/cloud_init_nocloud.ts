import { z } from "npm:zod@4";

// @ts-ignore: Deno global available at bundle runtime
const DenoFs = {
  writeFile: (p: string, d: Uint8Array) => Deno.writeFile(p, d),
  stat: (p: string) => Deno.stat(p),
};

const SECTOR_SIZE = 2048;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Build a minimal ISO 9660 filesystem suitable for cloud-init NoCloud seed data. */
export function makeNoCloudIso(files: Array<[string, string]>): Uint8Array {
  if (files.length === 0) {
    throw new Error("At least one file is required to build a NoCloud ISO");
  }

  const seen = new Set<string>();
  const encoded: Array<[Uint8Array, Uint8Array]> = files
    .map(([name, content]): [Uint8Array, Uint8Array] => {
      const normalized = name.trim();
      if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
        throw new Error(`Invalid ISO filename ${JSON.stringify(name)}`);
      }
      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        throw new Error(`Duplicate ISO filename ${normalized}`);
      }
      seen.add(key);
      return [
        encoder.encode(normalized.toUpperCase()),
        encoder.encode(content),
      ];
    })
    .sort((a, b) => decoder.decode(a[0]).localeCompare(decoder.decode(b[0])));

  let lba = 19;
  const extents: number[] = [];
  for (const [, data] of encoded) {
    extents.push(lba);
    lba += Math.ceil(data.length / SECTOR_SIZE) || 1;
  }
  const totalSectors = lba;

  const u32b = (v: number): Uint8Array =>
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
  const u16b = (v: number): Uint8Array =>
    new Uint8Array([v & 0xFF, (v >> 8) & 0xFF, (v >> 8) & 0xFF, v & 0xFF]);

  const dirRecord = (
    nameBytes: Uint8Array,
    isDir: boolean,
    extentLba: number,
    dataLen: number,
  ): Uint8Array => {
    const nameLength = nameBytes.length;
    const record = new Uint8Array(
      33 + nameLength + (nameLength % 2 === 0 ? 1 : 0),
    );
    let offset = 0;
    record[offset++] = record.length;
    record[offset++] = 0;
    record.set(u32b(extentLba), offset);
    offset += 8;
    record.set(u32b(dataLen), offset);
    offset += 8;
    record[offset++] = 126;
    record[offset++] = 6;
    record[offset++] = 25;
    record[offset++] = 0;
    record[offset++] = 0;
    record[offset++] = 0;
    record[offset++] = 0;
    record[offset++] = isDir ? 2 : 0;
    record[offset++] = 0;
    record[offset++] = 0;
    record.set(u16b(1), offset);
    offset += 4;
    record[offset++] = nameLength;
    record.set(nameBytes, offset);
    return record;
  };

  const dotRecord = dirRecord(new Uint8Array([0x00]), true, 18, SECTOR_SIZE);
  const dotdotRecord = dirRecord(new Uint8Array([0x01]), true, 18, SECTOR_SIZE);

  const rootDir = new Uint8Array(SECTOR_SIZE);
  let dirOffset = 0;
  rootDir.set(dotRecord, dirOffset);
  dirOffset += dotRecord.length;
  rootDir.set(dotdotRecord, dirOffset);
  dirOffset += dotdotRecord.length;
  for (let i = 0; i < encoded.length; i++) {
    const record = dirRecord(
      encoded[i][0],
      false,
      extents[i],
      encoded[i][1].length,
    );
    rootDir.set(record, dirOffset);
    dirOffset += record.length;
  }

  const primaryVolumeDescriptor = new Uint8Array(SECTOR_SIZE);
  primaryVolumeDescriptor[0] = 1;
  primaryVolumeDescriptor.set(encoder.encode("CD001"), 1);
  primaryVolumeDescriptor[6] = 1;
  primaryVolumeDescriptor.fill(0x20, 8, 40);
  primaryVolumeDescriptor.set(encoder.encode("CIDATA"), 40);
  primaryVolumeDescriptor.fill(0x20, 46, 72);
  primaryVolumeDescriptor.set(u32b(totalSectors), 80);
  primaryVolumeDescriptor.set(u16b(1), 120);
  primaryVolumeDescriptor.set(u16b(1), 124);
  primaryVolumeDescriptor.set(u16b(SECTOR_SIZE), 128);
  primaryVolumeDescriptor.set(u32b(0), 132);
  primaryVolumeDescriptor.set(dotRecord, 156);
  primaryVolumeDescriptor.fill(0x20, 190, 813);
  const emptyIsoDate = encoder.encode("0000000000000000");
  for (const offset of [813, 830, 847, 864]) {
    primaryVolumeDescriptor.set(emptyIsoDate, offset);
    primaryVolumeDescriptor[offset + 16] = 0;
  }
  primaryVolumeDescriptor[881] = 1;

  const volumeDescriptorTerminator = new Uint8Array(SECTOR_SIZE);
  volumeDescriptorTerminator[0] = 255;
  volumeDescriptorTerminator.set(encoder.encode("CD001"), 1);
  volumeDescriptorTerminator[6] = 1;

  const iso = new Uint8Array(totalSectors * SECTOR_SIZE);
  iso.set(primaryVolumeDescriptor, 16 * SECTOR_SIZE);
  iso.set(volumeDescriptorTerminator, 17 * SECTOR_SIZE);
  iso.set(rootDir, 18 * SECTOR_SIZE);
  for (let i = 0; i < encoded.length; i++) {
    iso.set(encoded[i][1], extents[i] * SECTOR_SIZE);
  }
  return iso;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digestInput = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function defaultMetaData(instanceId: string, localHostname?: string): string {
  return [
    `instance-id: ${instanceId}`,
    ...(localHostname ? [`local-hostname: ${localHostname}`] : []),
    "",
  ].join("\n");
}

const GlobalArgsSchema = z.object({
  defaultInstanceId: z.string().default("swamp-nocloud").describe(
    "Instance ID used when metaData is omitted.",
  ),
  defaultLocalHostname: z.string().optional().describe(
    "Optional local-hostname used when metaData is omitted.",
  ),
  defaultUserData: z.string().optional().describe(
    "Optional default cloud-init user-data content.",
  ),
  defaultNetworkConfig: z.string().optional().describe(
    "Optional default cloud-init network-config content.",
  ),
  defaultOutputPath: z.string().optional().describe(
    "Optional filesystem path where generated ISO bytes are also written.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const GenerateArgsSchema = z.object({
  userData: z.string().optional().describe(
    "cloud-init user-data content. Defaults to globalArguments.defaultUserData.",
  ),
  metaData: z.string().optional().describe(
    "cloud-init meta-data content. If omitted, generated from instanceId/localHostname.",
  ),
  networkConfig: z.string().optional().describe(
    "Optional cloud-init network-config content. Defaults to globalArguments.defaultNetworkConfig.",
  ),
  instanceId: z.string().optional().describe(
    "Instance ID used to generate meta-data when metaData is omitted.",
  ),
  localHostname: z.string().optional().describe(
    "local-hostname used to generate meta-data when metaData is omitted.",
  ),
  outputPath: z.string().optional().describe(
    "Optional filesystem path where generated ISO bytes are also written.",
  ),
  overwrite: z.boolean().default(false).describe(
    "Overwrite outputPath if it already exists.",
  ),
});

const IsoSummarySchema = z.object({
  files: z.array(z.string()),
  byteLength: z.number().int(),
  sha256: z.string(),
  outputPath: z.string().optional(),
  wroteOutputPath: z.boolean(),
  generatedAt: z.string(),
});

/** Generic cloud-init NoCloud ISO generator. */
export const model = {
  type: "@evrardjp/cloud-init-nocloud",
  version: "2026.06.29.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    isoSummary: {
      description: "Summary metadata for the generated NoCloud ISO.",
      schema: IsoSummarySchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  files: {
    iso: {
      description:
        "cloud-init NoCloud seed ISO (ISO 9660, volume label CIDATA).",
      contentType: "application/x-iso9660-image",
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    generate: {
      description:
        "Generate a cloud-init NoCloud seed ISO from user-data, meta-data, and optional network-config.",
      arguments: GenerateArgsSchema,
      execute: async (
        args: z.infer<typeof GenerateArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          createFileWriter: (specName: string, instanceName: string) => {
            writeAll: (content: Uint8Array) => Promise<unknown>;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<unknown>;
          logger: {
            info: (message: string, data?: Record<string, unknown>) => void;
          };
        },
      ) => {
        context.logger.info("Generating NoCloud ISO");
        const userData = args.userData ?? context.globalArgs.defaultUserData;
        if (!userData) {
          throw new Error(
            "userData is required unless globalArguments.defaultUserData is set",
          );
        }

        const metaData = args.metaData ?? defaultMetaData(
          args.instanceId ?? context.globalArgs.defaultInstanceId,
          args.localHostname ?? context.globalArgs.defaultLocalHostname,
        );
        const networkConfig = args.networkConfig ??
          context.globalArgs.defaultNetworkConfig;
        const outputPath = args.outputPath ??
          context.globalArgs.defaultOutputPath;

        const files: Array<[string, string]> = [
          ["meta-data", metaData],
          ["user-data", userData],
        ];
        if (networkConfig) {
          files.push(["network-config", networkConfig]);
        }

        const isoBytes = makeNoCloudIso(files);
        const checksum = await sha256Hex(isoBytes);

        let wroteOutputPath = false;
        if (outputPath) {
          const existing = await DenoFs.stat(outputPath).catch(() => null);
          if (existing && !args.overwrite) {
            throw new Error(
              `Refusing to overwrite existing outputPath ${outputPath}; set overwrite: true`,
            );
          }
          await DenoFs.writeFile(outputPath, isoBytes);
          wroteOutputPath = true;
          context.logger.info("Wrote NoCloud ISO to host path", { outputPath });
        }

        const isoHandle = await context.createFileWriter("iso", "seed")
          .writeAll(isoBytes);
        const summaryHandle = await context.writeResource(
          "isoSummary",
          "current",
          {
            files: files.map(([name]) => name),
            byteLength: isoBytes.length,
            sha256: checksum,
            outputPath,
            wroteOutputPath,
            generatedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Generated NoCloud ISO", {
          byteLength: isoBytes.length,
          fileCount: files.length,
          wroteOutputPath,
        });
        return { dataHandles: [isoHandle, summaryHandle] };
      },
    },
  },
};
