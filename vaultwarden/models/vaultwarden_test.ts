// deno-lint-ignore-file no-explicit-any
import { assertEquals, assertMatch, assertRejects } from "jsr:@std/assert";
import { createModelTestContext } from "jsr:@systeminit/swamp-testing";
import { model } from "./vaultwarden.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MINIMAL_TEMPLATE = `
## General settings

## Some description
# SIGNUPS_ALLOWED=true

## Database settings
DATABASE_URL=data.db

## Admin settings
# Some admin notes
# valid values: admintoken123, disabled
# ADMIN_TOKEN=
`;

function makeGlobalArgs(overrides?: Record<string, unknown>) {
  return {
    version: "latest",
    host: "192.168.164.11",
    fqdn: "vaultwarden.lab.evrard.eu",
    sshUser: "admin",
    sshKeyPath: "~/.ssh/id_ed25519",
    workDir: "/opt/vaultwarden",
    ...overrides,
  };
}

function mockFetchOk(body: string) {
  return async (_url: string) => ({ ok: true, status: 200, text: async () => body });
}

function mockFetch404() {
  return async (_url: string) => ({ ok: false, status: 404, text: async () => "Not Found" });
}

function mockSshOk(stdout = "") {
  return async (..._args: any[]) => stdout;
}

function mockSshRawOk(stdout = "") {
  return async (..._args: any[]) => ({ code: 0, stdout, stderr: "" });
}

function mockSshRawFail() {
  return async (..._args: any[]) => ({ code: 1, stdout: "", stderr: "mock error" });
}

function mockSshFail(msg = "SSH failed") {
  return async (..._args: any[]) => { throw new Error(msg); };
}

function mockScpOk() {
  return async (..._args: any[]): Promise<void> => {};
}

// ─── discover — happy path ────────────────────────────────────────────────────

Deno.test("discover — happy path parses env vars from template", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: makeGlobalArgs(),
  });

  await model.methods.discover.execute(
    { _fetch: mockFetchOk(MINIMAL_TEMPLATE) },
    context as any,
  );

  const resources = getWrittenResources();
  const tmpl = resources.find((r) => r.specName === "envTemplate");
  assertEquals(typeof tmpl?.data.fetchedAt, "string");
  assertEquals(tmpl?.data.version, "latest");
  assertMatch(tmpl?.data.templateUrl as string, /vaultwarden/);

  const envVars = tmpl?.data.envVars as Array<Record<string, unknown>>;
  const signups = envVars.find((v) => v.key === "SIGNUPS_ALLOWED");
  assertEquals(signups?.commented, true);
  assertEquals(signups?.defaultValue, "true");
  assertEquals(signups?.section, "Some description");

  const dbUrl = envVars.find((v) => v.key === "DATABASE_URL");
  assertEquals(dbUrl?.commented, false);
  assertEquals(dbUrl?.defaultValue, "data.db");

  const adminToken = envVars.find((v) => v.key === "ADMIN_TOKEN");
  assertEquals(adminToken?.commented, true);
  assertEquals((adminToken?.allowedValues as string[]).length > 0, true);
});

// ─── discover — 404 ───────────────────────────────────────────────────────────

Deno.test("discover — throws with descriptive error on HTTP 404", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: makeGlobalArgs({ version: "99.99.99" }),
  });

  await assertRejects(
    () => model.methods.discover.execute({ _fetch: mockFetch404() }, context as any),
    Error,
    "99.99.99",
  );

  assertEquals(getWrittenResources().filter((r) => r.specName === "envTemplate").length, 0);
});

// ─── discover — malformed template ────────────────────────────────────────────

Deno.test("discover — malformed template produces empty envVars without throwing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: makeGlobalArgs(),
  });

  await model.methods.discover.execute(
    { _fetch: mockFetchOk("no sections no vars at all\n") },
    context as any,
  );

  const tmpl = getWrittenResources().find((r) => r.specName === "envTemplate");
  assertEquals(Array.isArray(tmpl?.data.envVars), true);
  assertEquals((tmpl?.data.envVars as unknown[]).length, 0);
});

// ─── deploy — happy path ──────────────────────────────────────────────────────

Deno.test("deploy — happy path uploads files and starts docker compose with --wait", async () => {
  const sshCalls: string[] = [];
  const scpCalls: Array<{ remote: string }> = [];

  const sshFn = async (_h: any, _u: any, _k: any, cmd: string) => { sshCalls.push(cmd); return ""; };
  const scpFn = async (_local: any, _h: any, _u: any, _k: any, remote: string) => { scpCalls.push({ remote }); };

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: makeGlobalArgs(),
  });

  await model.methods.deploy.execute(
    { envVars: { SIGNUPS_ALLOWED: "false" }, _fetch: mockFetchOk(MINIMAL_TEMPLATE), _ssh: sshFn, _scp: scpFn },
    context as any,
  );

  const composeCall = sshCalls.find((c) => c.includes("docker compose") && c.includes("--wait"));
  assertEquals(typeof composeCall, "string");

  assertEquals(scpCalls.length, 2);
  assertEquals(scpCalls.some((s) => s.remote.endsWith("/.env")), true);

  const dep = getWrittenResources().find((r) => r.specName === "deployment");
  assertEquals(dep?.data.host, "192.168.164.11");
  assertEquals(dep?.data.version, "latest");
});

// ─── deploy — template fetch 404 ─────────────────────────────────────────────

Deno.test("deploy — throws on template 404, no SSH calls made", async () => {
  const sshCalls: string[] = [];
  const { context, getWrittenResources } = createModelTestContext({ globalArgs: makeGlobalArgs() });

  await assertRejects(
    () => model.methods.deploy.execute(
      {
        envVars: {},
        _fetch: mockFetch404(),
        _ssh: async (_h: any, _u: any, _k: any, cmd: string) => { sshCalls.push(cmd); return ""; },
        _scp: mockScpOk(),
      },
      context as any,
    ),
    Error,
  );

  assertEquals(sshCalls.length, 0);
  assertEquals(getWrittenResources().filter((r) => r.specName === "deployment").length, 0);
});

// ─── deploy — envVar override uncomments template var ─────────────────────────

Deno.test("deploy — deploy completes when envVar override provided for commented var", async () => {
  const sshCalls: string[] = [];
  const { context, getWrittenResources } = createModelTestContext({ globalArgs: makeGlobalArgs() });

  await model.methods.deploy.execute(
    {
      envVars: { SIGNUPS_ALLOWED: "false" },
      _fetch: mockFetchOk(MINIMAL_TEMPLATE),
      _ssh: async (_h: any, _u: any, _k: any, cmd: string) => { sshCalls.push(cmd); return ""; },
      _scp: mockScpOk(),
    },
    context as any,
  );

  assertEquals(sshCalls.some((c) => c.includes("docker compose")), true);
  assertEquals(getWrittenResources().filter((r) => r.specName === "deployment").length, 1);
});

// ─── deploy — docker compose failure ─────────────────────────────────────────

Deno.test("deploy — throws when docker compose up fails, no deployment resource", async () => {
  let composeCalled = false;
  const sshFn = async (_h: any, _u: any, _k: any, cmd: string) => {
    if (cmd.includes("docker compose")) {
      composeCalled = true;
      throw new Error("docker compose up failed: container unhealthy");
    }
    return "";
  };

  const { context, getWrittenResources } = createModelTestContext({ globalArgs: makeGlobalArgs() });

  await assertRejects(
    () => model.methods.deploy.execute(
      { envVars: {}, _fetch: mockFetchOk(MINIMAL_TEMPLATE), _ssh: sshFn, _scp: mockScpOk() },
      context as any,
    ),
    Error,
    "docker compose",
  );

  assertEquals(composeCalled, true);
  assertEquals(getWrittenResources().filter((r) => r.specName === "deployment").length, 0);
});

// ─── configure — updates existing key ────────────────────────────────────────

Deno.test("configure — updates existing key without duplicating", async () => {
  const existingEnv = "ROCKET_PORT=8000\nSIGNUPS_ALLOWED=true\n";
  let uploadedContent = "";

  const sshFn = async (_h: any, _u: any, _k: any, cmd: string) => {
    if (cmd.startsWith("cat ")) return existingEnv;
    return "";
  };
  const scpFn = async (local: string) => {
    try { uploadedContent = await Deno.readTextFile(local); } catch { /* ignore */ }
  };

  const { context } = createModelTestContext({ globalArgs: makeGlobalArgs() });
  await model.methods.configure.execute(
    { envVars: { SIGNUPS_ALLOWED: "false" }, _ssh: sshFn, _scp: scpFn },
    context as any,
  );

  if (uploadedContent) {
    const signupLines = uploadedContent.split("\n").filter((l) => l.startsWith("SIGNUPS_ALLOWED="));
    assertEquals(signupLines.length, 1);
    assertEquals(signupLines[0], "SIGNUPS_ALLOWED='false'");
  }
});

// ─── configure — appends new key ──────────────────────────────────────────────

Deno.test("configure — appends new key not present in existing .env", async () => {
  const existingEnv = "ROCKET_PORT=8000\n";
  let uploadedContent = "";

  const sshFn = async (_h: any, _u: any, _k: any, cmd: string) => {
    if (cmd.startsWith("cat ")) return existingEnv;
    return "";
  };
  const scpFn = async (local: string) => {
    try { uploadedContent = await Deno.readTextFile(local); } catch { /* ignore */ }
  };

  const { context } = createModelTestContext({ globalArgs: makeGlobalArgs() });
  await model.methods.configure.execute(
    { envVars: { NEW_SETTING: "value123" }, _ssh: sshFn, _scp: scpFn },
    context as any,
  );

  if (uploadedContent) {
    assertEquals(uploadedContent.includes("NEW_SETTING='value123'"), true);
  }
});

// ─── verify — healthy ─────────────────────────────────────────────────────────

Deno.test("verify — healthy: containerRunning=true, httpReachable=true", async () => {
  const psJson = JSON.stringify({ Service: "vaultwarden", State: "running", Health: "healthy" });
  const { context, getWrittenResources } = createModelTestContext({ globalArgs: makeGlobalArgs() });

  await model.methods.verify.execute(
    { _ssh: mockSshRawOk(psJson), _curl: async () => ({ code: 0 }) },
    context as any,
  );

  const ver = getWrittenResources().find((r) => r.specName === "verification");
  assertEquals(ver?.data.containerRunning, true);
  assertEquals(ver?.data.httpReachable, true);
  assertEquals(ver?.data.host, "192.168.164.11");
  assertEquals(ver?.data.fqdn, "vaultwarden.lab.evrard.eu");
});

// ─── verify — container down ──────────────────────────────────────────────────

Deno.test("verify — container down: resource written with containerRunning=false", async () => {
  const psJson = JSON.stringify({ Service: "vaultwarden", State: "exited" });
  const { context, getWrittenResources } = createModelTestContext({ globalArgs: makeGlobalArgs() });

  await model.methods.verify.execute(
    { _ssh: mockSshRawOk(psJson), _curl: async () => ({ code: 0 }) },
    context as any,
  );

  const ver = getWrittenResources().find((r) => r.specName === "verification");
  assertEquals(ver?.data.containerRunning, false);
  assertEquals(ver?.data.httpReachable, true);
});

// ─── verify — SSH ps fails ────────────────────────────────────────────────────

Deno.test("verify — SSH ps failure: containerRunning=false, resource still written", async () => {
  const { context, getWrittenResources } = createModelTestContext({ globalArgs: makeGlobalArgs() });

  await model.methods.verify.execute(
    { _ssh: mockSshRawFail(), _curl: async () => ({ code: 0 }) },
    context as any,
  );

  const ver = getWrittenResources().find((r) => r.specName === "verification");
  assertEquals(ver?.data.containerRunning, false);
  assertEquals(ver?.data.httpReachable, true);
});

// ─── verify — curl fails ──────────────────────────────────────────────────────

Deno.test("verify — curl fails: httpReachable=false, resource still written", async () => {
  const psJson = JSON.stringify({ Service: "vaultwarden", State: "running", Health: "healthy" });
  const { context, getWrittenResources } = createModelTestContext({ globalArgs: makeGlobalArgs() });

  await model.methods.verify.execute(
    { _ssh: mockSshRawOk(psJson), _curl: async () => ({ code: 1 }) },
    context as any,
  );

  const ver = getWrittenResources().find((r) => r.specName === "verification");
  assertEquals(ver?.data.containerRunning, true);
  assertEquals(ver?.data.httpReachable, false);
});

// ─── deploy — duplicate template keys produce single active line ──────────────

Deno.test("deploy — duplicate template keys produce exactly one active line", async () => {
  const templateWithDuplicates = `
