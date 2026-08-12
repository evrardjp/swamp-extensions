import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { withMockedCommand } from "jsr:@systeminit/swamp-testing@0.20260518.13";
import { model } from "./caddy.ts";

type WriteCall = {
  specName: string;
  name: string;
  data: Record<string, unknown>;
};

function context(
  globalArgs: Record<string, unknown> = {},
  stored = new Map<string, Record<string, unknown>>(),
) {
  const writes: WriteCall[] = [];
  return {
    writes,
    context: {
      globalArgs,
      writeResource: async (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ specName, name, data });
        stored.set(name, data);
        return { specName, name, version: 1 };
      },
      readResource: async (name: string) => stored.get(name) ?? null,
    },
  };
}

function reverseProxySite(
  overrides: Record<string, unknown> = {},
) {
  return {
    address: "example.test",
    tls: "internal" as const,
    reverseProxy: {
      upstreams: ["http://127.0.0.1:8080"],
      transport: { tlsInsecureSkipVerify: false },
    },
    ...overrides,
  };
}

function decodeRemoteWrite(command: string): string {
  const encoded = command.match(/\n([A-Za-z0-9+/=]+)\nEOF$/)?.[1];
  assert(encoded);
  return new TextDecoder().decode(
    Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)),
  );
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

Deno.test("caddy exposes render, validation, and apply methods", () => {
  assertEquals(model.type, "@evrardjp/caddy");
  assertEquals(Object.keys(model.resources), ["config"]);
  for (
    const method of [
      "renderReverseProxy",
      "validateConfig",
      "applyConfig",
      "applyReverseProxy",
    ]
  ) {
    assert(method in model.methods);
  }
});

Deno.test("rendered configs use deterministic content-addressed names", async () => {
  const testContext = context();
  const args = model.methods.renderReverseProxy.arguments.parse({
    sites: [reverseProxySite()],
  });
  const changedArgs = model.methods.renderReverseProxy.arguments.parse({
    sites: [reverseProxySite({ address: "changed.example.test" })],
  });

  await model.methods.renderReverseProxy.execute(args, testContext.context);
  await model.methods.renderReverseProxy.execute(args, testContext.context);
  await model.methods.renderReverseProxy.execute(
    changedArgs,
    testContext.context,
  );

  assert(new RegExp("^[0-9a-f]{64}$").test(testContext.writes[0].name));
  assertEquals(testContext.writes[0].name, testContext.writes[1].name);
  assert(testContext.writes[0].name !== testContext.writes[2].name);
  assertEquals(
    testContext.writes.map(({ specName }) => specName),
    ["config", "config", "config"],
  );
  assert(testContext.writes.every(({ data }) => !("timestamp" in data)));
});

Deno.test("validate reads a config artifact without writing receipts", async () => {
  const configJson = JSON.stringify({
    apps: { http: { servers: { srv0: { listen: [":8080"] } } } },
  });
  const configName = await sha256(configJson);
  const stored = new Map([[configName, { configJson }]]);
  const testContext = context({}, stored);

  const validateResult = await withMockedCommand(
    () => ({ stdout: "valid", code: 0 }),
    () =>
      model.methods.validateConfig.execute(
        { configName },
        testContext.context,
      ),
  );

  assertEquals(validateResult.result, { dataHandles: [] });
  assertEquals(testContext.writes, []);
});

Deno.test("missing config artifacts fail before commands run", async () => {
  const testContext = context({ nodeHost: "node.test" });
  const { calls } = await withMockedCommand(
    () => ({ stdout: "", code: 0 }),
    () =>
      assertRejects(
        () =>
          model.methods.applyConfig.execute(
            { configName: "0".repeat(64) },
            testContext.context,
          ),
        Error,
        `Config artifact '${"0".repeat(64)}' not found`,
      ),
  );

  assertEquals(calls, []);
});

