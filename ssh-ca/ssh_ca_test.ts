import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { addDuration, model, serialFor } from "./ssh_ca.ts";

type Stored = Map<string, Record<string, unknown>>;

function testContext(stored: Stored = new Map()) {
  const writes: Array<
    { specName: string; name: string; data: Record<string, unknown> }
  > = [];
  const secrets = new Map<string, string>();
  return {
    writes,
    secrets,
    context: {
      globalArgs: {
        caName: "test-ca",
        vaultName: "test-vault",
        keyAlgorithm: "ed25519",
        defaultValidity: "30d",
        serialStrategy: "monotonic",
        metadataLabels: { test: "true" },
        sshKeygenBinary: "ssh-keygen",
      },
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
      putSecret: async (vaultName: string, key: string, value: string) => {
        secrets.set(`${vaultName}/${key}`, value);
      },
      readSecret: async (vaultName: string, key: string) => {
        const value = secrets.get(`${vaultName}/${key}`);
        if (value === undefined) {
          throw new Error(`missing secret ${vaultName}/${key}`);
        }
        return value;
      },
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

Deno.test("model declares upgrade to current version", () => {
  assertEquals(model.upgrades.at(-1)?.toVersion, model.version);
});

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

Deno.test("generate-keypair stores private key and passphrase in vault", async () => {
  const { context, writes, secrets } = testContext();
  await runMethod("generate-keypair", { force: false }, context);
  const ca = writes.find((w) => w.specName === "ca" && w.name === "ca-current");
  assert(ca);
  assertStringIncludes(String(ca.data.publicKey), "ssh-ed25519");
  assertStringIncludes(
    String(ca.data.privateKeyVaultRef),
    "vault.get('test-vault'",
  );
  assert(secrets.has("test-vault/ssh-ca-test-ca-privateKey"));
  assert(secrets.has("test-vault/ssh-ca-test-ca-passphrase"));
});

Deno.test("issue-host-certificate signs with -h and stores certificate data", async () => {
  const { context, writes } = testContext();
  await runMethod("generate-keypair", { force: false }, context);
  const publicKey = await generateSubjectPublicKey();
  await runMethod("issue-host-certificate", {
    publicKey,
    principals: ["gerrit.local"],
    keyId: "gerrit-host",
    serial: 42,
  }, context);
  const cert = writes.find((w) => w.specName === "certificate");
  assert(cert);
  assertEquals(cert.data.certificateType, "host");
  assertEquals(cert.data.serial, 42);
  assertStringIncludes(String(cert.data.certificate), "-cert-v01@openssh.com");
});

Deno.test("issue-user-certificate can store certificate in vault only", async () => {
  const { context, writes, secrets } = testContext();
  await runMethod("generate-keypair", { force: false }, context);
  const publicKey = await generateSubjectPublicKey();
  await runMethod("issue-user-certificate", {
    publicKey,
    principals: ["alice"],
    keyId: "alice-login",
    serial: 7,
    outputTarget: "vault",
  }, context);
  const cert = writes.find((w) => w.specName === "certificate");
  assert(cert);
  assertEquals(cert.data.certificate, undefined);
  assertStringIncludes(
    String(cert.data.certificateVaultRef),
    "vault.get('test-vault'",
  );
  assert(secrets.has("test-vault/ssh-ca-test-ca-cert-alice-login"));
});

Deno.test("generate-cert-authority emits a single @cert-authority line", async () => {
  const { context, writes } = testContext();
  await runMethod("generate-keypair", { force: false }, context);
  await runMethod(
    "generate-cert-authority",
    { hostPattern: "*.local" },
    context,
  );
  const caLine = writes.find((w) => w.specName === "certificateauthority");
  assert(caLine);
  assertStringIncludes(
    String(caLine.data.certAuthorityLine),
    "@cert-authority *.local ssh-ed25519",
  );
});

Deno.test("generate-trustedusercakeys emits CA public key material", async () => {
  const { context, writes } = testContext();
  await runMethod("generate-keypair", { force: false }, context);
  await runMethod("generate-trustedusercakeys", {}, context);
  const trusted = writes.find((w) => w.specName === "trustedusercakeys");
  assert(trusted);
  assertStringIncludes(String(trusted.data.trustedUserCAKeys), "ssh-ed25519");
});

Deno.test("generate-revocation-list supports serial and key ID entries", async () => {
  const { context, writes } = testContext();
  await runMethod("generate-keypair", { force: false }, context);
  await runMethod("generate-revocation-list", {
    entries: [{ serial: 7 }, { keyId: "alice-login" }],
  }, context);
  const krl = writes.find((w) => w.specName === "keyrevocationlist");
  assert(krl);
  assertEquals(krl.data.krlFormat, "openssh-krl");
  assert(String(krl.data.krlBase64).length > 0);
});
