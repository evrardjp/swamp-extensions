import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { addDuration, model, serialFor } from "./ssh_ca.ts";

type Stored = Map<string, Record<string, unknown>>;

type TestGlobalArgs = {
  caName: string;
  vaultName: string;
  hostSubCas: Array<{ name: string; usage: "host" }>;
  userSubCas: Array<{ name: string; usage: "user" }>;
  keyAlgorithm: "ed25519";
  defaultHostValidity: string;
  defaultUserValidity: string;
  rootValidity: string;
  hostSubCaValidity: string;
  userSubCaValidity: string;
  allowedPrincipals: string[];
  serialStrategy: "monotonic";
  metadataLabels: Record<string, string>;
  sshKeygenBinary: string;
};

function testContext(stored: Stored = new Map()) {
  const writes: Array<
    { specName: string; name: string; data: Record<string, unknown> }
  > = [];
  return {
    writes,
    context: {
      globalArgs: {
        caName: "test-ca",
        vaultName: "test-vault",
        hostSubCas: [{ name: "host-ca", usage: "host" }],
        userSubCas: [{ name: "user-ca", usage: "user" }],
        keyAlgorithm: "ed25519",
        defaultHostValidity: "30d",
        defaultUserValidity: "24h",
        rootValidity: "1y",
        hostSubCaValidity: "90d",
        userSubCaValidity: "30d",
        allowedPrincipals: [],
        serialStrategy: "monotonic",
        metadataLabels: { test: "true" },
        sshKeygenBinary: "ssh-keygen",
      } as TestGlobalArgs,
      logger: { info: () => {} },
      writeResource: async (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ specName, name, data });
        stored.set(name, data);
        return { name };
      },
      readResource: async (name: string) => stored.get(name) ?? null,
    },
  };
}

async function runMethod(
  name: string,
  args: Record<string, unknown>,
  ctx: unknown,
) {
  const method = (model.methods as Record<
    string,
    { execute: (args: unknown, ctx: unknown) => Promise<unknown> }
  >)[name];
  return await method.execute(args, ctx);
}

async function generateSubjectPublicKey(): Promise<string> {
  const dir = await Deno.makeTempDir();
  try {
    const result = await new Deno.Command("ssh-keygen", {
      args: [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "subject",
        "-f",
        `${dir}/subject`,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    return (await Deno.readTextFile(`${dir}/subject.pub`)).trim();
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("duration parsing handles operational validity units", () => {
  const start = new Date("2026-01-01T00:00:00.000Z");
  assertEquals(
    addDuration(start, "30m").toISOString(),
    "2026-01-01T00:30:00.000Z",
  );
  assertEquals(
    addDuration(start, "24h").toISOString(),
    "2026-01-02T00:00:00.000Z",
  );
  assertEquals(
    addDuration(start, "7d").toISOString(),
    "2026-01-08T00:00:00.000Z",
  );
});

Deno.test("monotonic serials are stable for the same seed", () => {
  assertEquals(
    serialFor("monotonic", "key-id"),
    serialFor("monotonic", "key-id"),
  );
});

Deno.test("init-root and ensure-subca create vaulted-sensitive CA metadata", async () => {
  const { context, writes } = testContext();
  await runMethod("init-root", { force: false }, context);
  await runMethod("ensure-subca", {
    name: "host-ca",
    usage: "host",
    force: false,
  }, context);

  assertEquals(writes[0].specName, "root");
  assertStringIncludes(String(writes[0].data.publicKey), "ssh-ed25519");
  assertStringIncludes(
    String(writes[0].data.privateKeyMaterial),
    "BEGIN OPENSSH PRIVATE KEY",
  );
  assertEquals(writes[1].specName, "subca");
  assertEquals(
    writes[1].data.parentRootFingerprint,
    writes[0].data.fingerprint,
  );
});

Deno.test("issue-host-cert signs a host public key and records public certificate metadata", async () => {
  const { context, writes } = testContext();
  await runMethod("init-root", { force: false }, context);
  await runMethod("ensure-subca", {
    name: "host-ca",
    usage: "host",
    force: false,
  }, context);
  const hostPublicKey = await generateSubjectPublicKey();

  await runMethod("issue-host-cert", {
    hostPublicKey,
    principals: ["gerrit.local"],
    subCaName: "host-ca",
    keyId: "host-gerrit-local",
    serial: 42,
  }, context);

  const certWrite = writes.find((w) => w.specName === "hostcert");
  assert(certWrite);
  assertStringIncludes(
    String(certWrite.data.certificate),
    "-cert-v01@openssh.com",
  );
  assertEquals(certWrite.data.serial, 42);
  assertEquals(certWrite.data.principals, ["gerrit.local"]);
});

Deno.test("render-client-trust emits known_hosts CA marker lines", async () => {
  const { context, writes } = testContext();
  await runMethod("init-root", { force: false }, context);
  await runMethod("ensure-subca", {
    name: "host-ca",
    usage: "host",
    force: false,
  }, context);
  await runMethod("render-client-trust", {
    hostPattern: "gerrit.local",
    subCaNames: ["host-ca"],
  }, context);

  const trust = writes.find((w) => w.specName === "clienttrust");
  assert(trust);
  assertStringIncludes(
    String(trust.data.knownHosts),
    "@cert-authority gerrit.local ssh-ed25519",
  );
});

Deno.test("allowed principal policy fails closed", async () => {
  const { context } = testContext();
  context.globalArgs.allowedPrincipals = ["allowed.local"];
  await runMethod("init-root", { force: false }, context);
  await runMethod("ensure-subca", {
    name: "host-ca",
    usage: "host",
    force: false,
  }, context);
  const hostPublicKey = await generateSubjectPublicKey();

  await assertRejects(
    () =>
      runMethod("issue-host-cert", {
        hostPublicKey,
        principals: ["denied.local"],
        subCaName: "host-ca",
      }, context),
    Error,
    "not allowed",
  );
});
