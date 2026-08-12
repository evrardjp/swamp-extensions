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
  globalArgs: z.record(z.string(), z.unknown()).default({}),
  inputs: z.record(z.string(), z.unknown()).default({}),
});

const TaskImplementationSchema = z.discriminatedUnion("type", [
  WorkflowImplementationSchema,
  ModelMethodTaskImplementationSchema,
]);

const CapabilityRequirementSchema = z.string().min(1);

const CapabilitySchema = z.object({
  name: z.string(),
  requires: z.array(CapabilityRequirementSchema).default([]),
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

/** Validated capability catalog entry. */
export type Capability = z.infer<typeof CapabilitySchema>;
/** Validated VM facts and requested capabilities. */
export type Vm = z.infer<typeof VmSchema>;
/** Rendered capability task for one host. */
export type PlanItem = z.infer<typeof PlanItemSchema>;
type CapabilityImplementation = z.infer<typeof CapabilityImplementationSchema>;
/** Rendered workflow or model method task implementation. */
export type TaskImplementation = z.infer<typeof TaskImplementationSchema>;

/** Concrete capability task and its exact dependency keys. */
export type CapabilityNode = {
  key: string;
  item: PlanItem;
  dependsOn: string[];
};

/** Resolved capability tasks and request metadata. */
export type CapabilityGraph = {
  nodes: CapabilityNode[];
  requested: Record<string, string[]>;
  resolved: Record<string, string[]>;
};

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
    globalArgs: renderTemplateRecord(implementation.globalArgs, context),
    inputs: renderTemplateRecord(implementation.inputs, context),
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

function pacmanPackagesFor(spec: Capability): string[] {
  const implementation = spec.implementation;
  if (
    implementation.type === "model_method" &&
    implementation.modelType === "@adam/cfgmgmt/pacman" &&
    implementation.methodName === "apply" &&
    implementation.globalArgs.ensure !== "absent" &&
    Array.isArray(implementation.globalArgs.packages)
  ) {
    return implementation.globalArgs.packages.filter((pkg): pkg is string =>
      typeof pkg === "string"
    );
  }
  return [];
}

function isPackageCollector(spec: Capability): boolean {
  return spec.implementation.type === "model_method" &&
    spec.implementation.modelType === "@adam/cfgmgmt/pacman" &&
    spec.implementation.methodName === "apply" &&
    spec.implementation.globalArgs.ensure !== "absent" &&
    pacmanPackagesFor(spec).length === 0;
}

function isPackageOnlyCapability(spec: Capability): boolean {
  return pacmanPackagesFor(spec).length > 0;
}

function packageCollectorDeps(
  spec: Capability,
  catalog: Map<string, Capability>,
): string[] {
  return spec.requires.filter((dep) => {
    const depSpec = catalog.get(dep);
    return depSpec ? isPackageCollector(depSpec) : false;
  });
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function rejectDuplicateNames(names: string[], kind: "VM" | "capability") {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new Error(`Duplicate ${kind} name ${name}`);
    seen.add(name);
  }
}

/** Resolve VM capability requests into concrete tasks with exact dependency edges. */
export function buildCapabilityGraph(
  vms: Vm[],
  capabilities: Capability[],
): CapabilityGraph {
  rejectDuplicateNames(vms.map((vm) => vm.name), "VM");
  rejectDuplicateNames(
    capabilities.map((capability) => capability.name),
    "capability",
  );
  const catalog = new Map(capabilities.map((c) => [c.name, c]));
  const requested: Record<string, string[]> = {};
  const resolved: Record<string, string[]> = {};
  const itemsByKey = new Map<string, PlanItem>();
  const requirementsByKey = new Map<string, string[]>();
  const packageOnlyCaps = new Set<string>();
  const packageCollectors = new Set<string>();
  for (const [name, spec] of catalog) {
    if (isPackageOnlyCapability(spec)) packageOnlyCaps.add(name);
    if (isPackageCollector(spec)) packageCollectors.add(name);
  }
  for (const [name, spec] of catalog) {
    if (
      isPackageOnlyCapability(spec) &&
      packageCollectorDeps(spec, catalog).length === 0
    ) {
      throw new Error(
        `Package capability ${name} must require a pacman collector capability`,
      );
    }
  }

  for (const vm of [...vms].sort((a, b) => a.name.localeCompare(b.name))) {
    requested[vm.name] = [...vm.capabilities].sort((a, b) =>
      a.localeCompare(b)
    );
    resolved[vm.name] = resolveForVm(vm, catalog).sort((a, b) =>
      a.localeCompare(b)
    );
    for (
      const collector of resolved[vm.name].filter((cap) =>
        packageCollectors.has(cap)
      )
    ) {
      const collectorSpec = catalog.get(collector)!;
      const packageCapabilities = resolved[vm.name].filter((cap) => {
        const spec = catalog.get(cap);
        return spec && packageOnlyCaps.has(cap) &&
          packageCollectorDeps(spec, catalog).includes(collector);
      });
      const collectorPackages = uniqueSorted(
        packageCapabilities.flatMap((cap) =>
          pacmanPackagesFor(catalog.get(cap)!)
        ),
      );
      const implementation = materializeImplementation(
        collectorSpec.implementation,
        {
          host: vm.name,
          vm,
          capability: collector,
        },
      );
      if (implementation.type !== "model_method") {
        throw new Error(`Package collector ${collector} must use model_method`);
      }
      implementation.globalArgs = {
        ...implementation.globalArgs,
        packages: collectorPackages,
      };
      itemsByKey.set(`${vm.name}:${collector}`, {
        host: vm.name,
        vm,
        capability: collector,
        implementation,
      });
      requirementsByKey.set(
        `${vm.name}:${collector}`,
        uniqueSorted([
          ...collectorSpec.requires,
          ...packageCapabilities.flatMap((cap) =>
            catalog.get(cap)!.requires.filter((dep) =>
              !packageCollectors.has(dep)
            )
          ),
        ]),
      );
    }
    for (const cap of resolved[vm.name]) {
      const spec = catalog.get(cap);
      if (!spec) throw new Error(`internal error: missing ${cap}`);
      if (isPackageOnlyCapability(spec) || packageCollectors.has(cap)) continue;
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

  const nodes = [...itemsByKey.entries()].map(([key, item]) => {
    const spec = catalog.get(item.capability)!;
    const requirements = requirementsByKey.get(key) ?? spec.requires;
    return {
      key,
      item,
      dependsOn: uniqueSorted(
        requirements.flatMap((dep) =>
          packageOnlyCaps.has(dep)
            ? packageCollectorDeps(catalog.get(dep)!, catalog).map((
              collector,
            ) => `${item.host}:${collector}`)
            : [`${item.host}:${dep}`]
        ),
      ),
    };
  }).sort((a, b) => a.key.localeCompare(b.key));

  return { nodes, requested, resolved };
}

function buildWaves(vms: Vm[], capabilities: Capability[]) {
  const graph = buildCapabilityGraph(vms, capabilities);
  const nodesByKey = new Map(graph.nodes.map((node) => [node.key, node]));
  const remaining = new Set(nodesByKey.keys());
  const done = new Set<string>();
  const waves: Array<{ name: string; index: number; items: PlanItem[] }> = [];
  let index = 0;
  while (remaining.size > 0) {
    const waveNodes = [...remaining].sort().map((key) => nodesByKey.get(key)!)
      .filter((node) =>
        node.dependsOn.every((dependency) => done.has(dependency))
      );
    if (waveNodes.length === 0) {
      throw new Error(
        "Cannot build capability waves; unresolved dependency cycle or missing dependency",
      );
    }
    for (const node of waveNodes) {
      remaining.delete(node.key);
      done.add(node.key);
    }
    waves.push({
      name: `wave-${index}`,
      index,
      items: waveNodes.map((node) => node.item),
    });
    index += 1;
  }
  return { waves, requested: graph.requested, resolved: graph.resolved };
}

/** Capability planner model that resolves requested VM capabilities into dependency-ordered waves. */
export const model = {
  type: "@evrardjp/capability-plan",
  version: "2026.08.11.1",
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
      execute: async (rawArgs: z.input<typeof PlanArgsSchema>, context: {
        writeResource: (
          specName: string,
          name: string,
          data: Record<string, unknown>,
        ) => Promise<unknown>;
      }) => {
        const args = PlanArgsSchema.parse(rawArgs);
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
