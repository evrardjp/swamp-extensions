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
  data: Record<string, unknown>;
};

function context(globalArgs: Record<string, unknown> = {}) {
  const writes: WriteCall[] = [];
  return {
    writes,
    context: {
      globalArgs,
      writeResource: async (
        specName: string,
        _name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ specName, data });
        return { specName, version: 1 };
      },
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

Deno.test("caddy exposes render, validation, and apply methods", () => {
  assertEquals(model.type, "@evrardjp/caddy");
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
  const testContext = context({ nodeHost: "node.test", workDir });
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

  const { calls } = await withMockedCommand(
    (command) => ({ stdout: command === "ssh" ? "" : "valid", code: 0 }),
    () =>
      model.methods.applyConfig.execute(
        { configJson },
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

  assertEquals(testContext.writes.map((write) => write.specName), [
    "validation",
    "apply",
  ]);
  assertEquals(testContext.writes[1].data.success, true);
  assertEquals(testContext.writes[1].data.configPath, `${workDir}/caddy.json`);
  assertEquals(testContext.writes[1].data.publishedPorts, [8080]);
});

Deno.test("compose failure does not remove the running proxy", async () => {
  const testContext = context({ nodeHost: "node.test" });
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
            {
              configJson: JSON.stringify({
                apps: { http: { servers: { srv0: { listen: [":8080"] } } } },
              }),
            },
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
