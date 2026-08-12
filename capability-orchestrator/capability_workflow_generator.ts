import { z } from "npm:zod@4";
import { stringify } from "jsr:@std/yaml@1";
import {
  buildCapabilityGraph,
  type CapabilityNode,
  compareCodeUnits,
} from "./capability_plan.ts";

const JsonRecordSchema = z.record(z.string(), z.json());
const TargetSchema = z.preprocess(
  (value) => value ?? "",
  z.string().min(1, "Rendered task target must not be empty"),
);

const WorkflowImplementationSchema = z.object({
  type: z.literal("workflow"),
  workflowIdOrName: z.string(),
  inputs: JsonRecordSchema.default({}),
}).strict();

const ModelMethodImplementationSchema = z.object({
  type: z.literal("model_method"),
  modelType: z.string(),
  modelName: z.string(),
  methodName: z.string(),
  globalArgs: JsonRecordSchema.default({}),
  inputs: JsonRecordSchema.default({}),
}).strict();

const CapabilitySchema = z.object({
  name: z.string(),
  requires: z.array(z.string().min(1)).default([]),
  implementation: z.discriminatedUnion("type", [
    WorkflowImplementationSchema,
    ModelMethodImplementationSchema,
  ]),
}).passthrough();

const VmSchema = z.object({
  name: z.string(),
  hostname: z.string().optional(),
  ipAddress: z.string(),
  sshUser: z.string(),
  desiredState: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
}).passthrough();

const GlobalArgsSchema = z.object({
  targetWorkflowName: z.string().min(1),
  vms: z.array(VmSchema),
  capabilities: z.array(CapabilitySchema),
}).strict();

const ModelMethodTaskSchema = z.object({
  type: z.literal("model_method"),
  modelType: TargetSchema.refine(
    (value) => value !== "command/shell",
    "command/shell is not allowed",
  ),
  modelName: TargetSchema,
  methodName: TargetSchema,
  globalArgs: JsonRecordSchema,
  inputs: JsonRecordSchema,
}).strict();

const WorkflowTaskSchema = z.object({
  type: z.literal("workflow"),
  workflowIdOrName: TargetSchema,
  inputs: JsonRecordSchema,
}).strict();

const DependencySchema = z.object({
  job: z.string().min(1),
  condition: z.object({ type: z.literal("succeeded") }).strict(),
}).strict();

const StepSchema = z.object({
  name: z.literal("apply"),
  task: z.discriminatedUnion("type", [
    ModelMethodTaskSchema,
    WorkflowTaskSchema,
  ]),
  dependsOn: z.array(z.never()),
  weight: z.literal(0),
  allowFailure: z.literal(false),
}).strict();

const ConcreteWorkflowSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.literal(1),
  jobs: z.array(
    z.object({
      name: z.string().min(1),
      steps: z.tuple([StepSchema]),
      dependsOn: z.array(DependencySchema),
      weight: z.literal(0),
    }).strict(),
  ),
}).strict();

const WorkflowDraftSchema = z.object({
  targetWorkflowName: z.string().min(1),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  workflowYaml: z.string().min(1),
  compiledAt: z.string(),
  requested: z.record(z.string(), z.array(z.string())),
  resolved: z.record(z.string(), z.array(z.string())),
});

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => compareCodeUnits(a, b))
        .map(([key, inner]) => [key, canonicalize(inner)]),
    );
  }
  return value;
}

function taskFor(node: CapabilityNode) {
  const implementation = node.item.implementation;
  if (implementation.type === "workflow") {
    return WorkflowTaskSchema.parse({
      type: "workflow",
      workflowIdOrName: implementation.workflowIdOrName,
      inputs: {
        host: node.item.host,
        capability: node.item.capability,
        vm: node.item.vm,
        implementationInputs: implementation.inputs,
      },
    });
  }
  return ModelMethodTaskSchema.parse(implementation);
}

/** Compile effective capability inputs into deterministic concrete workflow YAML. */
export async function compileWorkflowDraft(rawGlobalArgs: unknown) {
  const args = GlobalArgsSchema.parse(rawGlobalArgs);
  const graph = buildCapabilityGraph(
    args.vms.map((vm) => ({
      ...vm,
      capabilities: [...vm.capabilities].sort(compareCodeUnits),
    })),
    args.capabilities,
  );
  const workflow = ConcreteWorkflowSchema.parse({
    name: args.targetWorkflowName,
    description: "Concrete workflow generated from VM capabilities",
    version: 1,
    jobs: graph.nodes.map((node) => ({
      name: node.key,
      steps: [{
        name: "apply",
        task: taskFor(node),
        dependsOn: [],
        weight: 0,
        allowFailure: false,
      }],
      dependsOn: node.dependsOn.map((job) => ({
        job,
        condition: { type: "succeeded" },
      })),
      weight: 0,
    })),
  });
  const workflowYaml = stringify(canonicalize(workflow));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(workflowYaml),
  );
  const contentHash = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    targetWorkflowName: args.targetWorkflowName,
    contentHash,
    workflowYaml,
    requested: graph.requested,
    resolved: graph.resolved,
  };
}

/** Deterministic capability-to-workflow compiler model. */
export const model = {
  type: "@evrardjp/capability-based-workflow-generator",
  version: "2026.08.11.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    workflowDraft: {
      description: "Deterministic concrete workflow compiled from capabilities",
      schema: WorkflowDraftSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    generate: {
      description:
        "Compile current VM and capability data into a concrete workflow",
      arguments: z.object({}),
      execute: async (_args: unknown, context: {
        globalArgs: unknown;
        writeResource: (
          specName: string,
          name: string,
          data: Record<string, unknown>,
        ) => Promise<unknown>;
      }) => {
        const draft = await compileWorkflowDraft(
          GlobalArgsSchema.parse(context.globalArgs),
        );
        const handle = await context.writeResource(
          "workflowDraft",
          "current",
          { ...draft, compiledAt: new Date().toISOString() },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
