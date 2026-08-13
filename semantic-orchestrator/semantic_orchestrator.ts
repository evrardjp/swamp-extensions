import { stringify } from "jsr:@std/yaml@1";
import { z } from "npm:zod@4.4.3";

const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

const WorkflowTaskSchema = z.object({
  type: z.literal("workflow"),
  workflowIdOrName: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).default({}),
}).strict();

const ModelMethodTaskSchema = z.object({
  type: z.literal("model_method"),
  modelType: z.string().min(1),
  modelName: z.string().min(1),
  methodName: z.string().min(1),
  globalArgs: z.record(z.string(), z.unknown()).default({}),
  inputs: z.record(z.string(), z.unknown()).default({}),
}).strict();

const ImplementationSchema = z.discriminatedUnion("type", [
  WorkflowTaskSchema,
  ModelMethodTaskSchema,
]);

const CoordinationSchema = z.object({
  group: z.string().min(1),
  scope: z.enum(["fact", "global"]),
}).strict();

const AggregateSchema = z.object({
  inputs: z.record(
    z.string().min(1),
    z.object({ merge: z.literal("unique-sorted") }).strict(),
  ),
}).strict();

const ContributionSchema = z.object({
  to: z.string().min(1),
  values: z.record(z.string(), z.unknown()),
}).strict();

const CapabilitySchema = z.object({
  description: z.string().optional(),
  requires: z.array(z.string().min(1)).default([]),
  implementation: ImplementationSchema.optional(),
  aggregate: AggregateSchema.optional(),
  contributes: ContributionSchema.optional(),
  coordination: CoordinationSchema.optional(),
}).strict().superRefine((value, context) => {
  if (
    value.contributes &&
    (value.implementation || value.aggregate || value.coordination)
  ) {
    context.addIssue({
      code: "custom",
      message:
        "A contribution cannot define implementation, aggregate, or coordination",
    });
  } else if (!value.contributes && !value.implementation) {
    context.addIssue({
      code: "custom",
      message: "Executable capability requires implementation",
    });
  }
});

const CompileArgsSchema = z.object({
  targetWorkflowName: z.string().min(1),
  facts: z.record(z.string(), z.unknown()),
  requests: z.record(z.string(), z.array(z.string().min(1))),
  capabilities: z.record(z.string(), CapabilitySchema),
}).strict();

const DraftSchema = z.object({
  targetWorkflowName: z.string(),
  workflowYaml: z.string(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  compiledAt: z.string(),
});

const ReportSchema = z.object({
  requests: z.array(z.unknown()),
  contributions: z.array(z.unknown()),
  mergedAggregates: z.array(z.unknown()),
  effectiveJobs: z.array(z.unknown()),
  semanticEdges: z.array(z.unknown()),
  coordinationBuckets: z.array(z.unknown()),
  operationalEdges: z.array(z.unknown()),
  summary: z.record(z.string(), z.number().int().nonnegative()),
  compiledAt: z.string(),
});

const DependencyConditionSchema = z.object({
  type: z.enum(["succeeded", "completed"]),
}).strict();
const GeneratedWorkflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  jobs: z.array(
    z.object({
      name: z.string().min(1),
      steps: z.array(
        z.object({
          name: z.string().min(1),
          task: ImplementationSchema,
          dependsOn: z.array(
            z.object({
              step: z.string().min(1),
              condition: DependencyConditionSchema,
            }).strict(),
          ),
          weight: z.number(),
          allowFailure: z.boolean(),
        }).strict(),
      ).min(1),
      dependsOn: z.array(
        z.object({
          job: z.string().min(1),
          condition: DependencyConditionSchema,
        }).strict(),
      ),
      weight: z.number(),
    }).strict(),
  ).min(1),
  version: z.number().int().positive(),
}).strict();

type Capability = z.infer<typeof CapabilitySchema>;
type Implementation = z.infer<typeof ImplementationSchema>;
type CompileArgs = z.infer<typeof CompileArgsSchema>;
type Edge = { from: string; to: string };

const EXACT_TEMPLATE = /^@\{\s*([^{}]+?)\s*\}$/;
const TEMPLATE = /@\{\s*([^{}]+?)\s*\}/g;

function safeEntries<T>(record: Record<string, T>): Array<[string, T]> {
  return Object.keys(record).sort(order).map((key) => [key, record[key]]);
}

