import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { model } from "./vaultwarden.ts";

const template = `## General
# The domain setting
# DOMAIN=https://example.com
# SIGNUPS_ALLOWED=false
DATABASE_URL=data/db.sqlite3
`;

function text(body: string, status = 200): Response {
  return new Response(body, { status });
}

function context(
  routes: Record<string, Response>,
  globalArgs: Partial<{ version: string; fqdn: string; baseUrl: string }> = {},
) {
  const writes: Array<{
    specName: string;
    instanceName: string;
    data: Record<string, unknown>;
  }> = [];
  const requests: string[] = [];
  const logs: Array<
    { level: string; msg: string; props?: Record<string, unknown> }
  > = [];
  return {
    writes,
    requests,
    logs,
    ctx: {
      globalArgs: {
        version: "latest",
        fqdn: "vaultwarden.example.com",
        ...globalArgs,
      },
      logger: {
        info(msg: string, props?: Record<string, unknown>) {
          logs.push({ level: "info", msg, props });
        },
        debug(msg: string, props?: Record<string, unknown>) {
          logs.push({ level: "debug", msg, props });
        },
        warning(msg: string, props?: Record<string, unknown>) {
          logs.push({ level: "warning", msg, props });
        },
        error(msg: string, props?: Record<string, unknown>) {
          logs.push({ level: "error", msg, props });
        },
      },
      writeResource: async (
        specName: string,
        instanceName: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ specName, instanceName, data });
        return { specName, instanceName };
      },
      createFileWriter: () => ({
        writeLine: async () => {},
        finalize: async () => ({ specName: "log", instanceName: "test" }),
      }),
      fetch: async (input: string | URL | Request) => {
        const url = String(input);
        requests.push(url);
        return routes[url] ?? text("missing", 404);
      },
    },
  };
}

Deno.test("discover records the upstream env var catalog", async () => {
  const url =
    "https://raw.githubusercontent.com/dani-garcia/vaultwarden/main/.env.template";
  const h = context({ [url]: text(template) });

  await model.methods.discover.execute({}, h.ctx);

  assertEquals(h.writes[0].specName, "envTemplate");
  const envVars = h.writes[0].data.envVars as Array<Record<string, unknown>>;
  assertEquals(envVars.length, 3);
  assertEquals(envVars[0].key, "DOMAIN");
});

Deno.test("render-env emits env content for another extension to deploy", async () => {
  const url =
    "https://raw.githubusercontent.com/dani-garcia/vaultwarden/main/.env.template";
  const h = context({ [url]: text(template) });

  await model.methods["render-env"].execute({
    envVars: { SIGNUPS_ALLOWED: "true" },
  }, h.ctx);

  const data = h.writes[0].data;
  assertEquals(h.writes[0].specName, "envFile");
  assertEquals(data.domain, "https://vaultwarden.example.com");
  assertStringIncludes(
    data.envFile as string,
    "DOMAIN='https://vaultwarden.example.com'",
  );
  assertStringIncludes(data.envFile as string, "SIGNUPS_ALLOWED='true'");
  assertEquals(
    model.resources.envFile.sensitiveOutput,
    true,
    "rendered .env content must be stored as sensitive output",
  );
  assert(
    h.logs.some((entry) =>
      entry.level === "info" &&
      entry.msg === "Rendered Vaultwarden environment file"
    ),
  );
});

Deno.test("render-env escapes single quotes and supports custom baseUrl", async () => {
  const url =
    "https://raw.githubusercontent.com/dani-garcia/vaultwarden/main/.env.template";
  const h = context({ [url]: text(template) }, {
    baseUrl: "https://vaultwarden.example.com/base/",
  });

  await model.methods["render-env"].execute({
    envVars: { ADMIN_TOKEN: "don't-log-me" },
  }, h.ctx);

  const data = h.writes[0].data;
  assertEquals(data.domain, "https://vaultwarden.example.com/base");
  assertStringIncludes(
    data.envFile as string,
    "ADMIN_TOKEN='don'\\''t-log-me'",
  );
  assert(
    !JSON.stringify(h.logs).includes("don't-log-me"),
    "logs must not include secret override values",
  );
});

Deno.test("discover throws before writing when template fetch fails", async () => {
  const url =
    "https://raw.githubusercontent.com/dani-garcia/vaultwarden/main/.env.template";
  const h = context({ [url]: text("missing", 404) });

  await assertRejects(
    () => model.methods.discover.execute({}, h.ctx),
    Error,
    "Failed to fetch Vaultwarden .env.template",
  );
  assertEquals(h.writes.length, 0);
});

Deno.test("verify records reachable health", async () => {
  const h = context({ "https://vaultwarden.example.com/alive": text("", 200) });

  await model.methods.verify.execute({}, h.ctx);

  assertEquals(h.writes[0].specName, "verification");
  assertEquals(h.writes[0].data.reachable, true);
  assertEquals(h.writes[0].data.httpStatus, 200);
});

Deno.test("verify records failed health without throwing", async () => {
  const h = context({
    "https://vaultwarden.example.com/alive": text("no", 503),
  });

  await model.methods.verify.execute({}, h.ctx);

  assertEquals(h.writes[0].data.reachable, false);
  assertEquals(h.writes[0].data.httpStatus, 503);
  assertEquals(h.requests.length, 3);
});

Deno.test("verify supports explicit health URL", async () => {
  const h = context({ "https://health.example.net/alive": text("", 200) });

  await model.methods.verify.execute({
    url: "https://health.example.net/alive",
  }, h.ctx);

  assertEquals(h.writes[0].data.url, "https://health.example.net/alive");
  assertEquals(h.writes[0].data.reachable, true);
  assertEquals(h.writes[0].data.httpStatus, 200);
});

Deno.test("model declares upgrade to current version", () => {
  assertEquals(model.upgrades.at(-1)?.toVersion, model.version);
});
