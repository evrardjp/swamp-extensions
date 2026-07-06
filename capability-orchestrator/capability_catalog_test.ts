import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./capability_catalog.ts";

function recordingContext(capabilities: Record<string, unknown>) {
  const writes: Array<{
    specName: string;
    name: string;
    data: Record<string, unknown>;
  }> = [];
  return {
    writes,
    context: {
      globalArgs: { capabilities },
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

Deno.test("publish writes capability resources and a sorted summary", async () => {
  const { writes, context } = recordingContext({
    app: {
      description: "Install app",
      requires: ["base"],
      implementation: { type: "workflow", workflowIdOrName: "app" },
    },
    base: {
      requires: [],
      implementation: { type: "workflow", workflowIdOrName: "base" },
    },
  });

  const result = await model.methods.publish.execute({}, context as never);

  assertEquals(result.dataHandles.length, 3);
  assertEquals(writes.map((w) => w.specName), [
    "capability",
    "capability",
    "summary",
  ]);
  assertEquals(writes.at(-1)?.data.capabilities, ["app", "base"]);
  assertEquals(writes.at(-1)?.data.capabilityCount, 2);
});

<<<<<<< Updated upstream
Deno.test("publish accepts model method implementations", async () => {
  const { writes, context } = recordingContext({
    base: {
      requires: [],
      implementation: {
        type: "model_method",
        modelType: "@example/package",
        modelName: "lab-@{host}-base",
        methodName: "apply",
        globalArgs: { nodeHost: "@{vm.ipAddress}" },
        inputs: {},
=======
Deno.test("publish accepts direct model method implementations", async () => {
  const { writes, context } = recordingContext({
    ssh: {
      requires: [],
      implementation: {
        type: "model_method",
        modelType: "@keeb/ssh/host",
        modelName: "lab-@{host}-ssh-capability",
        methodName: "waitForConnection",
        globalArgs: { host: "@{vm.ipAddress}" },
        inputs: { timeout: 360 },
>>>>>>> Stashed changes
      },
    },
  });

  await model.methods.publish.execute({}, context as never);

  assertEquals(writes[0].data.implementation, {
    type: "model_method",
<<<<<<< Updated upstream
    modelType: "@example/package",
    modelName: "lab-@{host}-base",
    methodName: "apply",
    globalArgs: { nodeHost: "@{vm.ipAddress}" },
    inputs: {},
=======
    modelType: "@keeb/ssh/host",
    modelName: "lab-@{host}-ssh-capability",
    methodName: "waitForConnection",
    globalArgs: { host: "@{vm.ipAddress}" },
    inputs: { timeout: 360 },
>>>>>>> Stashed changes
  });
});

Deno.test("publish rejects unknown dependencies", async () => {
  const { context } = recordingContext({
    app: {
      requires: ["missing"],
      implementation: { type: "workflow", workflowIdOrName: "app" },
    },
  });

  await assertRejects(
    () => model.methods.publish.execute({}, context as never),
    Error,
    "requires unknown capability missing",
  );
});
