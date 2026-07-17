import { assertEquals } from "jsr:@std/assert@1";
import type { Message, Part, Session } from "@opencode-ai/sdk";
import { buildExportPayload } from "./opencode_swamp_exporter.ts";

Deno.test("exporter computes analytics and creates native tagged archives", () => {
  const session = {
    id: "ses_test",
    projectID: "project-test",
    directory: "/synthetic/private-project",
    title: "[archive] Webhook design",
    version: "1.18.3",
    time: { created: 1000, updated: 61000 },
  } as Session;
  const messages = [{
    info: {
      id: "msg_user",
      sessionID: "ses_test",
      role: "user",
      time: { created: 1000 },
      agent: "build",
      model: { providerID: "example", modelID: "model" },
    } as Message,
    parts: [{
      id: "part_user",
      sessionID: "ses_test",
      messageID: "msg_user",
      type: "text",
      text: "Build session analytics",
    } as Part],
  }, {
    info: {
      id: "msg_assistant",
      sessionID: "ses_test",
      role: "assistant",
      parentID: "msg_user",
      time: { created: 2000, completed: 60000 },
      modelID: "model",
      providerID: "example",
      mode: "build",
      path: { cwd: "/synthetic/private-project", root: "/synthetic" },
      cost: 0.02,
      tokens: {
        input: 100,
        output: 20,
        reasoning: 5,
        cache: { read: 10, write: 2 },
      },
    } as Message,
    parts: [{
      id: "part_tool",
      sessionID: "ses_test",
      messageID: "msg_assistant",
      type: "tool",
      callID: "call_test",
      tool: "read",
      state: {
        status: "completed",
        input: {},
        output: "ok",
        title: "Read",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    } as unknown as Part],
  }];

  const result = buildExportPayload(session, messages, {
    archivePolicy: "tagged",
    archiveTitleTag: "[archive]",
    includeDiscussionText: true,
    includeDirectory: false,
    discussionMaxChars: 1000,
  }, "idle");

  assertEquals(result.metadata.archived, true);
  assertEquals(result.metadata.directory, undefined);
  assertEquals(result.metadata.discussion, "Build session analytics");
  assertEquals(result.metadata.discussionTruncated, false);
  assertEquals(result.metadata.toolCallCount, 1);
  assertEquals(result.metadata.tools, { read: 1 });
  assertEquals(result.metadata.models[0].inputTokens, 100);
  assertEquals(JSON.parse(result.archiveJson!), { info: session, messages });
});
