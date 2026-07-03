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
