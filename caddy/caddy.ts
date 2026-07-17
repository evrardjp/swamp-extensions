import { z } from "npm:zod@4";

// Deno globals are available in Swamp extension runtime.
// @ts-ignore: Deno global available at bundle runtime
const DenoCommand = Deno.Command;

const GlobalArgs = z.object({
  nodeHost: z.string().optional().describe(
    "SSH hostname or IP of the node running Caddy; required for apply methods",
  ),
  nodeUser: z.string().default("admin").describe("SSH user for the node"),
  nodePort: z.number().int().positive().default(22).describe("SSH port"),
  nodeIdentityFile: z.string().default("~/.ssh/id_ed25519").describe(
    "SSH private key path",
  ),
  workDir: z.string().default("~/caddy").describe(
    "Remote directory containing Caddy config and compose file",
  ),
  containerImage: z.string().default("caddy:2-alpine").describe(
    "Caddy container image used for validation/apply",
  ),
});

const TransportSchema = z.object({
  tlsInsecureSkipVerify: z.boolean().describe(
    "Required explicit choice for upstream TLS verification",
  ),
});

const ReverseProxySchema = z.object({
  upstreams: z.array(z.string().min(1)).min(1).describe(
    "Upstream URLs, e.g. http://127.0.0.1:3000 or https://127.0.0.1:8200",
  ),
  transport: TransportSchema,
});

const SiteSchema = z.object({
  address: z.string().min(1).describe(
    "Public site address, e.g. example.com or https://example.com:8443",
  ),
  tls: z.enum(["internal", "off", "default"]).default("internal"),
  reverseProxy: ReverseProxySchema,
});

const RenderReverseProxyArgs = z.object({
  sites: z.array(SiteSchema).default([]),
});
const ValidateConfigArgs = z.object({ configJson: z.string().min(1) });
const ApplyConfigArgs = ValidateConfigArgs;
const ApplyReverseProxyArgs = RenderReverseProxyArgs;

const ConfigOutput = z.object({
  config: z.record(z.string(), z.unknown()),
  configJson: z.string(),
  sites: z.array(SiteSchema),
  warnings: z.array(z.string()),
  timestamp: z.string(),
});

const ValidationOutput = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  timestamp: z.string(),
});

const ApplyOutput = z.object({
  success: z.boolean(),
  configPath: z.string(),
  composePath: z.string(),
  publishedPorts: z.array(z.number()),
  timestamp: z.string(),
});

type Global = z.infer<typeof GlobalArgs>;
type Site = z.infer<typeof SiteSchema>;
type CmdResult = { stdout: string; stderr: string; code: number };
type MethodContext = {
  globalArgs: unknown;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
};

async function runCmd(
  binary: string,
  args: string[],
  input?: string,
): Promise<CmdResult> {
  try {
    const proc = new DenoCommand(binary, {
      args,
      stdin: input === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
    });
    if (input === undefined) return decode(await proc.output());
    const child = proc.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
    return decode(await child.output());
  } catch (err) {
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      code: 127,
    };
  }
}

function decode(
  out: { stdout: Uint8Array; stderr: Uint8Array; code: number },
): CmdResult {
  return {
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
    code: out.code,
  };
}

function requireNodeHost(args: Global): string {
  if (!args.nodeHost) {
    throw new Error("nodeHost global argument is required for apply methods");
  }
  return args.nodeHost;
}

function sshTarget(args: Global): string {
  return `${args.nodeUser}@${requireNodeHost(args)}`;
}

