import { assertEquals } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@systeminit/swamp-testing@0.20260518.13";
import { model, S3BucketGlobalArgsSchema } from "./s3_bucket.ts";

function testContext(region = "us-east-1") {
  return createModelTestContext({
    globalArgs: {
      endpoint: "http://127.0.0.1:4566",
      region,
      bucket: "floci-test-bucket",
    },
  });
}

function withFetch(
  context: unknown,
  handler: (url: URL, init?: RequestInit) => Response,
): void {
  (context as { fetch: typeof fetch }).fetch = (input, init) =>
    Promise.resolve(handler(new URL(String(input)), init));
}

Deno.test("bucket schema rejects invalid names", () => {
  assertEquals(
    S3BucketGlobalArgsSchema.safeParse({
      endpoint: "http://127.0.0.1:4566",
      region: "us-east-1",
      bucket: "UPPER",
    }).success,
    false,
  );
});

Deno.test("bucket create sends an empty us-east-1 request", async () => {
  const { context, getWrittenResources } = testContext();
  withFetch(context, (_url, init) => {
    assertEquals(init?.method, "PUT");
    assertEquals(init?.body, "");
    return new Response(null, { status: 200 });
  });
  await model.methods.create.execute({}, context as never);
  assertEquals(getWrittenResources()[0].data.operation, "create");
});

Deno.test("bucket create sends a location constraint outside us-east-1", async () => {
  const { context } = testContext("eu-west-1");
  withFetch(context, (_url, init) => {
    assertEquals(
      String(init?.body).includes("<LocationConstraint>eu-west-1"),
      true,
    );
    assertEquals(
      new Headers(init?.headers).get("content-type"),
      "application/xml",
    );
    return new Response(null, { status: 200 });
  });
  await model.methods.create.execute({}, context as never);
});

for (const operation of ["head", "sync"] as const) {
  Deno.test(`bucket ${operation} observes path-style metadata`, async () => {
    const { context, getWrittenResources } = testContext();
    withFetch(context, (url, init) => {
      assertEquals(url.pathname, "/floci-test-bucket/");
      assertEquals(init?.method, "HEAD");
      return new Response(null, {
        status: 200,
        headers: { "x-amz-bucket-region": "us-east-1" },
      });
    });
    await model.methods[operation].execute({}, context as never);
    assertEquals(getWrittenResources()[0].data.operation, operation);
  });
}

Deno.test("bucket delete persists absence after successful deletion", async () => {
  const { context, getWrittenResources } = testContext();
  withFetch(context, (_url, init) => {
    assertEquals(init?.method, "DELETE");
    return new Response(null, { status: 204 });
  });
  await model.methods.delete.execute({}, context as never);
  assertEquals(getWrittenResources()[0].data.exists, false);
});
