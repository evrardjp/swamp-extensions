import { z } from "npm:zod@4";
import type { ModelDefinition } from "jsr:@systeminit/swamp-testing@0.20260518.13";

// @ts-ignore: Deno global available at bundle runtime
const DenoCmd = Deno.Command;
// @ts-ignore: Deno globals available at bundle runtime
const DenoFs = {
  writeTextFile: (p: string, s: string) => Deno.writeTextFile(p, s),
  readTextFile: (p: string) => Deno.readTextFile(p),
  makeTempDir: () => Deno.makeTempDir(),
  remove: (p: string, opts?: { recursive?: boolean }) =>
    Deno.remove(p, opts).catch(() => {}),
};

const MAX_POOL_SIZE = 20;
const MAX_CONCURRENT_CLUSTER_OPERATIONS = 4;

// ─── Schemas ─────────────────────────────────────────────────────────────────

const GlobalArgsSchema = z.object({
  n: z.number().int().positive().max(MAX_POOL_SIZE).describe(
    `Target pool size (maximum ${MAX_POOL_SIZE})`,
  ),
  kindConfig: z.string().describe("kind cluster config YAML"),
  clusterNamePrefix: z
    .string()
    .default("swamp-pool")
    .describe("Prefix for kind cluster names"),
  kindBinary: z.string().default("kind").describe("Path to kind binary"),
});

const ClusterEntrySchema = z.object({
  clusterName: z.string(),
  state: z.enum(["ready", "in_use", "deleting", "deleted", "failed"]),
  kubeconfig: z.string(), // base64-encoded kubeconfig YAML
  createdAt: z.string(),
  reservedAt: z.string().optional(),
  testId: z.string().optional(),
});

const PoolStateSchema = z.object({
  clusters: z.record(z.string(), ClusterEntrySchema),
});

const ReserveOutputSchema = z.object({
  clusterId: z.string(),
  clusterName: z.string(),
  kubeconfig: z.string(), // base64-encoded kubeconfig YAML
});

const StatusOutputSchema = z.object({
  n: z.number().int(),
  ready: z.number().int(),
  inUse: z.number().int(),
  deleting: z.number().int(),
  deleted: z.number().int(),
  failed: z.number().int(),
  total: z.number().int(),
  // (ready + in_use + deleting) == n
  invariantOk: z.boolean(),
});

type PoolState = z.infer<typeof PoolStateSchema>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function runCmd(
  binary: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = new DenoCmd(binary, { args, stdout: "piped", stderr: "piped" });
  const result = await proc.output();
  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    code: result.code,
  };
}

async function getKindClusters(kindBinary: string): Promise<string[]> {
  const result = await runCmd(kindBinary, ["get", "clusters"]);
  return parseKindClustersResult(result);
}

/** Parse `kind get clusters`, rejecting failures so reconciliation cannot assume an empty host. */
export function parseKindClustersResult(
  result: { stdout: string; stderr: string; code: number },
): string[] {
  if (result.code !== 0) {
    throw new Error(
      `kind get clusters failed: ${result.stderr.slice(-500)}`,
    );
  }
  return result.stdout.trim().split("\n").filter(Boolean);
}

/** Apply an asynchronous operation with at most `concurrency` active workers. */
export async function forEachWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer");
  }
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      await operation(item);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker(),
    ),
  );
}

async function createCluster(
  kindBinary: string,
  clusterName: string,
  kindConfig: string,
): Promise<string> {
  const tmpDir = await DenoFs.makeTempDir();
  const configPath = `${tmpDir}/kind-config.yaml`;
  const kubeconfigPath = `${tmpDir}/kubeconfig.yaml`;
  try {
    await DenoFs.writeTextFile(configPath, kindConfig);
    const result = await runCmd(kindBinary, [
      "create",
      "cluster",
      "--name",
      clusterName,
      "--config",
      configPath,
      "--kubeconfig",
      kubeconfigPath,
    ]);
    if (result.code !== 0) {
      throw new Error(
        `kind create cluster ${clusterName} failed: ${
          result.stderr.slice(-500)
        }`,
      );
    }
    const kubeconfig = await DenoFs.readTextFile(kubeconfigPath);
    return btoa(kubeconfig);
  } finally {
    await DenoFs.remove(tmpDir, { recursive: true });
  }
}