function parseArgs(raw: z.input<typeof CompileArgsSchema>): CompileArgs {
  const top = z.object({
    targetWorkflowName: z.string().min(1),
    facts: z.record(z.string(), z.unknown()),
    requests: z.record(z.string(), z.array(z.string().min(1))),
    capabilities: z.record(z.string(), z.unknown()),
  }).strict().parse(raw);
  return {
    targetWorkflowName: top.targetWorkflowName,
    facts: Object.fromEntries(safeEntries(raw.facts)),
    requests: Object.fromEntries(
      safeEntries(raw.requests).map(([key, value]) => [
        key,
        z.array(z.string().min(1)).parse(value),
      ]),
    ),
    capabilities: Object.fromEntries(
      safeEntries(raw.capabilities).map(([key, value]) => [
        key,
        CapabilitySchema.parse(value),
      ]),
    ),
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      safeEntries(value as Record<string, unknown>).map((
        [key, item],
      ) => [key, canonical(item)]),
    );
  }
  return value;
}

function valueKey(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function assertJsonValue(value: unknown, label: string): void {
  const stack = [{ value, exit: false, depth: 0 }];
  const active = new Set<object>();
  while (stack.length) {
    const frame = stack.pop()!;
    const current = frame.value;
    if (
      current === null || typeof current === "string" ||
      typeof current === "boolean"
    ) continue;
    if (typeof current === "number") {
      if (Number.isFinite(current)) continue;
      throw new Error(`${label} must contain finite JSON values`);
    }
    if (typeof current !== "object") {
      throw new Error(`${label} must contain JSON-compatible values`);
    }
    if (frame.exit) {
      active.delete(current);
      continue;
    }
    if (frame.depth > 100) {
      throw new Error(`${label} exceeds maximum nesting depth 100`);
    }
    if (active.has(current)) {
      throw new Error(`${label} must not contain cycles`);
    }
    active.add(current);
    stack.push({ value: current, exit: true, depth: frame.depth });
    const children = Array.isArray(current) ? current : Object.values(current);
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({
        value: children[index],
        exit: false,
        depth: frame.depth + 1,
      });
    }
  }
}

function lookup(path: string, context: Record<string, unknown>): unknown {
  const parts = path.split(".");
  let current: unknown = context;
  for (const part of parts) {
    if (
      current !== null && typeof current === "object" &&
      Object.hasOwn(current, part)
    ) {
      current = (current as Record<string, unknown>)[part];
    } else {
      throw new Error(`Unknown template path ${path}`);
    }
  }
  return current;
}

function render(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const exact = value.match(EXACT_TEMPLATE);
    if (exact) return lookup(exact[1], context);
    return value.replace(
      TEMPLATE,
      (_match, path: string) => String(lookup(path, context)),
    );
  }
  if (Array.isArray(value)) return value.map((item) => render(item, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      safeEntries(value as Record<string, unknown>).map((
        [key, item],
      ) => [key, render(item, context)]),
    );
  }
  return value;
}

function renderImplementation(
  implementation: Implementation,
  context: Record<string, unknown>,
): Implementation {
  return ImplementationSchema.parse(render(implementation, context));
}

function hasPath(edges: Edge[], from: string, to: string): boolean {
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  }
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const node = stack.pop()!;
    if (node === to) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    stack.push(...(next.get(node) ?? []));
  }
  return false;
}

function assertDag(nodes: string[], edges: Edge[]): void {
  const indegree = new Map(nodes.map((node) => [node, 0]));
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const ready = nodes.filter((node) => indegree.get(node) === 0);
  let visited = 0;
  while (ready.length) {
    const node = ready.pop()!;
    visited++;
    for (const child of next.get(node) ?? []) {
      indegree.set(child, indegree.get(child)! - 1);
      if (indegree.get(child) === 0) ready.push(child);
    }
  }
  if (visited !== nodes.length) {
    throw new Error("Final workflow contains a cycle");
  }
}

function resolveFact(
  factKey: string,
  requested: string[],
  capabilities: Record<string, Capability>,
): string[] {
  const state = new Map<string, "visiting" | "resolved">();
  const stack = [...requested].sort(order).reverse().map((name) => ({
    name,
    exit: false,
  }));
  while (stack.length) {
    const frame = stack.pop()!;
    if (frame.exit) {
      state.set(frame.name, "resolved");
      continue;
    }
    if (state.get(frame.name) === "resolved") continue;
    if (state.get(frame.name) === "visiting") {
      throw new Error(`Fact ${factKey} capability cycle at ${frame.name}`);
    }
    if (!Object.hasOwn(capabilities, frame.name)) {
      throw new Error(
        `Fact ${factKey} requests unknown capability ${frame.name}`,
      );
    }
    const capability = capabilities[frame.name];
    state.set(frame.name, "visiting");
    stack.push({ name: frame.name, exit: true });
    const dependencies = [
      ...capability.requires,
      ...(capability.contributes ? [capability.contributes.to] : []),
    ].sort(order).reverse();
    for (const name of dependencies) stack.push({ name, exit: false });
  }
  return [...state.entries()].filter(([, value]) => value === "resolved")
    .map(([name]) => name).sort(order);
}

