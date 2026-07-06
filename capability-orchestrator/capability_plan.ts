import { z } from "npm:zod@4";

const WorkflowImplementationSchema = z.object({
  type: z.literal("workflow"),
  workflowIdOrName: z.string(),
  inputs: z.record(z.string(), z.unknown()).default({}),
});

const ModelMethodCapabilityImplementationSchema = z.object({
  type: z.literal("model_method"),
  modelType: z.string(),
  modelName: z.string(),
  methodName: z.string(),
  globalArgs: z.record(z.string(), z.unknown()).default({}),
  inputs: z.record(z.string(), z.unknown()).default({}),
});

const CapabilityImplementationSchema = z.discriminatedUnion("type", [
  WorkflowImplementationSchema,
  ModelMethodCapabilityImplementationSchema,
]);

const ModelMethodTaskImplementationSchema = z.object({
  type: z.literal("model_method"),
  modelType: z.string(),
  modelName: z.string(),
  methodName: z.string(),
  inputs: z.record(z.string(), z.unknown()).default({}),
});

const TaskImplementationSchema = z.discriminatedUnion("type", [
  WorkflowImplementationSchema,
  ModelMethodTaskImplementationSchema,
]);

const CapabilitySchema = z.object({
  name: z.string(),
  requires: z.array(z.string()).default([]),
  implementation: CapabilityImplementationSchema,
}).passthrough();

const VmSchema = z.object({
  name: z.string(),
  hostname: z.string().optional(),
  ipAddress: z.string(),
  sshUser: z.string(),
  desiredState: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
}).passthrough();

const PlanArgsSchema = z.object({
  vms: z.array(VmSchema),
  capabilities: z.array(CapabilitySchema),
});

const PlanItemSchema = z.object({
  host: z.string(),
  vm: VmSchema,
  capability: z.string(),
  implementation: TaskImplementationSchema,
});

const WaveSchema = z.object({
  name: z.string(),
  index: z.number().int(),
  items: z.array(PlanItemSchema),
});

const PlanSchema = z.object({
  waves: z.array(WaveSchema),
  requested: z.record(z.string(), z.array(z.string())),
  resolved: z.record(z.string(), z.array(z.string())),
  plannedAt: z.string(),
});

type Capability = z.infer<typeof CapabilitySchema>;
type Vm = z.infer<typeof VmSchema>;
type PlanItem = z.infer<typeof PlanItemSchema>;
type CapabilityImplementation = z.infer<typeof CapabilityImplementationSchema>;
type TaskImplementation = z.infer<typeof TaskImplementationSchema>;

type TemplateContext = {
  host: string;
  capability: string;
  vm: Vm;
};

const EXACT_TEMPLATE = /^@\{\s*([A-Za-z0-9_.-]+)\s*\}$/;
const TEMPLATE = /@\{\s*([A-Za-z0-9_.-]+)\s*\}/g;

function lookupTemplateValue(path: string, context: TemplateContext): unknown {
  const parts = path.split(".");
  let current: unknown = context;
  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      throw new Error(`Unknown capability template path ${path}`);
    }
  }
  return current;
}

function renderTemplateValue(
  value: unknown,
  context: TemplateContext,
): unknown {
  if (typeof value === "string") {
    const exact = value.match(EXACT_TEMPLATE);
    if (exact) return lookupTemplateValue(exact[1], context);
    return value.replace(TEMPLATE, (_match, path: string) => {
      const rendered = lookupTemplateValue(path, context);
      if (rendered === undefined || rendered === null) return "";
      return String(rendered);
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderTemplateValue(item, context));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        renderTemplateValue(inner, context),
      ]),
    );
  }
  return value;
}

function renderTemplateRecord(
  value: Record<string, unknown>,
  context: TemplateContext,
): Record<string, unknown> {
  return renderTemplateValue(value, context) as Record<string, unknown>;
}