async function deleteCluster(
  kindBinary: string,
  clusterName: string,
): Promise<void> {
  const result = await runCmd(kindBinary, [
    "delete",
    "cluster",
    "--name",
    clusterName,
  ]);
  if (result.code !== 0) {
    const alreadyGone = result.stderr.includes("not found") ||
      result.stderr.includes("no kind clusters found") ||
      result.stderr.includes("unknown cluster");
    if (!alreadyGone) {
      throw new Error(
        `kind delete cluster ${clusterName} failed: ${
          result.stderr.slice(-500)
        }`,
      );
    }
  }
}

function countByState(
  clusters: PoolState["clusters"],
): Record<string, number> {
  const counts: Record<string, number> = {
    ready: 0,
    in_use: 0,
    deleting: 0,
    deleted: 0,
    failed: 0,
  };
  for (const entry of Object.values(clusters)) {
    counts[entry.state] = (counts[entry.state] ?? 0) + 1;
  }
  return counts;
}

function shortId(): string {
  return crypto.randomUUID().slice(0, 8);
}

async function readState(
  context: {
    readResource?: (name: string) => Promise<Record<string, unknown> | null>;
  },
): Promise<PoolState | null> {
  if (!context.readResource) return null;
  const raw = await context.readResource("state-current");
  if (!raw) return null;
  return PoolStateSchema.parse(raw);
}

// ─── Model ───────────────────────────────────────────────────────────────────

