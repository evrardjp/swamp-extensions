// deno-lint-ignore-file no-explicit-any
/**
 * Benchmark result ledger for github-project-activity ingestion experiments.
 *
 * This model intentionally stores benchmark observations separately from the
 * GitHub activity model so maintainer reports are not polluted by performance
 * data.
 *
 * @module
 */
import { z } from "npm:zod@4";

const BenchmarkRunSchema = z.object({
  benchmarkName: z.string().min(1),
  scenario: z.string().min(1),
  mode: z.string().min(1),
  targetModel: z.string().optional(),
  extensionVersion: z.string().optional(),
  gitSha: z.string().optional(),
  command: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().nonnegative(),
  exitCode: z.number().int().optional(),
  fixtureResponses: z.number().int().nonnegative().optional(),
  fixtureBytes: z.number().int().nonnegative().optional(),
  dataHandleCount: z.number().int().nonnegative().optional(),
  writtenResources: z.record(z.string(), z.number()).default({}),
  totalWrittenBytes: z.number().int().nonnegative().optional(),
  host: z.string().optional(),
  cpu: z.string().optional(),
  notes: z.string().optional(),
  metadata: z.record(z.string(), z.any()).default({}),
}).passthrough();

const RecordBenchmarkRunArgsSchema = z.object({
  run: BenchmarkRunSchema.omit({ finishedAt: true }).extend({
    finishedAt: z.string().optional(),
  }).passthrough(),
});

function safeName(prefix: string, parts: Array<string | number | undefined>) {
  return `${prefix}-${parts.filter((p) => p != null && p !== "").join("-")}`
    .toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 220);
}

/** Stores long-lived benchmark measurements for extension/runtime comparisons. */
export const model = {
  type: "@evrardjp/github-project-activity-benchmark",
  version: "2026.07.06.1",
  globalArguments: z.object({}),
  resources: {
    benchmarkRun: {
      description:
        "One benchmark observation for a github-project-activity ingestion mode",
      schema: BenchmarkRunSchema,
      lifetime: "infinite",
      garbageCollection: 100000,
    },
  },
  methods: {
    record_benchmark_run: {
      description:
        "Append one benchmark result produced by an external benchmark harness",
      arguments: RecordBenchmarkRunArgsSchema,
      execute: async (args: any, ctx: any) => {
        const parsed = RecordBenchmarkRunArgsSchema.parse(args);
        const run = BenchmarkRunSchema.parse({
          ...parsed.run,
          finishedAt: parsed.run.finishedAt ?? new Date().toISOString(),
        });
        const handle = await ctx.writeResource(
          "benchmarkRun",
          safeName("benchmark", [
            run.benchmarkName,
            run.scenario,
            run.mode,
            run.startedAt,
          ]),
          run,
          {
            tags: {
              benchmarkName: run.benchmarkName,
              scenario: run.scenario,
              mode: run.mode,
            },
          },
        );
        return { dataHandles: [handle], summary: run };
      },
    },
  },
};