function validateCatalog(capabilities: Record<string, Capability>): void {
  for (const [name, capability] of safeEntries(capabilities)) {
    if (capability.implementation) {
      assertJsonValue(
        capability.implementation,
        `Capability ${name} implementation`,
      );
    }
    for (const requirement of capability.requires) {
      if (!Object.hasOwn(capabilities, requirement)) {
        throw new Error(`Capability ${name} requires missing ${requirement}`);
      }
    }
    if (capability.contributes) {
      const target = capabilities[capability.contributes.to];
      if (!target) {
        throw new Error(
          `Capability ${name} contributes to missing ${capability.contributes.to}`,
        );
      }
      if (!target.aggregate) {
        throw new Error(
          `Capability ${name} target ${capability.contributes.to} is not aggregate`,
        );
      }
      for (const input of Object.keys(capability.contributes.values)) {
        if (!Object.hasOwn(target.aggregate.inputs, input)) {
          throw new Error(
            `Capability ${name} has unknown aggregate input ${input}`,
          );
        }
        if (!Array.isArray(capability.contributes.values[input])) {
          throw new Error(
            `Capability ${name} aggregate input ${input} must be an array`,
          );
        }
        assertJsonValue(
          capability.contributes.values[input],
          `Capability ${name} aggregate input ${input}`,
        );
      }
    }
  }
}

function component(value: string): string {
  if (!value.isWellFormed()) {
    throw new Error("Job key components must contain well-formed Unicode");
  }
  return encodeURIComponent(value);
}

function jobKey(factKey: string, capability: string): string {
  return `${component(factKey)}:${component(capability)}`;
}

function stableSemanticOrder(members: string[], edges: Edge[]): string[] {
  const indegree = new Map(members.map((member) => [member, 0]));
  const next = new Map<string, string[]>();
  const semanticNext = new Map<string, string[]>();
  for (const edge of edges) {
    semanticNext.set(edge.from, [
      ...(semanticNext.get(edge.from) ?? []),
      edge.to,
    ]);
  }
  const reachable = new Map<string, Set<string>>();
  for (const member of members) {
    const found = new Set<string>();
    const stack = [...(semanticNext.get(member) ?? [])];
    while (stack.length) {
      const node = stack.pop()!;
      if (found.has(node)) continue;
      found.add(node);
      stack.push(...(semanticNext.get(node) ?? []));
    }
    reachable.set(member, found);
  }
  for (const from of members) {
    for (const to of members) {
      if (from !== to && reachable.get(from)!.has(to)) {
        indegree.set(to, indegree.get(to)! + 1);
        next.set(from, [...(next.get(from) ?? []), to]);
      }
    }
  }
  const ready = members.filter((member) => indegree.get(member) === 0).sort(
    order,
  );
  const result: string[] = [];
  while (ready.length) {
    const member = ready.shift()!;
    result.push(member);
    for (const child of (next.get(member) ?? []).sort(order)) {
      indegree.set(child, indegree.get(child)! - 1);
      if (indegree.get(child) === 0) {
        ready.push(child);
        ready.sort(order);
      }
    }
  }
  if (result.length !== members.length) {
    throw new Error("Semantic cycle in coordination bucket");
  }
  return result;
}