/** Pool of N kind clusters with atomic reserve/release and automatic replenishment. */
export const model = {
  type: "@evrardjp/kind-cluster-pool",
  version: "2026.07.20.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    state: {
      description: "Pool registry — cluster IDs, names, states, kubeconfigs",
      schema: PoolStateSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    reserve: {
      description: "Output of the last successful reserve call",
      schema: ReserveOutputSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    status: {
      description: "Pool health snapshot",
      schema: StatusOutputSchema,
      lifetime: "7d",
      garbageCollection: 20,
    },
  },
  files: {
    log: {
      description: "Execution log",
      contentType: "text/plain",
      lifetime: "7d",
      garbageCollection: 10,
      streaming: true,
    },
  },
  methods: {
    initialize: {
      description:
        "Create N kind clusters and seed the pool. Existing pools are skipped; force=true is rejected when state exists to prevent cluster leaks.",
      arguments: z.object({
        force: z
          .boolean()
          .default(false)
          .describe(
            "Require a fresh pool; rejected if tracked state already exists",
          ),
      }),
      execute: async (args: { force: boolean }, context) => {
        const { n, kindConfig, clusterNamePrefix, kindBinary } =
          context.globalArgs;

        const existing = await readState(context);
        if (existing && args.force) {
          throw new Error(
            "Cannot force initialize an existing pool because replacing its state would leak tracked clusters; use sync or delete the existing clusters first",
          );
        }

        const logWriter = context.createFileWriter("log", "log-init");
        const log = async (msg: string) => {
          context.logger.info(msg);
          await logWriter.writeLine(msg);
        };

        if (existing) {
          await log("Pool already initialized — skipping");
          const logHandle = await logWriter.finalize();
          return { dataHandles: [logHandle] };
        }

        await log(
          `Initializing pool: n=${n}, prefix=${clusterNamePrefix}`,
        );

        const clusters: PoolState["clusters"] = {};
        await forEachWithConcurrency(
          Array.from({ length: n }),
          MAX_CONCURRENT_CLUSTER_OPERATIONS,
          async () => {
            const id = crypto.randomUUID();
            const clusterName = `${clusterNamePrefix}-${shortId()}`;
            await log(`  Creating ${clusterName}...`);
            try {
              const kubeconfig = await createCluster(
                kindBinary,
                clusterName,
                kindConfig,
              );
              clusters[id] = {
                clusterName,
                state: "ready",
                kubeconfig,
                createdAt: new Date().toISOString(),
              };
              await log(`  ${clusterName} ready`);
            } catch (err) {
              clusters[id] = {
                clusterName,
                state: "failed",
                kubeconfig: "",
                createdAt: new Date().toISOString(),
              };
              await log(
                `  ${clusterName} failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          },
        );

        const stateHandle = await context.writeResource(
          "state",
          "state-current",
          { clusters },
        );
        const logHandle = await logWriter.finalize();
        return { dataHandles: [stateHandle, logHandle] };
      },
    },

    reserve: {
      description:
        "Atomically claim one ready cluster under Swamp's exclusive per-model method lock. Returns clusterId, clusterName, and base64-encoded kubeconfig.",
      arguments: z.object({
        testId: z
          .string()
          .optional()
          .describe("Optional test identifier for tracing"),
      }),
      execute: async (args: { testId?: string }, context) => {
        const state = await readState(context);
        if (!state) {
          throw new Error(
            "Pool not initialized — run initialize first",
          );
        }

        const { clusters } = state;
        const readyEntry = Object.entries(clusters).find(
          ([, e]) => e.state === "ready",
        );
        if (!readyEntry) {
          throw new Error(
            "No ready clusters available — pool exhausted or all clusters in use",
          );
        }

        const [readyId, entry] = readyEntry;
        clusters[readyId] = {
          ...entry,
          state: "in_use",
          reservedAt: new Date().toISOString(),
          testId: args.testId,
        };

        const [stateHandle, reserveHandle] = await Promise.all([
          context.writeResource("state", "state-current", { clusters }),
          context.writeResource("reserve", "reserve-latest", {
            clusterId: readyId,
            clusterName: entry.clusterName,
            kubeconfig: entry.kubeconfig,
          }),
        ]);
        return { dataHandles: [stateHandle, reserveHandle] };
      },
    },

    release: {
      description:
        "Mark a cluster as deleting after test use. Deletion and replenishment happen on the next sync.",
      arguments: z.object({
        clusterId: z.string().describe("UUID returned by reserve"),
      }),
      execute: async (args: { clusterId: string }, context) => {
        const state = await readState(context);
        if (!state) throw new Error("Pool not initialized");

        const { clusters } = state;
        const entry = clusters[args.clusterId];
        if (!entry) {
          throw new Error(
            `Cluster ${args.clusterId} not found in pool`,
          );
        }
        if (entry.state !== "in_use") {
          throw new Error(
            `Cluster ${args.clusterId} is in state '${entry.state}', expected 'in_use'`,
          );
        }

        clusters[args.clusterId] = { ...entry, state: "deleting" };
        const handle = await context.writeResource(
          "state",
          "state-current",
          { clusters },
        );
        return { dataHandles: [handle] };
      },
    },

    sync: {
      description:
        "Delete 'deleting' clusters, evict surplus 'ready' clusters if n decreased, then create replacements to restore the pool to n. Idempotent.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { n, kindConfig, clusterNamePrefix, kindBinary } =
          context.globalArgs;

        const logWriter = context.createFileWriter("log", "log-sync");
        const log = async (msg: string) => {
          context.logger.info(msg);
          await logWriter.writeLine(msg);
        };

        const state = await readState(context);
        if (!state) {
          await log("Pool not initialized — nothing to sync");
          const logHandle = await logWriter.finalize();
          return { dataHandles: [logHandle] };
        }

        const { clusters } = state;
        const liveKindClusters = new Set(await getKindClusters(kindBinary));
        await log(
          `kind reports ${liveKindClusters.size} live cluster(s)`,
        );

        // 1. Delete all "deleting" clusters and mark as "deleted"
        const deletingIds = Object.entries(clusters)
          .filter(([, e]) => e.state === "deleting")
          .map(([id]) => id);

        if (deletingIds.length > 0) {
          await log(
            `Deleting ${deletingIds.length} cluster(s) in 'deleting' state...`,
          );
          await forEachWithConcurrency(
            deletingIds,
            MAX_CONCURRENT_CLUSTER_OPERATIONS,
            async (id) => {
              const name = clusters[id].clusterName;
              if (liveKindClusters.has(name)) {
                await log(`  Deleting ${name}...`);
                await deleteCluster(kindBinary, name);
              } else {
                await log(`  ${name} already gone`);
              }
              clusters[id] = { ...clusters[id], state: "deleted" };
            },
          );
        }

        // 2. Evict surplus "ready" clusters if n decreased
        const counts = countByState(clusters);
        const active = counts.ready + counts.in_use + counts.deleting;
        const surplus = active - n;

        if (surplus > 0) {
          const toEvict = Object.entries(clusters)
            .filter(([, e]) => e.state === "ready")
            .map(([id]) => id)
            .slice(0, surplus);
          await log(
            `Pool oversized by ${surplus} — evicting ${toEvict.length} ready cluster(s)...`,
          );
          await forEachWithConcurrency(
            toEvict,
            MAX_CONCURRENT_CLUSTER_OPERATIONS,
            async (id) => {
              const name = clusters[id].clusterName;
              await log(`  Evicting ${name}...`);
              await deleteCluster(kindBinary, name);
              clusters[id] = { ...clusters[id], state: "deleted" };
            },
          );
        }

        // 3. Create replacement clusters for any deficit
        const counts2 = countByState(clusters);
        const active2 = counts2.ready + counts2.in_use + counts2.deleting;
        const deficit = n - active2;

        if (deficit > 0) {
          await log(
            `Pool has deficit of ${deficit} — creating ${deficit} new cluster(s)...`,
          );
          await forEachWithConcurrency(
            Array.from({ length: deficit }),
            MAX_CONCURRENT_CLUSTER_OPERATIONS,
            async () => {
              const id = crypto.randomUUID();
              const clusterName = `${clusterNamePrefix}-${shortId()}`;
              await log(`  Creating ${clusterName}...`);
              try {
                const kubeconfig = await createCluster(
                  kindBinary,
                  clusterName,
                  kindConfig,
                );
                clusters[id] = {
                  clusterName,
                  state: "ready",
                  kubeconfig,
                  createdAt: new Date().toISOString(),
                };
                await log(`  ${clusterName} ready`);
              } catch (err) {
                clusters[id] = {
                  clusterName,
                  state: "failed",
                  kubeconfig: "",
                  createdAt: new Date().toISOString(),
                };
                await log(
                  `  ${clusterName} failed: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              }
            },
          );
        }

        if (
          deletingIds.length === 0 &&
          surplus <= 0 &&
          deficit <= 0
        ) {
          await log("Pool is healthy — nothing to do");
        }

        const stateHandle = await context.writeResource(
          "state",
          "state-current",
          { clusters },
        );
        const logHandle = await logWriter.finalize();
        return { dataHandles: [stateHandle, logHandle] };
      },
    },

    status: {
      description:
        "Report pool health: cluster counts by state and invariant check.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { n } = context.globalArgs;
        const state = await readState(context);

        if (!state) {
          const handle = await context.writeResource(
            "status",
            "status-current",
            {
              n,
              ready: 0,
              inUse: 0,
              deleting: 0,
              deleted: 0,
              failed: 0,
              total: 0,
              invariantOk: false,
            },
          );
          return { dataHandles: [handle] };
        }

        const counts = countByState(state.clusters);
        const active = counts.ready + counts.in_use + counts.deleting;

        const handle = await context.writeResource(
          "status",
          "status-current",
          {
            n,
            ready: counts.ready,
            inUse: counts.in_use,
            deleting: counts.deleting,
            deleted: counts.deleted,
            failed: counts.failed,
            total: Object.keys(state.clusters).length,
            invariantOk: active === n,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
} satisfies ModelDefinition<typeof GlobalArgsSchema>;
