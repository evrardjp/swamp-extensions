import { z } from "npm:zod@4";
import {
  fetcher,
  FlociConnectionSchema,
  isoNow,
  type ModelContext,
} from "./common.ts";

/** Connection arguments used by the Floci health model. */
export const FlociHealthGlobalArgsSchema = FlociConnectionSchema;
/** Persisted result of a Floci health endpoint check. */
export const FlociHealthResourceSchema = z.object({
  endpoint: z.string().url(),
  region: z.string(),
  healthy: z.boolean(),
  httpStatus: z.number().int(),
  checkedAt: z.iso.datetime(),
});

type GlobalArgs = z.infer<typeof FlociHealthGlobalArgsSchema>;

/** Checks the native Floci health endpoint without exercising an AWS API. */
export const model = {
  type: "@evrardjp/floci-aws/health",
  version: "2026.07.21.1",
  globalArguments: FlociHealthGlobalArgsSchema,
  resources: {
    health: {
      description: "Latest Floci endpoint health observation",
      schema: FlociHealthResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    status: {
      description: "Check Floci through /_localstack/health",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ModelContext<GlobalArgs>,
      ) => {
        const url = new URL("/_localstack/health", context.globalArgs.endpoint);
        const response = await fetcher(context)(url);
        if (!response.ok) {
          throw new Error(`Floci health failed with HTTP ${response.status}`);
        }
        const data = {
          endpoint: context.globalArgs.endpoint,
          region: context.globalArgs.region,
          healthy: true,
          httpStatus: response.status,
          checkedAt: isoNow(),
        };
        const handle = await context.writeResource("health", "status", data);
        return { dataHandles: [handle] };
      },
    },
  },
};
