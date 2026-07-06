// deno-lint-ignore-file no-explicit-any
import { assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@systeminit/swamp-testing@0.20260518.13";
import { model } from "./selfcert.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeVaultPut(
  calls: Array<{ vault: string; key: string; value: string }>,
  failOnKey?: string,
) {
  return async (vault: string, key: string, value: string): Promise<void> => {
    if (failOnKey && key === failOnKey) {
      throw new Error(`mock vault put failure for key "${key}"`);
    }
    calls.push({ vault, key, value });
  };
}

function makeVaultDelete(calls: Array<{ vault: string; key: string }>) {
  return async (vault: string, key: string): Promise<void> => {
    calls.push({ vault, key });
  };
}

function defaultGlobalArgs(overrides?: Record<string, unknown>) {
  return {
    fqdn: "test.example.com",
    ipSans: [] as string[],
    vaultName: "local",
    certVaultKey: "CERT",
    keyVaultKey: "KEY",
    days: 365,
    ...overrides,
  };
}

// ─── generate — happy path ────────────────────────────────────────────────────

Deno.test("generate — happy path produces valid PEM cert and stores to vault", async () => {
  const vaultCalls: Array<{ vault: string; key: string; value: string }> = [];
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: defaultGlobalArgs(),
  });

  await model.methods.generate.execute(
    { _vaultPut: makeVaultPut(vaultCalls) },
    context as any,
  );

  assertEquals(vaultCalls.length, 2);
  const certPut = vaultCalls.find((c) => c.key === "CERT");
  const keyPut = vaultCalls.find((c) => c.key === "KEY");

  assertEquals(certPut?.vault, "local");
  assertEquals(keyPut?.vault, "local");

  assertMatch(certPut!.value, /^-----BEGIN CERTIFICATE-----/);
  assertMatch(certPut!.value, /-----END CERTIFICATE-----/);
  assertMatch(keyPut!.value, /^-----BEGIN PRIVATE KEY-----/);
  assertMatch(keyPut!.value, /-----END PRIVATE KEY-----/);

  const resources = getWrittenResources();
  const certResource = resources.find((r) => r.specName === "cert");
  assertEquals(certResource?.data.fqdn, "test.example.com");
  assertEquals(certResource?.data.vaultName, "local");
  assertEquals(certResource?.data.certVaultKey, "CERT");
  assertEquals(certResource?.data.keyVaultKey, "KEY");
  assertEquals(typeof certResource?.data.generatedAt, "string");
  assertEquals(typeof certResource?.data.expiresAt, "string");
});

// ─── generate — idempotent skip ───────────────────────────────────────────────

Deno.test("generate — skips when cert resource already exists", async () => {
  const vaultCalls: Array<{ vault: string; key: string; value: string }> = [];
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: defaultGlobalArgs(),
    storedResources: {
      "current": {
        fqdn: "test.example.com",
        vaultName: "local",
        certVaultKey: "CERT",
        keyVaultKey: "KEY",
        generatedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
    },
  });

  await model.methods.generate.execute(
    { _vaultPut: makeVaultPut(vaultCalls) },
    context as any,
  );

  assertEquals(vaultCalls.length, 0);
  assertEquals(
    getWrittenResources().filter((r) => r.specName === "cert").length,
    0,
  );
});

// ─── generate — vault put failure ─────────────────────────────────────────────

Deno.test("generate — throws when vault put for cert fails, no resource written", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: defaultGlobalArgs(),
  });

  await assertRejects(
    () =>
      model.methods.generate.execute(
        { _vaultPut: makeVaultPut([], "CERT") },
        context as any,
      ),
    Error,
    "mock vault put failure",
  );

  assertEquals(
    getWrittenResources().filter((r) => r.specName === "cert").length,
    0,
  );
});

