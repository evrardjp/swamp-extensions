import { assertEquals } from "jsr:@std/assert@1";
import { model } from "./pi_session_telemetry.ts";

type Written = {
  specName: string;
  name: string;
  data: Record<string, unknown>;
};

function context(globalArgs: Record<string, unknown> = {}) {
  const writes: Written[] = [];
  return {
    writes,
    ctx: {
      definition: { name: "pi-session-telemetry-test" },
      globalArgs,
      writeResource: async (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ specName, name, data });
        return { name };
      },
    },
  };
}

const baseEvent = {
  id: "evt-1",
  sessionId: "session-1",
  type: "message_end",
  timestamp: "2026-06-17T00:00:00.000Z",
  cwd: "/home/example/private-repo",
  sessionFile: "/home/example/.pi/session.jsonl",
  data: {
    role: "assistant",
    model: "example-model",
    content: [{ type: "text", text: "secret answer" }],
    contentText: "secret answer",
    contentHash: "sha256:abc",
    raw: { private: true },
    usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0.01 } },
  },
};

Deno.test("pi telemetry defaults redact content and local paths", async () => {
  const { writes, ctx } = context();
  await model.methods.ingest.execute({ event: baseEvent }, ctx);

  const event = writes.find((write) => write.specName === "event")!.data;
  assertEquals(event.cwd, undefined);
  assertEquals(event.sessionFile, undefined);
  assertEquals((event.data as Record<string, unknown>).content, undefined);
  assertEquals((event.data as Record<string, unknown>).contentText, undefined);
  assertEquals((event.data as Record<string, unknown>).raw, undefined);
  assertEquals(
    (event.data as Record<string, unknown>).contentHash,
    "sha256:abc",
  );

  const message = writes.find((write) => write.specName === "message")!.data;
  assertEquals(message.cwd, undefined);
  assertEquals(message.content, undefined);
  assertEquals(message.contentText, undefined);
  assertEquals(message.contentHash, "sha256:abc");
});

Deno.test("pi telemetry opt-in preserves content and local paths", async () => {
  const { writes, ctx } = context({
    includeContent: true,
    includeToolPayloads: true,
    includePaths: true,
  });
  await model.methods.ingest.execute({ event: baseEvent }, ctx);

  const event = writes.find((write) => write.specName === "event")!.data;
  assertEquals(event.cwd, "/home/example/private-repo");
  assertEquals(event.sessionFile, "/home/example/.pi/session.jsonl");
  assertEquals(
    (event.data as Record<string, unknown>).contentText,
    "secret answer",
  );
  assertEquals((event.data as Record<string, unknown>).raw, { private: true });
});
