import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { buildCapabilityGraph, model } from "./capability_plan.ts";

function recordingContext() {
  const writes: Array<{
    specName: string;
    name: string;
    data: Record<string, unknown>;
  }> = [];
  return {
    writes,
    context: {
      writeResource: (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ specName, name, data });
        return { specName, name, version: 1 };
      },
    },
  };
}

const capabilities = [
  {
    name: "base",
    requires: [],
    implementation: {
      type: "workflow" as const,
      workflowIdOrName: "base",
      inputs: {},
    },
  },
  {
    name: "app",
    requires: ["base"],
    implementation: {
      type: "workflow" as const,
      workflowIdOrName: "app",
      inputs: {},
    },
  },
];

function vm(name: string) {
  return {
    name,
    ipAddress: "192.0.2.42",
    sshUser: "admin",
    capabilities: ["app"],
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

Deno.test("graph keeps exact diamond dependencies", () => {
  const graph = buildCapabilityGraph([{
    name: "node1",
    ipAddress: "192.0.2.42",
    sshUser: "admin",
    capabilities: ["app"],
  }], [
    workflowCapability("base"),
    workflowCapability("left", ["base"]),
    workflowCapability("right", ["base"]),
    workflowCapability("app", ["left", "right"]),
  ]);

  assertEquals(
    Object.fromEntries(graph.nodes.map((node) => [node.key, node.dependsOn])),
    {
      "node1:app": ["node1:left", "node1:right"],
      "node1:base": [],
      "node1:left": ["node1:base"],
      "node1:right": ["node1:base"],
    },
  );
});

Deno.test("graph rejects duplicate names", () => {
  assertThrows(
    () => buildCapabilityGraph([vm("node1"), vm("node1")], capabilities),
    Error,
    "Duplicate VM name node1",
  );
  assertThrows(
    () =>
      buildCapabilityGraph([vm("node1")], [capabilities[0], capabilities[0]]),
    Error,
    "Duplicate capability name base",
  );
});

Deno.test("graph rejects names that make host capability keys ambiguous", () => {
  assertThrows(
    () => buildCapabilityGraph([vm("node:1")], capabilities),
    Error,
    'VM name "node:1" must not contain ":"',
  );
  assertThrows(
    () =>
      buildCapabilityGraph([vm("node1")], [
        workflowCapability("base:system"),
      ]),
    Error,
    'capability name "base:system" must not contain ":"',
  );
});

Deno.test("graph collapses same-collector package dependencies", () => {
  const graph = buildCapabilityGraph([{
    ...vm("node1"),
    capabilities: ["app-packages"],
  }], [
    {
      name: "packages",
      requires: [],
      implementation: {
        type: "model_method" as const,
        modelType: "@adam/cfgmgmt/pacman",
        modelName: "packages",
        methodName: "apply",
        globalArgs: { packages: [], ensure: "present" },
        inputs: {},
      },
    },
    {
      name: "base-packages",
      requires: ["packages"],
      implementation: {
        type: "model_method" as const,
        modelType: "@adam/cfgmgmt/pacman",
        modelName: "unused",
        methodName: "apply",
        globalArgs: { packages: ["base"], ensure: "present" },
        inputs: {},
      },
    },
    {
      name: "app-packages",
      requires: ["base-packages", "packages"],
      implementation: {
        type: "model_method" as const,
        modelType: "@adam/cfgmgmt/pacman",
        modelName: "unused",
        methodName: "apply",
        globalArgs: { packages: ["app"], ensure: "present" },
        inputs: {},
      },
    },
  ]);

  assertEquals(
    graph.nodes.map((node) => ({
      key: node.key,
      dependsOn: node.dependsOn,
    })),
    [{ key: "node1:packages", dependsOn: [] }],
  );
});

Deno.test("plan resolves dependencies into ordered waves", async () => {
  const { writes, context } = recordingContext();

  const result = await model.methods.plan.execute({
    vms: [{
      name: "gitea",
      ipAddress: "192.0.2.12",
      sshUser: "admin",
      capabilities: ["app"],
    }],
    capabilities,
  }, context as never);

  assertEquals(result.dataHandles.length, 1);
  assertEquals(writes[0].specName, "plan");
  const waves = writes[0].data.waves as Array<
    { items: Array<{ capability: string }> }
  >;
  assertEquals(waves.map((wave) => wave.items.map((item) => item.capability)), [
    ["base"],
    ["app"],
  ]);
  assertEquals(writes[0].data.requested, { gitea: ["app"] });
  assertEquals(writes[0].data.resolved, { gitea: ["app", "base"] });
});

Deno.test("plan renders model method global arguments separately from method inputs", async () => {
  const { writes, context } = recordingContext();

  await model.methods.plan.execute({
    vms: [{
      name: "gitea",
      hostname: "gitea.example.com",
      ipAddress: "192.0.2.12",
      sshUser: "admin",
      capabilities: ["base"],
    }],
    capabilities: [{
      name: "base",
      requires: [],
      implementation: {
        type: "model_method" as const,
        modelType: "@example/package",
        modelName: "lab-@{host}-base",
        methodName: "apply",
        globalArgs: {
          packages: ["gitea"],
          ensure: "present",
          nodeHost: "@{vm.ipAddress}",
          nodeUser: "@{vm.sshUser}",
          url: "https://@{vm.hostname}",
        },
        inputs: { timeout: 30 },
      },
    }],
  }, context as never);

  const waves = writes[0].data.waves as Array<{
    items: Array<{ implementation: Record<string, unknown> }>;
  }>;
  assertEquals(waves[0].items[0].implementation, {
    type: "model_method",
    modelType: "@example/package",
    modelName: "lab-gitea-base",
    methodName: "apply",
    globalArgs: {
      packages: ["gitea"],
      ensure: "present",
      nodeHost: "192.0.2.12",
      nodeUser: "admin",
      url: "https://gitea.example.com",
    },
    inputs: { timeout: 30 },
  });
});

Deno.test("plan aggregates pacman requirements and preserves non-package capability edges", async () => {
  const { writes, context } = recordingContext();

  await model.methods.plan.execute({
    vms: [{
      name: "node1",
      ipAddress: "192.0.2.42",
      sshUser: "admin",
      capabilities: ["app"],
    }],
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
        name: "packages-installation",
        requires: [],
        implementation: {
          type: "model_method" as const,
          modelType: "@adam/cfgmgmt/pacman",
          modelName: "lab-@{host}-packages",
          methodName: "apply",
          globalArgs: {
            packages: [],
            ensure: "present",
            nodeHost: "@{vm.ipAddress}",
            nodeUser: "@{vm.sshUser}",
            nodePort: 22,
            nodeIdentityFile: "~/.ssh/id_ed25519",
            become: true,
            becomeUser: "root",
          },
          inputs: {},
        },
      },
      {
        name: "base",
        requires: ["ssh", "packages-installation"],
        implementation: {
          type: "model_method" as const,
          modelType: "@adam/cfgmgmt/pacman",
          modelName: "base-package-wrapper",
          methodName: "apply",
          globalArgs: { packages: ["sudo"], ensure: "present" },
          inputs: {},
        },
      },
      {
        name: "docker-packages",
        requires: ["packages-installation"],
        implementation: {
          type: "model_method" as const,
          modelType: "@adam/cfgmgmt/pacman",
          modelName: "docker-package-wrapper",
          methodName: "apply",
          globalArgs: { packages: ["docker"], ensure: "present" },
          inputs: {},
        },
      },
      {
        name: "docker",
        requires: ["base", "docker-packages"],
        implementation: {
          type: "workflow" as const,
          workflowIdOrName: "docker",
          inputs: {},
        },
      },
      {
        name: "app",
        requires: ["docker"],
        implementation: {
          type: "workflow" as const,
          workflowIdOrName: "app",
          inputs: {},
        },
      },
    ],
  }, context as never);

  const waves = writes[0].data.waves as Array<{
    items: Array<
      { capability: string; implementation: Record<string, unknown> }
    >;
  }>;
  assertEquals(waves.map((wave) => wave.items.map((item) => item.capability)), [
    ["ssh"],
    ["packages-installation"],
    ["docker"],
    ["app"],
  ]);
  assertEquals(waves[1].items[0].implementation.globalArgs, {
    packages: ["docker", "sudo"],
    ensure: "present",
    nodeHost: "192.0.2.42",
    nodeUser: "admin",
    nodePort: 22,
    nodeIdentityFile: "~/.ssh/id_ed25519",
    become: true,
    becomeUser: "root",
  });
});

