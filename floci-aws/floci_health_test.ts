import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@systeminit/swamp-testing@0.20260518.13";
import { model } from "./floci_health.ts";

function contextWith(response: Response) {
  const test = createModelTestContext({
    globalArgs: { endpoint: "http://127.0.0.1:4566", region: "us-east-1" },
  });
  (test.context as unknown as { fetch: typeof fetch }).fetch = () =>
    Promise.resolve(response);
  return test;
}

Deno.test("health status persists a bounded healthy observation", async () => {
  const { context, getWrittenResources } = contextWith(
    Response.json({ services: { s3: "available" } }),
  );
  await model.methods.status.execute({}, context as never);
  const data = getWrittenResources()[0].data;
  assertEquals(data.healthy, true);
  assertEquals(data.httpStatus, 200);
  assertEquals("services" in data, false);
});

Deno.test("health status rejects unsuccessful responses", async () => {
  const { context, getWrittenResources } = contextWith(
    new Response("unavailable", { status: 503 }),
  );
  await assertRejects(
    () => model.methods.status.execute({}, context as never),
    Error,
    "HTTP 503",
  );
  assertEquals(getWrittenResources(), []);
});
