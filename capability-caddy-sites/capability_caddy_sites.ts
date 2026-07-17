import { z } from "npm:zod@4";

// Deno globals are available in Swamp extension runtime.
// @ts-ignore: Deno global available at bundle runtime
const DenoCommand = Deno.Command;

const GlobalArgs = z.object({});

const PublicExposeSchema = z.object({
  fqdn: z.string(),
  listen: z.string().default("TCP:0.0.0.0:443"),
  scheme: z.enum(["http", "https"]).default("https"),
  tls: z.enum(["internal", "off", "default"]).default("internal"),
});

const ExposeSchema = z.object({
  name: z.string(),
  listen: z.string(),
  upstreamScheme: z.enum(["http", "https"]).default("http"),
  tlsInsecureSkipVerify: z.boolean(),
  public: PublicExposeSchema,
});

const RenderArgs = z.object({
  catalogModelName: z.string().default("lab-capability-catalog"),
  capabilities: z.array(z.string()).default([]),
  vm: z.record(z.string(), z.unknown()).default({}),
});

const SiteSchema = z.object({
  address: z.string(),
  tls: z.enum(["internal", "off", "default"]).default("internal"),
  reverseProxy: z.object({
    upstreams: z.array(z.string()),
    transport: z.object({
      tlsInsecureSkipVerify: z.boolean(),
    }),
  }),
});

const SitesOutput = z.object({
  sites: z.array(SiteSchema),
  capabilities: z.array(z.string()),
  timestamp: z.string(),
});

type CmdResult = { stdout: string; stderr: string; code: number };

type Expose = z.infer<typeof ExposeSchema>;

type MethodContext = {
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
};

async function runCmd(binary: string, args: string[]): Promise<CmdResult> {
  const proc = new DenoCommand(binary, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await proc.output();
  return {
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
    code: out.code,
  };
}

function expandPlaceholders(
  value: unknown,
  vm: Record<string, unknown>,
): unknown {
  if (typeof value === "string") {
    return value.replaceAll(
      /@\{vm\.([A-Za-z0-9_]+)\}/g,
      (_match, key) => String(vm[key] ?? ""),
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandPlaceholders(item, vm));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map((
        [key, item],
      ) => [key, expandPlaceholders(item, vm)]),
    );
  }
  return value;
}

function parseEndpoint(
  endpoint: string,
): { protocol: string; host: string; port: number } {
  const match = endpoint.match(/^([A-Za-z][A-Za-z0-9+.-]*):(.+):(\d+)$/);
  if (!match) {
    throw new Error(`Invalid endpoint ${endpoint}; expected PROTO:HOST:PORT`);
  }
  return {
    protocol: match[1].toUpperCase(),
    host: match[2],
    port: Number(match[3]),
  };
}

function siteAddress(expose: Expose): string {
  const pub = parseEndpoint(expose.public.listen);
  if (expose.public.scheme === "http") {
    return pub.port === 80
      ? `http://${expose.public.fqdn}`
      : `http://${expose.public.fqdn}:${pub.port}`;
  }
  return pub.port === 443
    ? expose.public.fqdn
    : `${expose.public.fqdn}:${pub.port}`;
}

function upstream(expose: Expose): string {
  const backend = parseEndpoint(expose.listen);
  if (backend.protocol !== "TCP") {
    throw new Error(
      `Caddy reverse_proxy requires TCP HTTP(S) upstreams; got ${expose.listen}`,
    );
  }
  return `${expose.upstreamScheme}://${backend.host}:${backend.port}`;
}

async function readCapability(
  catalogModelName: string,
  capability: string,
): Promise<Record<string, unknown> | null> {
  const result = await runCmd("swamp", [
    "data",
    "get",
    catalogModelName,
    capability,
    "--json",
  ]);
  if (result.code !== 0) return null;
  const parsed = JSON.parse(result.stdout);
  return parsed?.content ?? null;
}

/** Catalog-domain adapter: convert capability exposes metadata into generic @evrardjp/caddy sites. */
export const model = {
  type: "@evrardjp/capability-caddy-sites",
  version: "2026.07.17.1",
  globalArguments: GlobalArgs,
  resources: {
    sites: {
      description:
        "Generic @evrardjp/caddy reverse proxy site definitions derived from capability exposes",
      schema: SitesOutput,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    render: {
      description:
        "Render generic Caddy site definitions from capability catalog exposes metadata",
      arguments: RenderArgs,
      execute: async (
        args: z.infer<typeof RenderArgs>,
        context: MethodContext,
      ) => {
        const sites: z.infer<typeof SiteSchema>[] = [];
        for (const capability of args.capabilities) {
          const data = await readCapability(args.catalogModelName, capability);
          const exposes = Array.isArray(data?.exposes) ? data.exposes : [];
          for (const raw of exposes) {
            const expose = ExposeSchema.parse(expandPlaceholders(raw, args.vm));
            sites.push({
              address: siteAddress(expose),
              tls: expose.public.tls,
              reverseProxy: {
                upstreams: [upstream(expose)],
                transport: {
                  tlsInsecureSkipVerify: expose.tlsInsecureSkipVerify,
                },
              },
            });
          }
        }
        const handle = await context.writeResource("sites", "current", {
          sites,
          capabilities: args.capabilities,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
