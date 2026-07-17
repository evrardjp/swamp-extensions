import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./opencode_session_overview.ts";

const encoder = new TextEncoder();

Deno.test("overview uses only the latest metadata version", async () => {
  const base = {
    sessionID: "ses_test",
    title: "Synthetic discussion",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T01:00:00.000Z",
    durationMs: 3600000,
    messageCount: 4,
    toolCallCount: 2,
    errorCount: 1,
    discussion: "Tested archive and restore behavior",
    archived: true,
    models: [{
      providerID: "example",
      modelID: "model",
      inputTokens: 100,
      outputTokens: 25,
      reasoningTokens: 5,
      cacheReadTokens: 10,
      cacheWriteTokens: 2,
      cost: 0.01,
    }],
    tools: { read: 2 },
  };
  const versions: Record<number, unknown> = {
    1: { ...base, messageCount: 1, archived: false },
    2: base,
  };
  const result = await report.execute({
    modelType: "@evrardjp/opencode-session-archive",
    modelId: "model-test",
    definition: { name: "opencode-sessions" },
    dataRepository: {
      findAllForModel: async () => [
        { name: "session-ses_test", version: 1, tags: { specName: "session" } },
        { name: "session-ses_test", version: 2, tags: { specName: "session" } },
        { name: "archive-ses_test", version: 1, tags: { specName: "archive" } },
      ],
      getContent: async (_type, _id, _name, version) =>
        encoder.encode(JSON.stringify(versions[version!])),
    },
  });

  const json = result.json as {
    sessionCount: number;
    archivedCount: number;
    messageCount: number;
  };
  assertEquals(json.sessionCount, 1);
  assertEquals(json.archivedCount, 1);
  assertEquals(json.messageCount, 4);
  assertStringIncludes(result.markdown, "Synthetic discussion");
  assertStringIncludes(result.markdown, "archive-ses_test");
});
