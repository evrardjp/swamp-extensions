import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@systeminit/swamp-testing@0.20260518.13";
import {
  DeletePrefixArgsSchema,
  model as objectModel,
  ObjectConditionsSchema,
  PutObjectArgsSchema,
} from "./s3_object.ts";

function globals(overrides: Record<string, unknown> = {}) {
  return {
    endpoint: "http://127.0.0.1:4566",
    region: "us-east-1",
    bucket: "floci-test-bucket",
    key: "folder/smoke file.txt",
    ...overrides,
  };
}

function withFetch(
  context: unknown,
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): void {
  (context as { fetch: typeof fetch }).fetch = (input, init) =>
    Promise.resolve(handler(new URL(String(input)), init));
}

Deno.test("schemas reject conflicting conditions and unsafe deletion bounds", () => {
  assertEquals(
    ObjectConditionsSchema.safeParse({ ifMatch: "a", ifNoneMatch: "*" })
      .success,
    false,
  );
  assertEquals(
    PutObjectArgsSchema.safeParse({ body: "x", ifMatch: "" }).success,
    false,
  );
  assertEquals(DeletePrefixArgsSchema.safeParse({ prefix: "" }).success, false);
  assertEquals(
    DeletePrefixArgsSchema.safeParse({ prefix: "x", maxObjects: 100_001 })
      .success,
    false,
  );
});

Deno.test("object put forwards If-None-Match and does not persist body", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: globals(),
  });
  withFetch(context, (url, init) => {
    assertEquals(url.pathname, "/floci-test-bucket/folder/smoke%20file.txt");
    assertEquals(init?.method, "PUT");
    assertEquals(new Headers(init?.headers).get("if-none-match"), "*");
    assertEquals(init?.body, "hello");
    return new Response(null, { status: 200, headers: { etag: '"etag-1"' } });
  });
  await objectModel.methods.put.execute(
    { body: "hello", contentType: "text/plain", ifNoneMatch: "*" },
    context as never,
  );
  const data = getWrittenResources()[0].data;
  assertEquals(data.etag, '"etag-1"');
  assertEquals("body" in data, false);
  assertEquals(typeof data.bodySha256, "string");
});

Deno.test("object get forwards If-Match and persists only body digest", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: globals(),
  });
  withFetch(context, (_url, init) => {
    assertEquals(init?.method, "GET");
    assertEquals(new Headers(init?.headers).get("if-match"), '"etag-1"');
    return new Response("hello", {
      headers: { etag: '"etag-1"', "content-type": "text/plain" },
    });
  });
  await objectModel.methods.get.execute(
    { ifMatch: '"etag-1"' },
    context as never,
  );
  const data = getWrittenResources()[0].data;
  assertEquals(data.size, 5);
  assertEquals("body" in data, false);
});

Deno.test("object head persists remote metadata", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: globals(),
  });
  withFetch(context, (_url, init) => {
    assertEquals(init?.method, "HEAD");
    return new Response(null, {
      headers: {
        etag: '"etag-1"',
        "content-length": "5",
        "content-type": "text/plain",
      },
    });
  });
  await objectModel.methods.head.execute({}, context as never);
  const data = getWrittenResources()[0].data;
  assertEquals(data.operation, "head");
  assertEquals(data.size, 5);
  assertEquals(data.contentType, "text/plain");
});

Deno.test("object delete forwards If-Match and persists absence", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: globals(),
  });
  withFetch(context, (_url, init) => {
    assertEquals(init?.method, "DELETE");
    assertEquals(new Headers(init?.headers).get("if-match"), '"etag-1"');
    return new Response(null, { status: 204 });
  });
  await objectModel.methods.delete.execute(
    { ifMatch: '"etag-1"' },
    context as never,
  );
  assertEquals(getWrittenResources()[0].data.exists, false);
});

Deno.test("object list parses bounded S3 XML and reports truncation", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: globals(),
  });
  withFetch(context, (url, init) => {
    assertEquals(init?.method, "GET");
    assertEquals(url.searchParams.get("list-type"), "2");
    assertEquals(url.searchParams.get("max-keys"), "2");
    return new Response(
      "<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>a&amp;b.txt</Key><LastModified>2026-07-21T00:00:00Z</LastModified><ETag>&quot;e1&quot;</ETag><Size>5</Size></Contents></ListBucketResult>",
    );
  });
  await objectModel.methods.list.execute(
    { prefix: "", maxKeys: 2 },
    context as never,
  );
  const data = getWrittenResources()[0].data;
  assertEquals(data.truncated, true);
  assertEquals(data.objects, [{
    key: "a&b.txt",
    etag: '"e1"',
    size: 5,
    lastModified: "2026-07-21T00:00:00Z",
  }]);
  assertMatch(JSON.stringify(data), /a&b\.txt/);
});

Deno.test("object deletePrefix fans out until the prefix is empty", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: globals(),
  });
  let listings = 0;
  const deleted: string[] = [];
  withFetch(context, (url, init) => {
    if (init?.method === "GET") {
      assertEquals(url.searchParams.get("prefix"), "phase1/test");
      listings++;
      return new Response(
        listings === 1
          ? "<ListBucketResult><Contents><Key>phase1/test/a</Key></Contents><Contents><Key>phase1/test/b</Key></Contents></ListBucketResult>"
          : "<ListBucketResult></ListBucketResult>",
      );
    }
    assertEquals(init?.method, "DELETE");
    deleted.push(decodeURIComponent(url.pathname));
    return new Response(null, { status: 204 });
  });

  await objectModel.methods.deletePrefix.execute(
    { prefix: "phase1/test", maxObjects: 10_000 },
    context as never,
  );

  assertEquals(listings, 1);
  assertEquals(deleted.sort(), [
    "/floci-test-bucket/phase1/test/a",
    "/floci-test-bucket/phase1/test/b",
  ]);
  assertEquals(getWrittenResources()[0].data.deleted, 2);
  assertEquals(getWrittenResources()[0].data.truncated, false);
});

Deno.test("object deletePrefix reports truncation at its deletion bound", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: globals(),
  });
  let listings = 0;
  withFetch(context, (_url, init) => {
    if (init?.method === "GET") {
      listings++;
      return new Response(
        `<ListBucketResult><Contents><Key>phase1/test/${listings}</Key></Contents></ListBucketResult>`,
      );
    }
    return new Response(null, { status: 204 });
  });

  await objectModel.methods.deletePrefix.execute(
    { prefix: "phase1/test", maxObjects: 1 },
    context as never,
  );

  assertEquals(listings, 2);
  assertEquals(getWrittenResources()[0].data.deleted, 1);
  assertEquals(getWrittenResources()[0].data.truncated, true);
});