Deno.test("plan keeps package removals as independent tasks", async () => {
  const { writes, context } = recordingContext();

  await model.methods.plan.execute({
    vms: [{
      name: "node1",
      ipAddress: "192.0.2.42",
      sshUser: "admin",
      capabilities: ["packages-installation", "remove-foo"],
    }],
    capabilities: [
      {
        name: "packages-installation",
        requires: [],
        implementation: {
          type: "model_method" as const,
          modelType: "@adam/cfgmgmt/pacman",
          modelName: "packages",
          methodName: "apply",
          globalArgs: { packages: [], ensure: "present" },
          inputs: {},
        },
      },
      {
        name: "remove-foo",
        requires: [],
        implementation: {
          type: "model_method" as const,
          modelType: "@adam/cfgmgmt/pacman",
          modelName: "remove-foo",
          methodName: "apply",
          globalArgs: { packages: ["foo"], ensure: "absent" },
          inputs: {},
        },
      },
    ],
  }, context as never);

  const waves = writes[0].data.waves as Array<{
    items: Array<{
      capability: string;
      implementation: { globalArgs: Record<string, unknown> };
    }>;
  }>;
  assertEquals(waves[0].items.map((item) => item.capability), [
    "packages-installation",
    "remove-foo",
  ]);
  assertEquals(waves[0].items[0].implementation.globalArgs.packages, []);
  assertEquals(waves[0].items[1].implementation.globalArgs, {
    packages: ["foo"],
    ensure: "absent",
  });
});

Deno.test("plan rejects unknown requested capabilities", async () => {
  const { context } = recordingContext();

  await assertRejects(
    () =>
      model.methods.plan.execute({
        vms: [{
          name: "gitea",
          ipAddress: "192.0.2.12",
          sshUser: "admin",
          capabilities: ["missing"],
        }],
        capabilities,
      }, context as never),
    Error,
    "requests unknown capability missing",
  );
});
