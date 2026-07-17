import { z } from "npm:zod@4";

const WorkflowImplementationSchema = z.object({
  type: z.literal("workflow"),
  workflowIdOrName: z.string(),
  inputs: z.record(z.string(), z.unknown()).default({}),
});

const ModelMethodImplementationSchema = z.object({
  type: z.literal("model_method"),
  modelType: z.string(),
  modelName: z.string(),
  methodName: z.string(),
  globalArgs: z.record(z.string(), z.unknown()).default({}),
  inputs: z.record(z.string(), z.unknown()).default({}),
});

const ImplementationSchema = z.discriminatedUnion("type", [
  WorkflowImplementationSchema,
  ModelMethodImplementationSchema,
]);

const CapabilityExposeSchema = z.object({
  name: z.string(),
  listen: z.string().describe(
    "Backend listen endpoint in SOCAT-like PROTO:HOST:PORT form",
  ),
  upstreamScheme: z.enum(["http", "https"]).default("http"),
  tlsInsecureSkipVerify: z.boolean(),
  public: z.object({
    fqdn: z.string(),
    listen: z.string().default("TCP:0.0.0.0:443"),
    scheme: z.enum(["http", "https"]).default("https"),
    tls: z.enum(["internal", "off"]).default("internal"),
  }),
});

const CapabilityRequirementSchema = z.string().min(1);

const CapabilitySpecSchema = z.object({
  description: z.string().optional(),
  exposes: z.array(CapabilityExposeSchema).default([]),
  requires: z.array(CapabilityRequirementSchema).default([]),
  implementation: ImplementationSchema,
});

const GlobalArgsSchema = z.object({
  capabilities: z.record(z.string(), CapabilitySpecSchema),
});

const CapabilityResourceSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  exposes: z.array(CapabilityExposeSchema).default([]),
  requires: z.array(CapabilityRequirementSchema),
  implementation: ImplementationSchema,
});

const CatalogSummarySchema = z.object({
  capabilityCount: z.number().int(),
  capabilities: z.array(z.string()),
  publishedAt: z.string(),
});

type CapabilitySpec = z.infer<typeof CapabilitySpecSchema>;

function validateCatalog(catalog: Record<string, CapabilitySpec>) {
  const errors: string[] = [];
  for (const [name, spec] of Object.entries(catalog)) {
    for (const dep of spec.requires) {
      if (!catalog[dep]) {
        errors.push(`${name} requires unknown capability ${dep}`);
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`Capability catalog invalid: ${errors.join("; ")}`);
  }
}

/** Capability catalog model that validates and publishes capability definitions. */
export const model = {
  type: "@evrardjp/capability-catalog",
  version: "2026.07.17.3",
  globalArguments: GlobalArgsSchema,
  resources: {
    capability: {
      description: "One capability definition and its implementation metadata",
      schema: CapabilityResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    summary: {
      description: "Capability catalog summary",
      schema: CatalogSummarySchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    publish: {
      description: "Validate and publish capability definitions as Swamp data",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: {
        globalArgs: z.infer<typeof GlobalArgsSchema>;
        writeResource: (
          specName: string,
          name: string,
          data: Record<string, unknown>,
        ) => Promise<unknown>;
      }) => {
        const globalArgs = GlobalArgsSchema.parse(context.globalArgs);
        validateCatalog(globalArgs.capabilities);
        const handles: unknown[] = [];
        for (const [name, spec] of Object.entries(globalArgs.capabilities)) {
          handles.push(
            await context.writeResource("capability", name, { name, ...spec }),
          );
        }
        handles.push(
          await context.writeResource("summary", "current", {
            capabilityCount: Object.keys(globalArgs.capabilities).length,
            capabilities: Object.keys(globalArgs.capabilities).sort(),
            publishedAt: new Date().toISOString(),
          }),
        );
        return { dataHandles: handles };
      },
    },
  },
};
