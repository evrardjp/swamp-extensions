import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { model } from "./openbao.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function context(routes: Record<string, (init?: RequestInit) => Response>) {
  const writes: Array<
    { specName: string; instanceName: string; data: Record<string, unknown> }
  > = [];
  const secrets = new Map<string, string>();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const logs: Array<
    { level: string; msg: string; props?: Record<string, unknown> }
  > = [];
  return {
    writes,
    secrets,
    requests,
    logs,
    ctx: {
      globalArgs: { apiAddr: "https://bao.example.test:8200" },
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
      putSecret: async (vaultName: string, key: string, value: string) => {
        secrets.set(`${vaultName}/${key}`, value);
      },
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        const path = new URL(url).pathname;
        const route = routes[path];
        if (!route) return json({ errors: [`missing route ${path}`] }, 404);
        return route(init);
      },
    },
  };
}

Deno.test("renderConfig emits deterministic OpenBao HCL", async () => {
  const h = context({});

  await model.methods.renderConfig.execute({
    ui: true,
    clusterAddr: "https://bao.example.test:8201",
    storage: { type: "raft", path: "/var/lib/openbao/data", nodeId: "bao-1" },
    listeners: [{
      type: "tcp",
      address: "0.0.0.0:8200",
      tlsDisable: false,
      tlsCertFile: "/etc/openbao/tls/openbao.crt",
      tlsKeyFile: "/etc/openbao/tls/openbao.key",
    }],
  }, h.ctx);

  const rendered = h.writes[0];
  assertEquals(rendered.specName, "renderedConfig");
  assertEquals(rendered.instanceName, "current");
  assertEquals(rendered.data.apiAddr, "https://bao.example.test:8200");
  assertEquals(rendered.data.storageBackend, "raft");
  assertEquals(rendered.data.tlsEnabled, true);
  assert(String(rendered.data.content).includes('storage "raft" {'));
  assert(String(rendered.data.content).includes('node_id = "bao-1"'));
  assert(
    String(rendered.data.content).includes(
      'api_addr     = "https://bao.example.test:8200"',
    ),
  );
  assertEquals(String(rendered.data.contentSha256).length, 64);
  assert(
    h.logs.some((entry) =>
      entry.level === "info" && entry.msg === "Rendered OpenBao configuration"
    ),
  );
});

Deno.test("renderConfig rejects scheme mismatches", async () => {
  const h = context({});

  await assertRejects(
    () =>
      model.methods.renderConfig.execute({
        ui: false,
        clusterAddr: "http://bao.example.test:8201",
        storage: {
          type: "raft",
          path: "/var/lib/openbao/data",
          nodeId: "bao-1",
        },
        listeners: [{
          type: "tcp",
          address: "0.0.0.0:8200",
          tlsDisable: false,
          tlsCertFile: "/etc/openbao/tls/openbao.crt",
          tlsKeyFile: "/etc/openbao/tls/openbao.key",
        }],
      }, h.ctx),
    Error,
    "apiAddr and clusterAddr must use the same URL scheme",
  );
});

Deno.test("status records OpenBao health without SSH", async () => {
  const h = context({
    "/v1/sys/health": () =>
      json({ initialized: true, sealed: false, version: "2.2.0" }),
  });

  await model.methods.status.execute({}, h.ctx);

  assertEquals(
    h.requests[0].url,
    "https://bao.example.test:8200/v1/sys/health?standbyok=true&sealedcode=200&uninitcode=200",
  );
  assertEquals(h.writes[0].specName, "status");
  assertEquals(h.writes[0].data.initialized, true);
  assertEquals(h.writes[0].data.sealed, false);
});

Deno.test("status retries transient OpenBao health failures", async () => {
  let attempts = 0;
  const h = context({
    "/v1/sys/health": () => {
      attempts++;
      if (attempts < 3) return json({ errors: ["busy"] }, 503);
      return json({ initialized: true, sealed: false, version: "2.2.0" });
    },
  });

  await model.methods.status.execute({}, h.ctx);

  assertEquals(attempts, 3);
  assertEquals(h.writes[0].data.httpStatus, 200);
});

Deno.test("initialize stores unseal keys and root token in vault", async () => {
  const h = context({
    "/v1/sys/init": (init?: RequestInit) => {
      if (init?.method === "PUT") {
        return json({ keys_base64: ["k1", "k2", "k3"], root_token: "root" });
      }
      return json({ initialized: false });
    },
  });

  await model.methods.initialize.execute({
    vaultName: "local",
    keyShares: 3,
    keyThreshold: 2,
  }, h.ctx);

  assertEquals(h.secrets.get("local/OPENBAO_UNSEAL_KEY_1"), "k1");
  assertEquals(h.secrets.get("local/OPENBAO_UNSEAL_KEY_3"), "k3");
  assertEquals(h.secrets.get("local/OPENBAO_ROOT_TOKEN"), "root");
  assertEquals(
    h.writes.find((w) => w.specName === "initState")?.data.keyThreshold,
    2,
  );
  assert(
    !JSON.stringify(h.logs).includes("root"),
    "logs must not include root token values",
  );
});

Deno.test("initialize throws before writing when OpenBao init fails", async () => {
  const h = context({
    "/v1/sys/init": (init?: RequestInit) => {
      if (init?.method === "PUT") {
        return json({ errors: ["invalid threshold"] }, 400);
      }
      return json({ initialized: false });
    },
  });

  await assertRejects(
    () =>
      model.methods.initialize.execute({
        vaultName: "local",
        keyShares: 3,
        keyThreshold: 2,
      }, h.ctx),
    Error,
    "OpenBao sys/init failed with HTTP 400",
  );
  assertEquals(h.writes.length, 0);
  assertEquals(h.secrets.size, 0);
});

Deno.test("initialize skips when OpenBao is already initialized", async () => {
  const h = context({
    "/v1/sys/init": () => json({ initialized: true }),
  });

  await model.methods.initialize.execute({
    vaultName: "local",
    keyShares: 5,
    keyThreshold: 3,
  }, h.ctx);

  assertEquals(h.secrets.size, 0);
  assertEquals(
    h.writes.find((w) => w.specName === "initState")?.data.skipped,
    true,
  );
});

Deno.test("unseal sends one key share and records progress", async () => {
  const h = context({
    "/v1/sys/unseal": (init?: RequestInit) => {
      assertEquals(init?.method, "PUT");
      assertEquals(JSON.parse(String(init?.body)).key, "share-1");
      return json({ progress: 1, t: 3, sealed: true });
    },
  });

  await model.methods.unseal.execute({ unsealKey: "share-1" }, h.ctx);

  assertEquals(h.writes[0].specName, "unseal");
  assertEquals(h.writes[0].data.progress, 1);
  assertEquals(h.writes[0].data.threshold, 3);
  assertEquals(h.writes[0].data.sealed, true);
});

Deno.test("seal sends token header and records seal state", async () => {
  const h = context({
    "/v1/sys/seal": (init?: RequestInit) => {
      assertEquals(init?.method, "PUT");
      assertEquals(
        (init?.headers as Record<string, string>)["x-vault-token"],
        "root-token",
      );
      return json({});
    },
  });

  await model.methods.seal.execute({ token: "root-token" }, h.ctx);

  assertEquals(h.writes[0].specName, "seal");
  assert(h.writes[0].data.sealedAt);
  assert(
    !JSON.stringify(h.logs).includes("root-token"),
    "logs must not include operator tokens",
  );
});

Deno.test("model declares upgrade to current version", () => {
  assertEquals(model.upgrades.at(-1)?.toVersion, model.version);
});