Deno.test("malformed config artifacts fail before commands run", async () => {
  const configName = await sha256("malformed");
  const testContext = context(
    { nodeHost: "node.test" },
    new Map([[configName, { configJson: 42 }]]),
  );
  const { calls } = await withMockedCommand(
    () => ({ stdout: "", code: 0 }),
    () =>
      assertRejects(
        () =>
          model.methods.applyConfig.execute(
            { configName },
            testContext.context,
          ),
        Error,
        `Config artifact '${configName}' is malformed`,
      ),
  );

  assertEquals(calls, []);
});

Deno.test("config artifact lineage rejects non-canonical names before commands", async () => {
  const configJson = "{}";
  for (const configName of ["current", "A".repeat(64)]) {
    const testContext = context(
      { nodeHost: "node.test" },
      new Map([[configName, { configJson }]]),
    );
    const { calls } = await withMockedCommand(
      () => ({ stdout: "", code: 0 }),
      () =>
        assertRejects(
          () =>
            model.methods.applyConfig.execute(
              { configName },
              testContext.context,
            ),
          Error,
          `Config artifact name '${configName}' is invalid`,
        ),
    );

    assertEquals(calls, []);
  }
});

Deno.test("config artifact lineage rejects digest mismatches before commands", async () => {
  const configJson = "{}";
  const configName = await sha256('{"different":true}');
  const testContext = context(
    { nodeHost: "node.test" },
    new Map([[configName, { configJson }]]),
  );
  const { calls } = await withMockedCommand(
    () => ({ stdout: "", code: 0 }),
    () =>
      assertRejects(
        () =>
          model.methods.applyConfig.execute(
            { configName },
            testContext.context,
          ),
        Error,
        `Config artifact '${configName}' content does not match its name`,
      ),
  );

  assertEquals(calls, []);
});

Deno.test("config artifact malformed JSON uses validation error before commands", async () => {
  const configJson = "{";
  const configName = await sha256(configJson);
  const testContext = context(
    { nodeHost: "node.test" },
    new Map([[configName, { configJson }]]),
  );
  const { calls } = await withMockedCommand(
    () => ({ stdout: "", code: 0 }),
    () =>
      assertRejects(
        () =>
          model.methods.applyConfig.execute(
            { configName },
            testContext.context,
          ),
        Error,
        "Invalid Caddy JSON config: Invalid JSON:",
      ),
  );

  assertEquals(calls, []);
});

Deno.test("caddy requires explicit upstream TLS verification behavior", () => {
  const parsed = model.methods.renderReverseProxy.arguments.parse({
    sites: [{
      address: "example.test",
      reverseProxy: {
        upstreams: ["https://127.0.0.1:8200"],
        transport: { tlsInsecureSkipVerify: false },
      },
    }],
  });
  assertEquals(parsed.sites[0].tls, "internal");
});

Deno.test("tls off renders a scheme-less site as HTTP only", async () => {
  const testContext = context();
  const args = model.methods.renderReverseProxy.arguments.parse({
    sites: [reverseProxySite({ tls: "off" })],
  });

  await model.methods.renderReverseProxy.execute(args, testContext.context);

  const config = testContext.writes[0].data.config as {
    apps: {
      http: { servers: { srv0: { listen: string[] } } };
      tls?: unknown;
    };
  };
  assertEquals(config.apps.http.servers.srv0.listen, [":80"]);
  assertEquals(config.apps.tls, undefined);
});

Deno.test("tls off rejects an explicit HTTPS site address", async () => {
  const testContext = context();
  const args = model.methods.renderReverseProxy.arguments.parse({
    sites: [
      reverseProxySite({ address: "https://example.test", tls: "off" }),
    ],
  });

  await assertRejects(
    () => model.methods.renderReverseProxy.execute(args, testContext.context),
    Error,
    "TLS is off but site address is HTTPS",
  );
});

