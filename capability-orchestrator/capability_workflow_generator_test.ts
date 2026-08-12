import { assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1";
import { parse } from "jsr:@std/yaml@1";
import {
  compileWorkflowDraft,
  model,
} from "./capability_workflow_generator.ts";

function vm(name = "node1") {
  return {
    name,
    ipAddress: "192.0.2.42",
    sshUser: "admin",
    capabilities: ["app", "composite", "model"],
  };
}

function workflowCapability(name: string, requires: string[] = []) {
  return {
    name,
    requires,
    implementation: {
      type: "workflow" as const,
      workflowIdOrName: name,
      inputs: {},
    },
  };
}

function jobByName(workflow: unknown, name: string) {
  const jobs = (workflow as { jobs: Array<Record<string, unknown>> }).jobs;
  return jobs.find((job) => job.name === name) as {
    dependsOn: unknown[];
    steps: Array<{ task: unknown }>;
  };
}

const diamondInput = {
  targetWorkflowName: "configure-lab",
  vms: [vm()],
  capabilities: [
    workflowCapability("base"),
    workflowCapability("left", ["base"]),
    workflowCapability("right", ["base"]),
    workflowCapability("app", ["right", "left"]),
    {
      name: "model",
      requires: [],
      implementation: {
        type: "model_method" as const,
        modelType: "@example/config",
        modelName: "@{host}-config",
        methodName: "apply",
        globalArgs: { host: "@{vm.ipAddress}", enabled: true },
        inputs: { timeout: 30 },
      },
    },
    {
      name: "composite",
      requires: [],
      implementation: {
        type: "workflow" as const,
        workflowIdOrName: "configure-@{host}",
        inputs: { mode: "strict" },
      },
    },
  ],
};

Deno.test("compiler emits a deterministic literal diamond DAG", async () => {
  const first = await compileWorkflowDraft(diamondInput);
  const second = await compileWorkflowDraft({
    targetWorkflowName: diamondInput.targetWorkflowName,
    vms: [{
      capabilities: ["composite", "model", "app"],
      sshUser: "admin",
      ipAddress: "192.0.2.42",
      name: "node1",
    }],
    capabilities: [...diamondInput.capabilities].reverse().map((capability) =>
      capability.name === "model"
        ? {
          ...capability,
          implementation: {
            ...capability.implementation,
            inputs: { timeout: 30 },
            globalArgs: { enabled: true, host: "@{vm.ipAddress}" },
          },
        }
        : capability
    ),
  });

  assertEquals(first.workflowYaml, second.workflowYaml);
  assertEquals(first.contentHash, second.contentHash);
  assertEquals(first.workflowYaml.includes("compiledAt"), false);
  assertMatch(first.contentHash, /^[0-9a-f]{64}$/);

  const workflow = parse(first.workflowYaml);
  assertEquals((workflow as Record<string, unknown>).id, undefined);
  assertEquals(jobByName(workflow, "node1:app").dependsOn, [
    { job: "node1:left", condition: { type: "succeeded" } },
    { job: "node1:right", condition: { type: "succeeded" } },
  ]);
  assertEquals(jobByName(workflow, "node1:left").dependsOn, [
    { job: "node1:base", condition: { type: "succeeded" } },
  ]);
  assertEquals(jobByName(workflow, "node1:model").steps[0].task, {
    type: "model_method",
    modelType: "@example/config",
    modelName: "node1-config",
    methodName: "apply",
    globalArgs: { enabled: true, host: "192.0.2.42" },
    inputs: { timeout: 30 },
  });
  assertEquals(jobByName(workflow, "node1:composite").steps[0].task, {
    type: "workflow",
    workflowIdOrName: "configure-node1",
    inputs: {
      host: "node1",
      capability: "composite",
      vm: vm("node1"),
      implementationInputs: { mode: "strict" },
    },
  });
});

Deno.test("compiler orders Unicode names and nested keys by code unit", async () => {
  const composed = "é";
  const decomposed = "e\u0301";
  const firstInput = {
    targetWorkflowName: "unicode",
    vms: [{ ...vm(composed), capabilities: [composed, decomposed] }],
    capabilities: [
      workflowCapability(composed),
      {
        ...workflowCapability(decomposed),
        implementation: {
          type: "workflow" as const,
          workflowIdOrName: decomposed,
          inputs: { [composed]: 1, [decomposed]: 2 },
        },
      },
    ],
  };
  const secondInput = {
    ...firstInput,
    vms: [{ ...firstInput.vms[0], capabilities: [decomposed, composed] }],
    capabilities: [
      {
        ...firstInput.capabilities[1],
        implementation: {
          ...firstInput.capabilities[1].implementation,
          inputs: { [decomposed]: 2, [composed]: 1 },
        },
      },
      firstInput.capabilities[0],
    ],
  };

  const first = await compileWorkflowDraft(firstInput);
  const second = await compileWorkflowDraft(secondInput);

  assertEquals(first.workflowYaml, second.workflowYaml);
  assertEquals(first.contentHash, second.contentHash);
});

Deno.test("compiler emits one package collector with non-package prerequisites", async () => {
  const input = {
    targetWorkflowName: "packages",
    vms: [{ ...vm(), capabilities: ["app"] }],
    capabilities: [
      {
        name: "ssh",
        requires: [],
        implementation: {
          type: "model_method" as const,
          modelType: "@example/ssh",
          modelName: "ssh",
          methodName: "wait",
          globalArgs: {},
          inputs: {},
        },
      },
      {
        name: "packages",
        requires: [],
        implementation: {
          type: "model_method" as const,
          modelType: "@adam/cfgmgmt/pacman",
          modelName: "packages-@{host}",
          methodName: "apply",
          globalArgs: { packages: [], ensure: "present" },
          inputs: {},
        },
      },
      {
        name: "base-packages",
        requires: ["ssh", "packages"],
        implementation: {
          type: "model_method" as const,
          modelType: "@adam/cfgmgmt/pacman",
          modelName: "unused",
          methodName: "apply",
          globalArgs: { packages: ["sudo", "curl"], ensure: "present" },
          inputs: {},
        },
      },
      {
        name: "app-packages",
        requires: ["packages"],
        implementation: {
          type: "model_method" as const,
          modelType: "@adam/cfgmgmt/pacman",
          modelName: "unused",
          methodName: "apply",
          globalArgs: { packages: ["curl", "gitea"], ensure: "present" },
          inputs: {},
        },
      },
      workflowCapability("app", ["base-packages", "app-packages"]),
    ],
  };

  const workflow = parse((await compileWorkflowDraft(input)).workflowYaml);
  const jobs = (workflow as { jobs: Array<{ name: string }> }).jobs;
  assertEquals(jobs.map((job) => job.name), [
    "node1:app",
    "node1:packages",
    "node1:ssh",
  ]);
  assertEquals(jobByName(workflow, "node1:packages").dependsOn, [
    { job: "node1:ssh", condition: { type: "succeeded" } },
  ]);
  assertEquals(
    (jobByName(workflow, "node1:packages").steps[0].task as {
      globalArgs: { packages: string[] };
    }).globalArgs.packages,
    ["curl", "gitea", "sudo"],
  );
});

Deno.test("compiler rejects invalid graph and rendered task inputs", async () => {
  const base = workflowCapability("base");
  const cases: Array<[unknown, string]> = [
    [{ ...diamondInput, vms: [vm(), vm()] }, "Duplicate VM name"],
    [
      { ...diamondInput, capabilities: [base, base] },
      "Duplicate capability name",
    ],
    [{
      ...diamondInput,
      vms: [{ ...vm(), capabilities: ["missing"] }],
    }, "requests unknown capability"],
    [{
      ...diamondInput,
      vms: [{ ...vm(), capabilities: ["one"] }],
      capabilities: [
        workflowCapability("one", ["two"]),
        workflowCapability("two", ["one"]),
      ],
    }, "Capability dependency cycle"],
    [{
      ...diamondInput,
      vms: [{ ...vm(), capabilities: ["shell"] }],
      capabilities: [{
        name: "shell",
        requires: [],
        implementation: {
          type: "model_method",
          modelType: "command/shell",
          modelName: "shell",
          methodName: "run",
          globalArgs: {},
          inputs: {},
        },
      }],
    }, "command/shell is not allowed"],
    [{
      ...diamondInput,
      vms: [{ ...vm(), hostname: "", capabilities: ["empty"] }],
      capabilities: [{
        name: "empty",
        requires: [],
        implementation: {
          type: "workflow",
          workflowIdOrName: "@{vm.hostname}",
          inputs: {},
        },
      }],
    }, "must not be empty"],
  ];

  for (const [input, message] of cases) {
    await assertRejects(
      () => compileWorkflowDraft(input as never),
      Error,
      message,
    );
  }
});

Deno.test("generate writes the current workflow draft with compilation metadata", async () => {
  const writes: Array<{
    specName: string;
    name: string;
    data: Record<string, unknown>;
  }> = [];
  const context = {
    globalArgs: diamondInput,
    writeResource: (
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ specName, name, data });
      return { specName, name, version: 1 };
    },
  };

  const result = await model.methods.generate.execute({}, context as never);

  assertEquals(result.dataHandles.length, 1);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "workflowDraft");
  assertEquals(writes[0].name, "current");
  assertEquals(writes[0].data.targetWorkflowName, "configure-lab");
  assertMatch(writes[0].data.compiledAt as string, /^\d{4}-\d\d-\d\dT/);
  assertEquals(writes[0].data.requested, {
    node1: ["app", "composite", "model"],
  });
  assertEquals(writes[0].data.resolved, {
    node1: ["app", "base", "composite", "left", "model", "right"],
  });
  assertMatch(writes[0].data.workflowYaml as string, /^description:/);
  assertMatch(writes[0].data.contentHash as string, /^[0-9a-f]{64}$/);
});
