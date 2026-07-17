import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./opencode_session_archive.ts";

type Written = {
  specName: string;
  name: string;
  data?: Record<string, unknown>;
  text?: string;
};

function testContext(stored: Record<string, unknown> | null = null) {
  const writes: Written[] = [];
  return {
    writes,
    context: {
      readResource: async () => stored,
      writeResource: async (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ specName, name, data });
        return { name };
      },
      createFileWriter: (specName: string, name: string) => ({
        writeText: async (text: string) => {
          writes.push({ specName, name, text });
          return { name };
        },
      }),
    },
  };
}

function payload(archived = true) {
  const archive = {
    info: {
      id: "ses_test",
      projectID: "project-test",
      directory: "/synthetic/project",
      title: "Synthetic session",
      version: "1.18.3",
      time: { created: 1000, updated: 2000 },
    },
    messages: [{
      info: {
        id: "msg_test",
        sessionID: "ses_test",
        role: "user",
        time: { created: 1000 },
        agent: "build",
        model: { providerID: "example", modelID: "model" },
      },
      parts: [{
        id: "part_test",
        sessionID: "ses_test",
        messageID: "msg_test",
        type: "text",
        text: "Synthetic content",
      }],
    }],
  };
  return {
    schemaVersion: 1 as const,
    exportedAt: "2026-07-17T00:00:00.000Z",
    reason: "manual" as const,
    metadata: {
      sessionID: "ses_test",
      projectID: "project-test",
      title: "Synthetic session",
      opencodeVersion: "1.18.3",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:01:00.000Z",
      durationMs: 60000,
      messageCount: 1,
      userMessageCount: 1,
      assistantMessageCount: 0,
      toolCallCount: 0,
      errorCount: 0,
      discussionTruncated: false,
      archived,
      models: [],
      tools: {},
    },
    archiveJson: archived ? JSON.stringify(archive) : undefined,
  };
}

Deno.test("ingest stores metadata and an exact native archive", async () => {
  const { writes, context } = testContext();
  await model.methods.ingest.execute({ payload: payload() }, context);

  assertEquals(writes.map((write) => write.specName), [
    "archive",
    "session",
    "receipt",
  ]);
  assertEquals(writes[0].name, "archive-ses_test");
  assertEquals(writes[1].name, "session-ses_test");
  assertEquals(
    JSON.parse(writes[0].text!),
    JSON.parse(payload().archiveJson!),
  );
  assertEquals(writes[2].data?.archiveDataName, "archive-ses_test");
});

Deno.test("ingest rejects mismatched archive IDs before writing", async () => {
  const { writes, context } = testContext();
  const invalid = payload();
  const archive = JSON.parse(invalid.archiveJson!);
  archive.info.id = "ses_other";
  invalid.archiveJson = JSON.stringify(archive);

  await assertRejects(
    () => model.methods.ingest.execute({ payload: invalid }, context),
    Error,
    "archive session ID must match",
  );
  assertEquals(writes, []);
});

Deno.test("metadata-only updates preserve an existing archive claim", async () => {
  const { writes, context } = testContext({ archived: true });

  await model.methods.ingest.execute({ payload: payload(false) }, context);

  assertEquals(writes[0].data?.archived, true);
  assertEquals(writes[1].data?.archiveDataName, "archive-ses_test");
});