Deno.test("generate — throws when vault put for key fails, no resource written", async () => {
  const calls: Array<{ vault: string; key: string; value: string }> = [];
  const deletes: Array<{ vault: string; key: string }> = [];
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: defaultGlobalArgs(),
  });

  await assertRejects(
    () =>
      model.methods.generate.execute(
        {
          _vaultPut: makeVaultPut(calls, "KEY"),
          _vaultDelete: makeVaultDelete(deletes),
        },
        context as any,
      ),
    Error,
    "mock vault put failure",
  );

  assertEquals(calls.length, 1); // cert put succeeded
  assertEquals(deletes, [{ vault: "local", key: "CERT" }]);
  assertEquals(
    getWrittenResources().filter((r) => r.specName === "cert").length,
    0,
  );
});

Deno.test("generate — uses runtime vaultService.put when no test hook is provided", async () => {
  const vaultCalls: Array<{ vault: string; key: string; value: string }> = [];
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: defaultGlobalArgs(),
  });
  const vaultService = {
    put(vault: string, key: string, value: string): Promise<void> {
      assertEquals(this, vaultService);
      vaultCalls.push({ vault, key, value });
      return Promise.resolve();
    },
  };
  (context as any).vaultService = vaultService;

  await model.methods.generate.execute({}, context as any);

  assertEquals(vaultCalls.length, 2);
  assertEquals(
    getWrittenResources().filter((r) => r.specName === "cert").length,
    1,
  );
});

Deno.test("generate — rejects when runtime vaultService.put is unavailable", async () => {
  const { context } = createModelTestContext({
    globalArgs: defaultGlobalArgs(),
  });

  await assertRejects(
    () => model.methods.generate.execute({}, context as any),
    Error,
    "context.vaultService.put",
  );
});

// ─── generate — fqdn validation ───────────────────────────────────────────────

Deno.test("fqdn-valid check — rejects empty fqdn", async () => {
  const { context } = createModelTestContext({
    globalArgs: {
      fqdn: "",
      ipSans: [],
      vaultName: "local",
      certVaultKey: "CERT",
      keyVaultKey: "KEY",
      days: 365,
    },
  });

  const checkResult = await model.checks["fqdn-valid"].execute(context as any);
  assertEquals(checkResult.pass, false);
  assertEquals((checkResult.errors ?? []).length > 0, true);
});

Deno.test("fqdn-valid check — passes with valid fqdn", async () => {
  const { context } = createModelTestContext({
    globalArgs: defaultGlobalArgs(),
  });

  const checkResult = await model.checks["fqdn-valid"].execute(context as any);
  assertEquals(checkResult.pass, true);
});

// ─── generate — ipSans handling ───────────────────────────────────────────────

Deno.test("generate — works with IPv4 SANs", async () => {
  const calls: Array<{ vault: string; key: string; value: string }> = [];
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: defaultGlobalArgs({ ipSans: ["192.0.2.10", "198.51.100.20"] }),
  });

  await model.methods.generate.execute(
    { _vaultPut: makeVaultPut(calls) },
    context as any,
  );

  assertEquals(
    getWrittenResources().filter((r) => r.specName === "cert").length,
    1,
  );
  assertEquals(calls.length, 2);
});

Deno.test("generate — non-IP strings in ipSans treated as DNS SANs (no throw)", async () => {
  const calls: Array<{ vault: string; key: string; value: string }> = [];
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: defaultGlobalArgs({ ipSans: ["notanip", "also-not-ip"] }),
  });

  await model.methods.generate.execute(
    { _vaultPut: makeVaultPut(calls) },
    context as any,
  );

  assertEquals(calls.length, 2);
  assertEquals(
    getWrittenResources().filter((r) => r.specName === "cert").length,
    1,
  );
});

// ─── generate — cert DER starts with SEQUENCE tag ─────────────────────────────

Deno.test("generate — cert PEM body decodes to DER SEQUENCE (0x30)", async () => {
  const calls: Array<{ vault: string; key: string; value: string }> = [];
  const { context } = createModelTestContext({
    globalArgs: defaultGlobalArgs(),
  });

  await model.methods.generate.execute(
    { _vaultPut: makeVaultPut(calls) },
    context as any,
  );

  const certPut = calls.find((c) => c.key === "CERT")!;
  const body = certPut.value.replace(
    /-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\n/g,
    "",
  );
  const decoded = atob(body);
  assertEquals(decoded.charCodeAt(0), 0x30); // DER SEQUENCE
});