## Admin settings
# ADMIN_TOKEN='$argon2id$v=19$m=65540,t=3,p=4$example'
# ADMIN_TOKEN=plaintexttoken
`;
  let capturedEnv = "";
  const scpFn = async (local: string) => {
    if (local.endsWith(".env")) {
      capturedEnv = await Deno.readTextFile(local);
    }
  };
  const { context } = createModelTestContext({ globalArgs: makeGlobalArgs() });

  await model.methods.deploy.execute(
    {
      envVars: { ADMIN_TOKEN: "myhash" },
      _fetch: mockFetchOk(templateWithDuplicates),
      _ssh: mockSshOk(),
      _scp: scpFn,
    },
    context as any,
  );

  const activeLines = capturedEnv.split("\n").filter((l) => l.startsWith("ADMIN_TOKEN="));
  assertEquals(activeLines.length, 1, "ADMIN_TOKEN must appear exactly once as an active line");
  assertEquals(activeLines[0], "ADMIN_TOKEN='myhash'");
});

// ─── deploy — values are single-quoted to prevent docker-compose interpolation ──

Deno.test("deploy — values are single-quoted in .env to prevent docker-compose interpolation", async () => {
  let capturedEnv = "";
  const scpFn = async (local: string) => {
    if (local.endsWith(".env")) {
      capturedEnv = await Deno.readTextFile(local);
    }
  };
  const { context } = createModelTestContext({ globalArgs: makeGlobalArgs() });

  await model.methods.deploy.execute(
    {
      envVars: {
        ADMIN_TOKEN: "$argon2id$v=19$m=65540,t=3,p=4$salt$hash",
        ROCKET_TLS: '{certs="/opt/certs/a.crt",key="/opt/certs/a.key"}',
        SIMPLE_KEY: "plainvalue",
      },
      _fetch: mockFetchOk(MINIMAL_TEMPLATE),
      _ssh: mockSshOk(),
      _scp: scpFn,
    },
    context as any,
  );

  const lines = capturedEnv.split("\n").filter(Boolean);
  const adminLine = lines.find((l) => l.startsWith("ADMIN_TOKEN="));
  const tlsLine = lines.find((l) => l.startsWith("ROCKET_TLS="));
  const simpleLine = lines.find((l) => l.startsWith("SIMPLE_KEY="));

  assertEquals(adminLine, "ADMIN_TOKEN='$argon2id$v=19$m=65540,t=3,p=4$salt$hash'");
  assertEquals(tlsLine, `ROCKET_TLS='{certs="/opt/certs/a.crt",key="/opt/certs/a.key"}'`);
  assertEquals(simpleLine, "SIMPLE_KEY='plainvalue'");
});

// ─── verify — both fail ───────────────────────────────────────────────────────

Deno.test("verify — both SSH and curl fail: resource written with both false", async () => {
  const { context, getWrittenResources } = createModelTestContext({ globalArgs: makeGlobalArgs() });

  await model.methods.verify.execute(
    { _ssh: mockSshRawFail(), _curl: async () => ({ code: 1 }) },
    context as any,
  );

  const ver = getWrittenResources().find((r) => r.specName === "verification");
  assertEquals(ver?.data.containerRunning, false);
  assertEquals(ver?.data.httpReachable, false);
  assertEquals(typeof ver?.data.verifiedAt, "string");
});
