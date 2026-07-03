import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./capability_plan.ts";

function recordingContext() {
  const writes: Array<{
    specName: string;
    name: string;
    data: Record<string, unknown>;
  }> = [];
  return {
    writes,
    context: {
      writeResource: async (
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
    implementation: { type: "workflow" as const, workflowIdOrName: "base", inputs: {} },
  },
  {
    name: "app",
    requires: ["base"],
    implementation: { type: "workflow" as const, workflowIdOrName: "app", inputs: {} },
  },
];

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
  const waves = writes[0].data.waves as Array<{ items: Array<{ capability: string }> }>;
  assertEquals(waves.map((wave) => wave.items.map((item) => item.capability)), [
    ["base"],
    ["app"],
  ]);
  assertEquals(writes[0].data.requested, { gitea: ["app"] });
  assertEquals(writes[0].data.resolved, { gitea: ["base", "app"] });
});

Deno.test("plan rejects unknown requested capabilities", async () => {
  const { context } = recordingContext();

  await assertRejects(
    () => model.methods.plan.execute({
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