async function compile(args: CompileArgs) {
  validateCatalog(args.capabilities);
  for (const factKey of Object.keys(args.requests)) {
    if (!Object.hasOwn(args.facts, factKey)) {
      throw new Error(`Request fact ${factKey} has no matching facts entry`);
    }
  }

  const jobs = new Map<
    string,
    {
      factKey: string;
      capability: string;
      task: Implementation;
      coordination?: z.infer<typeof CoordinationSchema>;
    }
  >();
  const semanticEdges: Array<
    Edge & { factKey: string; capability: string; requirement: string }
  > = [];
  const contributions: Array<
    { factKey: string; capability: string; aggregate: string }
  > = [];
  const mergedAggregates: Array<
    { factKey: string; aggregate: string; values: Record<string, unknown> }
  > = [];
  const requestRecords: Array<
    { factKey: string; requested: string[]; resolved: string[] }
  > = [];

  for (const [factKey, facts] of safeEntries(args.facts)) {
    const requested = [
      ...(Object.hasOwn(args.requests, factKey) ? args.requests[factKey] : []),
    ].sort(order);
    const resolved = resolveFact(factKey, requested, args.capabilities);
    requestRecords.push({ factKey, requested, resolved });
    const effective = (name: string): string => {
      const contribution = args.capabilities[name].contributes;
      return jobKey(factKey, contribution?.to ?? name);
    };
    const aggregateValues = new Map<string, Record<string, unknown[]>>();

    for (const name of resolved) {
      const capability = args.capabilities[name];
      if (!capability.contributes) continue;
      const target = args.capabilities[capability.contributes.to];
      if (!target) {
        throw new Error(
          `Fact ${factKey} capability ${name} contributes to missing ${capability.contributes.to}`,
        );
      }
      if (!target.aggregate) {
        throw new Error(
          `Fact ${factKey} capability ${name} target ${capability.contributes.to} is not aggregate`,
        );
      }
      const values = aggregateValues.get(capability.contributes.to) ??
        Object.create(null);
      for (
        const [input, contributionValue] of safeEntries(
          capability.contributes.values,
        )
      ) {
        if (!Object.hasOwn(target.aggregate.inputs, input)) {
          throw new Error(
            `Fact ${factKey} capability ${name} has unknown aggregate input ${input}`,
          );
        }
        if (!Array.isArray(contributionValue)) {
          throw new Error(
            `Fact ${factKey} capability ${name} aggregate input ${input} must be an array`,
          );
        }
        values[input] = [...(values[input] ?? []), ...contributionValue];
      }
      aggregateValues.set(capability.contributes.to, values);
      contributions.push({
        factKey,
        capability: name,
        aggregate: capability.contributes.to,
      });
    }

    for (const name of resolved) {
      const capability = args.capabilities[name];
      if (capability.contributes) continue;
      const aggregate = capability.aggregate;
      const merged: Record<string, unknown> = Object.create(null);
      if (aggregate) {
        const collected = aggregateValues.get(name) ?? Object.create(null);
        for (const [input] of safeEntries(aggregate.inputs)) {
          const unique = new Map<string, unknown>();
          for (const value of collected[input] ?? []) {
            unique.set(valueKey(value), value);
          }
          merged[input] = [...unique.entries()].sort(([a], [b]) => order(a, b))
            .map(([, value]) => value);
        }
        mergedAggregates.push({
          factKey,
          aggregate: name,
          values: canonical(merged) as Record<string, unknown>,
        });
      }
      const task = renderImplementation(capability.implementation!, {
        factKey,
        facts,
        aggregate: merged,
      });
      assertJsonValue(
        task,
        `Fact ${factKey} capability ${name} implementation`,
      );
      if (
        task.type === "workflow" &&
        task.workflowIdOrName === args.targetWorkflowName
      ) {
        throw new Error(
          `Fact ${factKey} capability ${name} causes direct workflow recursion`,
        );
      }
      jobs.set(jobKey(factKey, name), {
        factKey,
        capability: name,
        task,
        coordination: capability.coordination,
      });
    }

    for (const name of resolved) {
      const capability = args.capabilities[name];
      for (const requirement of capability.requires) {
        const from = effective(requirement);
        const to = effective(name);
        if (from === to) continue;
        semanticEdges.push({
          from,
          to,
          factKey,
          capability: name,
          requirement,
        });
      }
    }
  }

  semanticEdges.sort((a, b) =>
    order(
      `${a.from}\0${a.to}\0${a.capability}\0${a.requirement}`,
      `${b.from}\0${b.to}\0${b.capability}\0${b.requirement}`,
    )
  );
  const semantic = [...new Map(
    semanticEdges.map(({ from, to }) => [`${from}\0${to}`, { from, to }]),
  ).values()];
  assertDag([...jobs.keys()], semantic);

  const buckets = new Map<string, string[]>();
  for (const [key, job] of jobs) {
    if (!job.coordination) continue;
    const bucket = job.coordination.scope === "fact"
      ? `fact:${component(job.factKey)}:${component(job.coordination.group)}`
      : `global:${component(job.coordination.group)}`;
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), key]);
  }
  const operationalEdges: Array<Edge & { bucket: string }> = [];
  const allEdges = [...semantic];
  const coordinationBuckets: Array<{ bucket: string; jobs: string[] }> = [];
  for (
    const [bucket, members] of [...buckets].sort(([a], [b]) => order(a, b))
  ) {
    const sortedMembers = stableSemanticOrder(members, semantic);
    coordinationBuckets.push({ bucket, jobs: sortedMembers });
    for (let index = 1; index < sortedMembers.length; index++) {
      const from = sortedMembers[index - 1];
      const to = sortedMembers[index];
      if (!hasPath(allEdges, from, to)) {
        const edge = { from, to, bucket };
        operationalEdges.push(edge);
        allEdges.push(edge);
      }
    }
  }
  assertDag([...jobs.keys()], allEdges);

  const workflowJobs = [...jobs.entries()].sort(([a], [b]) => order(a, b)).map((
    [key, job],
  ) => ({
    name: key,
    steps: [{
      name: job.capability,
      task: job.task,
      dependsOn: [],
      weight: 0,
      allowFailure: false,
    }],
    dependsOn: allEdges.filter((edge) => edge.to === key).map((edge) => ({
      job: edge.from,
      condition: {
        type:
          semantic.some((item) =>
              item.from === edge.from && item.to === edge.to
            )
            ? "succeeded"
            : "completed",
      },
    })).sort((a, b) => order(a.job, b.job)),
    weight: 0,
  }));
  if (workflowJobs.length === 0) {
    throw new Error("Compilation requires at least one effective job");
  }
  const workflow = canonical({
    name: args.targetWorkflowName,
    jobs: workflowJobs,
    version: 1,
  });
  GeneratedWorkflowSchema.parse({
    id: "00000000-0000-4000-8000-000000000000",
    ...workflow as Record<string, unknown>,
  });
  const workflowYaml = stringify(workflow, { lineWidth: 0 });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(workflowYaml),
  );
  const contentHash = [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  const report = {
    requests: requestRecords,
    contributions,
    mergedAggregates,
    effectiveJobs: [...jobs.entries()].sort(([a], [b]) => order(a, b)).map((
      [key, job],
    ) => ({
      job: key,
      factKey: job.factKey,
      capability: job.capability,
      taskType: job.task.type,
      target: job.task.type === "workflow" ? job.task.workflowIdOrName : {
        modelType: job.task.modelType,
        modelName: job.task.modelName,
        methodName: job.task.methodName,
      },
    })),
    semanticEdges,
    coordinationBuckets,
    operationalEdges,
    summary: {
      factCount: Object.keys(args.facts).length,
      requestCount: requestRecords.reduce(
        (count, record) => count + record.requested.length,
        0,
      ),
      resolvedCapabilityCount: requestRecords.reduce(
        (count, record) => count + record.resolved.length,
        0,
      ),
      contributionCount: contributions.length,
      effectiveJobCount: jobs.size,
      semanticEdgeCount: semanticEdges.length,
      operationalEdgeCount: operationalEdges.length,
    },
  };
  return { workflowYaml, contentHash, report };
}