function materializeImplementation(
  implementation: CapabilityImplementation,
  context: TemplateContext,
): TaskImplementation {
  if (implementation.type === "workflow") {
    return {
      ...implementation,
      workflowIdOrName: renderTemplateValue(
        implementation.workflowIdOrName,
        context,
      ) as string,
      inputs: renderTemplateRecord(implementation.inputs, context),
    };
  }

  return {
    type: "model_method",
    modelType: renderTemplateValue(implementation.modelType, context) as string,
    modelName: renderTemplateValue(implementation.modelName, context) as string,
    methodName: renderTemplateValue(
      implementation.methodName,
      context,
    ) as string,
    inputs: {
      ...renderTemplateRecord(implementation.globalArgs, context),
      ...renderTemplateRecord(implementation.inputs, context),
    },
  };
}

function resolveForVm(vm: Vm, catalog: Map<string, Capability>): string[] {
  const resolved = new Set<string>();
  const visiting = new Set<string>();
  const visit = (cap: string) => {
    if (resolved.has(cap)) return;
    if (visiting.has(cap)) {
      throw new Error(`Capability dependency cycle at ${cap}`);
    }
    const spec = catalog.get(cap);
    if (!spec) {
      throw new Error(`VM ${vm.name} requests unknown capability ${cap}`);
    }
    visiting.add(cap);
    for (const dep of spec.requires) visit(dep);
    visiting.delete(cap);
    resolved.add(cap);
  };
  for (const cap of vm.capabilities) visit(cap);
  return [...resolved];
}

function buildWaves(vms: Vm[], capabilities: Capability[]) {
  const catalog = new Map(capabilities.map((c) => [c.name, c]));
  const requested: Record<string, string[]> = {};
  const resolved: Record<string, string[]> = {};
  const itemsByKey = new Map<string, PlanItem>();
  for (const vm of vms) {
    requested[vm.name] = vm.capabilities;
    resolved[vm.name] = resolveForVm(vm, catalog);
    for (const cap of resolved[vm.name]) {
      const spec = catalog.get(cap);
      if (!spec) throw new Error(`internal error: missing ${cap}`);
      itemsByKey.set(`${vm.name}:${cap}`, {
        host: vm.name,
        vm,
        capability: cap,
        implementation: materializeImplementation(spec.implementation, {
          host: vm.name,
          vm,
          capability: cap,
        }),
      });
    }
  }

  const remaining = new Set(itemsByKey.keys());
  const done = new Set<string>();
  const waves: Array<{ name: string; index: number; items: PlanItem[] }> = [];
  let index = 0;
  while (remaining.size > 0) {
    const waveItems: PlanItem[] = [];
    for (const key of [...remaining].sort()) {
      const item = itemsByKey.get(key)!;
      const spec = catalog.get(item.capability)!;
      const depsSatisfied = spec.requires.every((dep) =>
        done.has(`${item.host}:${dep}`)
      );
      if (depsSatisfied) waveItems.push(item);
    }
    if (waveItems.length === 0) {
      throw new Error(
        "Cannot build capability waves; unresolved dependency cycle or missing dependency",
      );
    }
    for (const item of waveItems) {
      remaining.delete(`${item.host}:${item.capability}`);
      done.add(`${item.host}:${item.capability}`);
    }
    waves.push({ name: `wave-${index}`, index, items: waveItems });
    index += 1;
  }
  return { waves, requested, resolved };
}

/** Capability planner model that resolves requested VM capabilities into dependency-ordered waves. */
export const model = {
  type: "@evrardjp/capability-plan",
  version: "2026.07.05.1",
  globalArguments: z.object({}),
  resources: {
    plan: {
      description: "Resolved capability DAG waves for all requested VMs",
      schema: PlanSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    plan: {
      description:
        "Resolve VM requested capabilities and catalog dependencies into execution waves",
      arguments: PlanArgsSchema,
      execute: async (args: z.infer<typeof PlanArgsSchema>, context: {
        writeResource: (
          specName: string,
          name: string,
          data: Record<string, unknown>,
        ) => Promise<unknown>;
      }) => {
        const built = buildWaves(args.vms, args.capabilities);
        const handle = await context.writeResource("plan", "current", {
          ...built,
          plannedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
