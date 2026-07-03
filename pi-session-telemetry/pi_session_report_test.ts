import { assertEquals } from "jsr:@std/assert@1";
import { report } from "./pi_session_report.ts";

const encoder = new TextEncoder();

Deno.test("pi session report summarizes events, usage, tools, and errors", async () => {
  const contents: Record<string, unknown> = {
    event1: {
      id: "event1",
      sessionId: "s1",
      type: "message_end",
      timestamp: "2026-07-01T00:00:00.000Z",
      data: {
        role: "assistant",
        model: "example-model",
        contentHash: "sha256:abc",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 2,
          cacheWrite: 1,
          totalTokens: 15,
          cost: { total: 0.01 },
        },
      },
    },
    event2: {
      id: "event2",
      sessionId: "s1",
      type: "tool_execution_end",
      timestamp: "2026-07-01T00:01:00.000Z",
      data: { toolName: "bash", isError: true, message: "failed" },
    },
  };

  const result = await report.execute({
    modelType: "@evrardjp/pi-session-telemetry",
    modelId: "model-1",
    definition: { name: "telemetry" },
    dataRepository: {
      findAllForModel: async () => [
        { name: "event1", version: 1, tags: { specName: "event" } },
        { name: "event2", version: 1, tags: { specName: "event" } },
        { name: "ignored", version: 1, tags: { specName: "usage" } },
      ],
      getContent: async (_modelType, _modelId, dataName) =>
        encoder.encode(JSON.stringify(contents[dataName])),
    },
  });

  const json = result.json as {
    eventCount: number;
    messageCount: number;
    usage: { totalTokens: number };
    byTool: Record<string, number>;
  };
  assertEquals(json.eventCount, 2);
  assertEquals(json.messageCount, 1);
  assertEquals(json.usage.totalTokens, 15);
  assertEquals(json.byTool, { bash: 1 });
  assertEquals(result.markdown.includes("# Pi Session Telemetry — telemetry"), true);
  assertEquals(result.markdown.includes("failed"), true);
});

Deno.test("pi session report ignores non telemetry models", async () => {
  const result = await report.execute({ modelType: "@example/other" });

  assertEquals(result, { markdown: "", json: {} });
});