/** Compile semantic capabilities into a standalone Swamp workflow draft. */
export const model = {
  type: "@evrardjp/semantic-orchestrator",
  version: "2026.08.12.1",
  globalArguments: CompileArgsSchema,
  resources: {
    workflowDraft: {
      description: "Canonical ID-free standalone workflow draft",
      schema: DraftSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    compilationReport: {
      description: "Semantic and operational compilation provenance",
      schema: ReportSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    compile: {
      description:
        "Compile facts and requested capabilities into a standalone workflow",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: {
        globalArgs: z.input<typeof CompileArgsSchema>;
        writeResource: (
          specName: string,
          name: string,
          data: Record<string, unknown>,
        ) => Promise<unknown>;
      }) => {
        const args = parseArgs(context.globalArgs);
        const compiled = await compile(args);
        const compiledAt = new Date().toISOString();
        const draft = {
          targetWorkflowName: args.targetWorkflowName,
          workflowYaml: compiled.workflowYaml,
          contentHash: compiled.contentHash,
          compiledAt,
        };
        const report = { ...compiled.report, compiledAt };
        DraftSchema.parse(draft);
        ReportSchema.parse(report);
        const reportHandle = await context.writeResource(
          "compilationReport",
          "current",
          report,
        );
        const draftHandle = await context.writeResource(
          "workflowDraft",
          "current",
          draft,
        );
        return { dataHandles: [reportHandle, draftHandle] };
      },
    },
  },
};