Deno.test("apply quotes an expanded home workDir and writes UTF-8 safely", async () => {
  const workDir = "~/caddy dir/it's; touch /tmp/injected";
  const configJson = JSON.stringify({
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [":8080"],
            routes: [{
              handle: [{ handler: "static_response", body: "héllo 世界" }],
            }],
          },
        },
      },
    },
  });
  const configName = await sha256(configJson);
  const testContext = context(
    { nodeHost: "node.test", workDir },
    new Map([[configName, { configJson }]]),
  );

  const { calls, result } = await withMockedCommand(
    (command) => ({ stdout: command === "ssh" ? "" : "valid", code: 0 }),
    () =>
      model.methods.applyConfig.execute(
        { configName },
        testContext.context,
      ),
  );

  const sshCommands = calls.filter((call) => call.command === "ssh").map(
    (call) => call.args.at(-1)!,
  );
  const quotedWorkDir = `"$HOME"'/caddy dir/it'\\''s; touch /tmp/injected'`;
  assertEquals(sshCommands[0], `mkdir -p -- ${quotedWorkDir}`);
  assert(
    sshCommands.every((command) => !command.includes("docker rm")),
  );
  assertStringIncludes(
    sshCommands.find((command) => command.includes("docker compose"))!,
    `cd -- ${quotedWorkDir} && docker compose up -d`,
  );
  assert(sshCommands.every((command) => !command.includes("bootstrap.json")));

  const configWrite = sshCommands.find((command) =>
    command.includes("/caddy.json'")
  )!;
  assertStringIncludes(decodeRemoteWrite(configWrite), "héllo 世界");

  const composeWrite = sshCommands.find((command) =>
    command.includes("/docker-compose.yml'")
  )!;
  const compose = decodeRemoteWrite(composeWrite);
  assertStringIncludes(
    compose,
    'command: ["caddy", "run", "--config", "/etc/caddy/caddy.json"]',
  );
  assertStringIncludes(
    compose,
    "- ./caddy.json:/etc/caddy/caddy.json:ro",
  );
  assert(sshCommands.indexOf(configWrite) < sshCommands.indexOf(composeWrite));
  const composeUp = sshCommands.findIndex((command) =>
    command.includes("docker compose up -d")
  );
  const liveReload = sshCommands.findIndex((command) =>
    command.includes("http://127.0.0.1:2019/load")
  );
  assert(composeUp > sshCommands.indexOf(composeWrite));
  assert(liveReload > composeUp);

  assertEquals(result, { dataHandles: [] });
  assertEquals(testContext.writes, []);
});

Deno.test("compose failure does not remove the running proxy", async () => {
  const configJson = JSON.stringify({
    apps: { http: { servers: { srv0: { listen: [":8080"] } } } },
  });
  const configName = await sha256(configJson);
  const testContext = context(
    { nodeHost: "node.test" },
    new Map([[configName, { configJson }]]),
  );
  const commands: string[] = [];

  await assertRejects(
    () =>
      withMockedCommand(
        (command, args) => {
          const remoteCommand = args.at(-1) ?? "";
          if (command === "ssh") commands.push(remoteCommand);
          if (remoteCommand.includes("docker compose up -d")) {
            return { stdout: "", stderr: "compose failed", code: 1 };
          }
          return { stdout: "", stderr: "", code: 0 };
        },
        () =>
          model.methods.applyConfig.execute(
            { configName },
            testContext.context,
          ),
      ),
    Error,
    "compose failed",
  );

  assertEquals(commands[0], `mkdir -p -- "$HOME"'/caddy'`);
  assertEquals(
    commands.filter((command) => command.includes("docker compose up -d"))
      .length,
    1,
  );
  assert(commands.every((command) => !command.includes("docker rm")));
  assert(commands.every((command) => !command.includes("/load")));
});

Deno.test("apply reverse proxy returns only its rendered config handle", async () => {
  const testContext = context({ nodeHost: "node.test" });

  const { result } = await withMockedCommand(
    () => ({ stdout: "valid", code: 0 }),
    () =>
      model.methods.applyReverseProxy.execute(
        { sites: [reverseProxySite()] },
        testContext.context,
      ),
  );

  const names = (result.dataHandles as Array<{ name: string }>).map((handle) =>
    handle.name
  );
  assertEquals(names.length, 1);
  assertEquals(names[0], testContext.writes[0].name);
  assertEquals(new Set(names).size, names.length);
  assertEquals(
    testContext.writes.map(({ specName }) => specName),
    ["config"],
  );
});