async function sshExec(args: Global, command: string): Promise<string> {
  const result = await runCmd("ssh", [
    "-i",
    args.nodeIdentityFile,
    "-p",
    String(args.nodePort),
    "-o",
    "StrictHostKeyChecking=accept-new",
    sshTarget(args),
    command,
  ]);
  if (result.code !== 0) {
    throw new Error(
      `ssh command failed (${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

async function writeRemote(
  args: Global,
  path: string,
  content: string,
): Promise<void> {
  const b64 = btoa(content);
  await sshExec(args, `base64 -d > ${shellQuote(path)} <<'EOF'\n${b64}\nEOF`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function parseSiteAddress(
  address: string,
): { host: string; port: number; scheme: "http" | "https" } {
  const withScheme = address.includes("://") ? address : `https://${address}`;
  const url = new URL(withScheme);
  return {
    host: url.hostname,
    port: Number(url.port || (url.protocol === "http:" ? 80 : 443)),
    scheme: url.protocol === "http:" ? "http" : "https",
  };
}

function parseUpstream(upstream: string): { dial: string; https: boolean } {
  const withScheme = upstream.includes("://") ? upstream : `http://${upstream}`;
  const url = new URL(withScheme);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return { dial: `${url.hostname}:${port}`, https: url.protocol === "https:" };
}

function renderCaddyJson(
  sites: Site[],
): { config: Record<string, unknown>; warnings: string[]; ports: number[] } {
  const warnings: string[] = [];
  const ports = new Set<number>();
  const routes: unknown[] = [];
  const internalTlsSubjects: string[] = [];

  for (const site of sites) {
    const publicAddr = parseSiteAddress(site.address);
    ports.add(publicAddr.port);
    if (site.tls === "internal") internalTlsSubjects.push(publicAddr.host);
    if (site.tls === "off" && publicAddr.scheme === "https") {
      warnings.push(`${site.address} is HTTPS but tls is off`);
    }

    const upstreams = site.reverseProxy.upstreams.map((u) => {
      const parsed = parseUpstream(u);
      return { dial: parsed.dial, _https: parsed.https };
    });
    const hasHttpsUpstream = upstreams.some((u) => u._https);
    const handle: Record<string, unknown> = {
      handler: "reverse_proxy",
      upstreams: upstreams.map(({ dial }) => ({ dial })),
    };
    if (hasHttpsUpstream) {
      handle.transport = {
        protocol: "http",
        tls: site.reverseProxy.transport.tlsInsecureSkipVerify
          ? { insecure_skip_verify: true }
          : {},
      };
    }

    routes.push({ match: [{ host: [publicAddr.host] }], handle: [handle] });
  }

  if (routes.length === 0) {
    ports.add(8080);
    routes.push({
      handle: [{
        handler: "static_response",
        body: "caddy has no sites configured",
      }],
    });
  }

  const listen = Array.from(ports).sort((a, b) => a - b).map((p) => `:${p}`);
  const config: Record<string, unknown> = {
    admin: { listen: "0.0.0.0:2019" },
    apps: {
      http: { servers: { srv0: { listen, routes } } },
    },
  };
  if (internalTlsSubjects.length > 0) {
    (config.apps as Record<string, unknown>).tls = {
      automation: {
        policies: [{
          subjects: internalTlsSubjects,
          issuers: [{ module: "internal" }],
        }],
      },
    };
  }
  return { config, warnings, ports: Array.from(ports).sort((a, b) => a - b) };
}

async function validateCaddyJson(
  configJson: string,
  image: string,
): Promise<{ errors: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  try {
    JSON.parse(configJson);
  } catch (err) {
    return {
      errors: [
        `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      ],
      warnings,
    };
  }

  const local = await runCmd(
    "caddy",
    ["validate", "--config", "/dev/stdin"],
    configJson,
  );
  if (local.code === 0) return { errors: [], warnings };

  const tmpDir = await Deno.makeTempDir();
  const configPath = `${tmpDir}/caddy.json`;
  try {
    await Deno.writeTextFile(configPath, configJson);
    const docker = await runCmd("docker", [
      "run",
      "--rm",
      "-v",
      `${configPath}:/etc/caddy/caddy.json:ro`,
      image,
      "caddy",
      "validate",
      "--config",
      "/etc/caddy/caddy.json",
    ]);
    if (docker.code === 0) return { errors: [], warnings };
    const localUnavailable = local.code === 127;
    const dockerUnavailable = docker.code === 127;
    if (localUnavailable && dockerUnavailable) {
      return {
        errors: [
          "Unable to run Caddy validation: neither local caddy nor docker is available",
        ],
        warnings,
      };
    }
    return {
      errors: [
        (docker.stderr || docker.stdout || local.stderr || local.stdout).trim(),
      ],
      warnings,
    };
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

function publishedPortsFromConfig(configJson: string): number[] {
  const config = JSON.parse(configJson) as {
    apps?: { http?: { servers?: Record<string, { listen?: unknown[] }> } };
  };
  const servers = config?.apps?.http?.servers ?? {};
  const ports = new Set<number>();
  for (const server of Object.values(servers)) {
    for (const listen of server.listen ?? []) {
      const match = String(listen).match(/:(\d+)$/);
      if (match) ports.add(Number(match[1]));
    }
  }
  return Array.from(ports).sort((a, b) => a - b);
}

function renderCompose(image: string, ports: number[]): string {
  const effectivePorts = ports.length === 0 ? [8080] : ports;
  const publicPortLines = effectivePorts.map((p) => `      - '${p}:${p}'\n`)
    .join("");
  return `services:\n  caddy:\n    image: ${image}\n    container_name: caddy\n    restart: unless-stopped\n    command: ["caddy", "run", "--config", "/etc/caddy/bootstrap.json"]\n    ports:\n      - '127.0.0.1:2019:2019'\n${publicPortLines}    volumes:\n      - ./bootstrap.json:/etc/caddy/bootstrap.json:ro\n      - caddy_data:/data\n      - caddy_config:/config\nvolumes:\n  caddy_data:\n  caddy_config:\n`;
}

function ensureAdminApi(configJson: string): string {
  const config = JSON.parse(configJson) as Record<string, unknown>;
  config.admin = {
    ...((config.admin as Record<string, unknown> | undefined) ?? {}),
    listen: "0.0.0.0:2019",
  };
  return JSON.stringify(config, null, 2);
}

function bootstrapConfigJson(): string {
  return JSON.stringify(
    {
      admin: { listen: "0.0.0.0:2019" },
      apps: {
        http: {
          servers: {
            bootstrap: {
              listen: [":8080"],
              routes: [{
                handle: [{
                  handler: "static_response",
                  body: "caddy admin api ready",
                }],
              }],
            },
          },
        },
      },
    },
    null,
    2,
  );
}

async function writeConfigResource(
  context: MethodContext,
  sites: Site[],
  config: Record<string, unknown>,
  configJson: string,
  warnings: string[],
) {
  return await context.writeResource("config", "current", {
    config,
    configJson,
    sites,
    warnings,
    timestamp: new Date().toISOString(),
  });
}

async function validateAndWrite(context: MethodContext, configJson: string) {
  const globalArgs = GlobalArgs.parse(context.globalArgs);
  const result = await validateCaddyJson(configJson, globalArgs.containerImage);
  const handle = await context.writeResource("validation", "current", {
    valid: result.errors.length === 0,
    errors: result.errors,
    warnings: result.warnings,
    timestamp: new Date().toISOString(),
  });
  if (result.errors.length > 0) {
    throw new Error(`Invalid Caddy JSON config: ${result.errors.join("; ")}`);
  }
  return handle;
}

async function applyConfig(configJson: string, context: MethodContext) {
  const globalArgs = GlobalArgs.parse(context.globalArgs);
  const loadConfigJson = ensureAdminApi(configJson);
  const validationHandle = await validateAndWrite(context, loadConfigJson);
  await sshExec(globalArgs, `mkdir -p ${globalArgs.workDir}`);
  const bootstrapPath = `${globalArgs.workDir}/bootstrap.json`;
  const configPath = `${globalArgs.workDir}/caddy.json`;
  const composePath = `${globalArgs.workDir}/docker-compose.yml`;
  const ports = publishedPortsFromConfig(loadConfigJson);
  await writeRemote(globalArgs, bootstrapPath, bootstrapConfigJson());
  await writeRemote(globalArgs, configPath, loadConfigJson);
  await writeRemote(
    globalArgs,
    composePath,
    renderCompose(globalArgs.containerImage, ports),
  );
  await sshExec(
    globalArgs,
    `cd ${globalArgs.workDir} && (docker compose up -d || { docker rm -f caddy 2>/dev/null; docker compose up -d; })`,
  );
  await sshExec(
    globalArgs,
    `cd ${globalArgs.workDir} && curl -fsS -X POST -H 'Content-Type: application/json' --data-binary @caddy.json http://127.0.0.1:2019/load`,
  );
  const applyHandle = await context.writeResource("apply", "current", {
    success: true,
    configPath,
    composePath,
    publishedPorts: ports,
    timestamp: new Date().toISOString(),
  });
  return { dataHandles: [validationHandle, applyHandle] };
}

/** Caddy model: render, validate, and run Caddy JSON configuration. */
export const model = {
  type: "@evrardjp/caddy",
  version: "2026.07.17.1",
  globalArguments: GlobalArgs,
  resources: {
    config: {
      description: "Rendered Caddy JSON config artifact",
      schema: ConfigOutput,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    validation: {
      description: "Caddy JSON validation result",
      schema: ValidationOutput,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    apply: {
      description: "Applied Caddy runtime state",
      schema: ApplyOutput,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    renderReverseProxy: {
      description:
        "Render Caddy JSON config for HTTPS/HTTP reverse proxy sites",
      arguments: RenderReverseProxyArgs,
      execute: async (
        args: z.infer<typeof RenderReverseProxyArgs>,
        context: MethodContext,
      ) => {
        const { config, warnings } = renderCaddyJson(args.sites);
        const handle = await writeConfigResource(
          context,
          args.sites,
          config,
          JSON.stringify(config, null, 2),
          warnings,
        );
        return { dataHandles: [handle] };
      },
    },
    validateConfig: {
      description:
        "Validate Caddy JSON config before shipping it to a host using Caddy's own parser",
      arguments: ValidateConfigArgs,
      execute: async (
        args: z.infer<typeof ValidateConfigArgs>,
        context: MethodContext,
      ) => ({
        dataHandles: [await validateAndWrite(context, args.configJson)],
      }),
    },
    applyConfig: {
      description:
        "Validate and apply a provided Caddy JSON config on the target host",
      arguments: ApplyConfigArgs,
      execute: async (
        args: z.infer<typeof ApplyConfigArgs>,
        context: MethodContext,
      ) => await applyConfig(args.configJson, context),
    },
    applyReverseProxy: {
      description:
        "Render, validate, and apply reverse proxy sites on the target host",
      arguments: ApplyReverseProxyArgs,
      execute: async (
        args: z.infer<typeof ApplyReverseProxyArgs>,
        context: MethodContext,
      ) => {
        const { config, warnings } = renderCaddyJson(args.sites);
        const configJson = JSON.stringify(config, null, 2);
        const configHandle = await writeConfigResource(
          context,
          args.sites,
          config,
          configJson,
          warnings,
        );
        const result = await applyConfig(configJson, context);
        return { dataHandles: [configHandle, ...result.dataHandles] };
      },
    },
  },
};
