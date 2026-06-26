import { z } from "npm:zod@4";

// @ts-ignore: Deno global available at bundle runtime
const DenoCmd = Deno.Command;
// @ts-ignore: Deno global available at bundle runtime
const DenoFs = {
  stat: (p: string) => Deno.stat(p),
  open: (p: string, o: Deno.OpenOptions) => Deno.open(p, o),
  remove: (p: string) => Deno.remove(p),
};

const GlobalArgsSchema = z.object({
  baseImagePath: z.string().describe("Local path for the base qcow2 image."),
  baseImageUrl: z.string().url().optional().describe(
    "Optional URL to download the base image when baseImagePath is absent.",
  ),
  overlayPath: z.string().describe("Local path for the qcow2 overlay disk."),
  diskSizeGb: z.number().int().positive().default(20).describe(
    "Overlay virtual size in GiB.",
  ),
  fileAclUser: z.string().optional().describe(
    "Optional user to grant rw ACLs on the base and overlay images, e.g. qemu.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const PrepareArgsSchema = z.object({
  forceDownload: z.boolean().default(false).describe(
    "Re-download the base image even when it already exists.",
  ),
  recreateOverlay: z.boolean().default(false).describe(
    "Remove and recreate the overlay when it already exists.",
  ),
});

const OverlayPrepSchema = z.object({
  baseImagePath: z.string(),
  baseImageUrl: z.string().optional(),
  overlayPath: z.string(),
  diskSizeGb: z.number().int(),
  baseImageDownloaded: z.boolean(),
  overlayCreated: z.boolean(),
  fileAclUser: z.string().optional(),
  preparedAt: z.string(),
});

async function runCommand(command: string, args: string[]): Promise<void> {
  const result = await new DenoCmd(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (result.code !== 0) {
    throw new Error(
      `${command} failed (exit ${result.code}): ${
        new TextDecoder().decode(result.stderr).slice(-1000)
      }`,
    );
  }
}

async function downloadFile(url: string, path: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok || !resp.body) {
    throw new Error(
      `Failed to download base image: HTTP ${resp.status} from ${url}`,
    );
  }
  const file = await DenoFs.open(path, {
    write: true,
    create: true,
    truncate: true,
  });
  try {
    await resp.body.pipeTo(file.writable);
  } catch (err) {
    await DenoFs.remove(path).catch(() => {});
    throw new Error(
      `Base image download interrupted and partial file removed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Generic qcow2 overlay preparation model. */
export const model = {
  type: "@evrardjp/qcow2-overlay-prep",
  version: "2026.06.25.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    prep: {
      description: "Result of base-image and qcow2 overlay preparation.",
      schema: OverlayPrepSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    prepare: {
      description:
        "Ensure a base qcow2 image exists and create a qcow2 overlay disk.",
      arguments: PrepareArgsSchema,
      execute: async (
        args: z.infer<typeof PrepareArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
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
        const {
          baseImagePath,
          baseImageUrl,
          overlayPath,
          diskSizeGb,
          fileAclUser,
        } = context.globalArgs;
        context.logger.info("Preparing qcow2 overlay", {
          baseImagePath,
          overlayPath,
        });

        let baseImageDownloaded = false;
        const baseExists = await DenoFs.stat(baseImagePath).catch(() => null);
        if (args.forceDownload && baseExists) {
          await DenoFs.remove(baseImagePath);
        }
        if (args.forceDownload || !baseExists) {
          if (!baseImageUrl) {
            throw new Error(
              `Base image ${baseImagePath} is absent and baseImageUrl is not set`,
            );
          }
          await downloadFile(baseImageUrl, baseImagePath);
          baseImageDownloaded = true;
        }

        let overlayCreated = false;
        const overlayExists = await DenoFs.stat(overlayPath).catch(() => null);
        if (args.recreateOverlay && overlayExists) {
          await DenoFs.remove(overlayPath);
        }
        if (args.recreateOverlay || !overlayExists) {
          await runCommand("qemu-img", [
            "create",
            "-f",
            "qcow2",
            "-b",
            baseImagePath,
            "-F",
            "qcow2",
            overlayPath,
            `${diskSizeGb}G`,
          ]);
          overlayCreated = true;
        }

        if (fileAclUser) {
          await runCommand("setfacl", [
            "-m",
            `u:${fileAclUser}:rw`,
            baseImagePath,
            overlayPath,
          ]);
        }

        const handle = await context.writeResource("prep", "current", {
          baseImagePath,
          baseImageUrl,
          overlayPath,
          diskSizeGb,
          baseImageDownloaded,
          overlayCreated,
          fileAclUser,
          preparedAt: new Date().toISOString(),
        });
        context.logger.info("Prepared qcow2 overlay", {
          baseImageDownloaded,
          overlayCreated,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
