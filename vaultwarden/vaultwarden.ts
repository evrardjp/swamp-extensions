import { z } from "npm:zod@4";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface EnvVar {
  key: string;
  defaultValue: string;
  description: string;
  section: string;
  commented: boolean;
  allowedValues: string[];
}

const GlobalArgsSchema = z.object({
  version: z.string().default("latest").describe(
    "Vaultwarden image tag and upstream template branch/tag",
  ),
  fqdn: z.string().describe(
    "Public FQDN used for DOMAIN and HTTP verification, for example vaultwarden.example.com",
  ),
  baseUrl: z.string().url().optional().describe(
    "External Vaultwarden base URL; defaults to https://<fqdn>",
  ),
});

const DiscoverArgsSchema = z.object({});

const RenderEnvArgsSchema = z.object({
  envVars: z.record(z.string(), z.string()).default({}).describe(
    "Environment variable overrides applied on top of the upstream template",
  ).meta({ sensitive: true }),
});

const VerifyArgsSchema = z.object({
  url: z.string().url().optional().describe(
    "Vaultwarden health URL; defaults to <baseUrl>/alive",
  ),
});

const EnvVarSchema = z.object({
  key: z.string(),
  defaultValue: z.string(),
  description: z.string(),
  section: z.string(),
  commented: z.boolean(),
  allowedValues: z.array(z.string()),
});

const EnvTemplateResourceSchema = z.object({
  version: z.string(),
  fetchedAt: z.string(),
  templateUrl: z.string(),
  envVars: z.array(EnvVarSchema),
});

const EnvFileResourceSchema = z.object({
  version: z.string(),
  fqdn: z.string(),
  domain: z.string(),
  renderedAt: z.string(),
  envFile: z.string().meta({ sensitive: true }),
  appliedKeys: z.array(z.string()),
});

const VerificationResourceSchema = z.object({
  url: z.string(),
  reachable: z.boolean(),
  httpStatus: z.number().optional(),
  checkedAt: z.string(),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type RenderEnvArgs = z.infer<typeof RenderEnvArgsSchema>;
type VerifyArgs = z.infer<typeof VerifyArgsSchema>;

interface Logger {
  info(msg: string, props?: Record<string, unknown>): void;
  debug(msg: string, props?: Record<string, unknown>): void;
  warning(msg: string, props?: Record<string, unknown>): void;
  error(msg: string, props?: Record<string, unknown>): void;
}

interface FileWriter {
  writeLine(line: string): Promise<void>;
  finalize(): Promise<unknown>;
}

interface MethodContext {
  globalArgs: GlobalArgs;
  logger: Logger;
  writeResource(
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ): Promise<unknown>;
  createFileWriter(
    specName: string,
    instanceName: string,
    opts?: { streaming?: boolean },
  ): FileWriter;
  fetch?: FetchLike;
}

function templateUrl(version: string): string {
  const branch = version === "latest" ? "main" : version;
  return `https://raw.githubusercontent.com/dani-garcia/vaultwarden/${branch}/.env.template`;
}

function baseUrl(args: GlobalArgs): string {
  return (args.baseUrl ?? `https://${args.fqdn}`).replace(/\/+$/, "");
}

function healthUrl(args: GlobalArgs, url?: string): string {
  return url ?? `${baseUrl(args)}/alive`;
}

function extractAllowedValues(lines: string[]): string[] {
  for (const line of lines) {
    const match = line.toLowerCase().match(
      /(?:valid values?|possible values?|allowed values?)[:\s]+(.+)/,
    );
    if (match) {
      return match[1].split(/[,|]/).map((v) => v.trim()).filter(Boolean);
    }
  }
  return [];
}

function parseEnvTemplate(content: string): Map<string, EnvVar> {
  const vars = new Map<string, EnvVar>();
  let currentSection = "";
  let descBuffer: string[] = [];

  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) {
      currentSection = line.slice(3).trim();
      descBuffer = [];
      continue;
    }
    if (line.trim() === "") {
      descBuffer = [];
      continue;
    }
    if (/^#\s*[A-Z_][A-Z0-9_]*=/.test(line)) {
      const inner = line.replace(/^#\s*/, "");
      const eqIdx = inner.indexOf("=");
      const key = inner.slice(0, eqIdx).trim();
      const defaultValue = inner.slice(eqIdx + 1).trim();
      if (!vars.has(key)) {
        vars.set(key, {
          key,
          defaultValue,
          description: descBuffer.join(" ").trim(),
          section: currentSection,
          commented: true,
          allowedValues: extractAllowedValues(descBuffer),
        });
      }
      descBuffer = [];
      continue;
    }
    if (/^[A-Z_][A-Z0-9_]*=/.test(line)) {
      const eqIdx = line.indexOf("=");
      const key = line.slice(0, eqIdx).trim();
      const defaultValue = line.slice(eqIdx + 1).trim();
      if (!vars.has(key)) {
        vars.set(key, {
          key,
          defaultValue,
          description: descBuffer.join(" ").trim(),
          section: currentSection,
          commented: false,
          allowedValues: extractAllowedValues(descBuffer),
        });
      }
      descBuffer = [];
      continue;
    }
    if (line.startsWith("#")) {
      const stripped = line.replace(/^#+\s*/, "");
      if (stripped.length > 0) descBuffer.push(stripped);
    }
  }
  return vars;
}

function quoteEnvValue(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildEnvFile(
  parsedVars: Map<string, EnvVar>,
  overrides: Record<string, string>,
  domain: string,
): string {
  const lines: string[] = [];
  const handled = new Set<string>();
  const effectiveOverrides: Record<string, string> = {
    DOMAIN: domain,
    ...overrides,
  };

  for (const variable of parsedVars.values()) {
    if (effectiveOverrides[variable.key] !== undefined) {
      lines.push(
        `${variable.key}=${quoteEnvValue(effectiveOverrides[variable.key])}`,
      );
      handled.add(variable.key);
    } else if (variable.commented) {
      lines.push(`# ${variable.key}=${variable.defaultValue}`);
    } else {
      lines.push(`${variable.key}=${variable.defaultValue}`);
    }
  }

  for (const [key, value] of Object.entries(effectiveOverrides)) {
    if (!handled.has(key) && !parsedVars.has(key)) {
      lines.push(`${key}=${quoteEnvValue(value)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function fetchWithRetry(
  fetcher: FetchLike,
  url: string,
  operation: string,
): Promise<Response> {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const signal = AbortSignal.timeout(15_000);
    try {
      const response = await fetcher(url, { signal });
      if (![408, 429, 500, 502, 503, 504].includes(response.status)) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
      if (attempt === maxAttempts) return response;
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }
  throw new Error(
    `${operation} failed after ${maxAttempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function fetchTemplate(
  context: MethodContext,
): Promise<{ url: string; content: string }> {
  const url = templateUrl(context.globalArgs.version);
  const fetcher = context.fetch ?? fetch;
  const response = await fetchWithRetry(
    fetcher,
    url,
    "Fetch Vaultwarden .env.template",
  );
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Vaultwarden .env.template for version ${context.globalArgs.version}: HTTP ${response.status}`,
    );
  }
  return { url, content: await response.text() };
}

/** Vaultwarden helper model. Deployment is handled by cfgmgmt/container extensions. */
export const model = {
  type: "@evrardjp/vaultwarden",
  version: "2026.07.03.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    envTemplate: {
      description: "Parsed upstream Vaultwarden .env.template catalog",
      schema: EnvTemplateResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    envFile: {
      description:
        "Rendered Vaultwarden .env content for deployment by another extension",
      schema: EnvFileResourceSchema,
      sensitiveOutput: true,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    verification: {
      description: "Latest Vaultwarden HTTP health verification result",
      schema: VerificationResourceSchema,
      lifetime: "7d",
      garbageCollection: 20,
    },
  },
  upgrades: [
    {
      toVersion: "2026.07.03.2",
      description: "Version bump with no global argument schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  files: {
    log: {
      description: "Vaultwarden helper operation log",
      contentType: "text/plain",
      lifetime: "7d",
      garbageCollection: 5,
      streaming: true,
    },
  },
  methods: {
    discover: {
      description:
        "Fetch and parse Vaultwarden .env.template to catalog supported environment variables",
      arguments: DiscoverArgsSchema,
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const logWriter = context.createFileWriter("log", "discover");
        const log = async (msg: string, props?: Record<string, unknown>) => {
          context.logger.info(msg, props);
          await logWriter.writeLine(
            props ? `${msg} ${JSON.stringify(props)}` : msg,
          );
        };
        await log("Fetching Vaultwarden environment template", {
          version: context.globalArgs.version,
        });
        const { url, content } = await fetchTemplate(context);
        await log("Fetched Vaultwarden environment template", { url });
        const envVars = [...parseEnvTemplate(content).values()];
        await log("Parsed Vaultwarden environment variables", {
          count: envVars.length,
        });
        const handle = await context.writeResource("envTemplate", "current", {
          version: context.globalArgs.version,
          fetchedAt: new Date().toISOString(),
          templateUrl: url,
          envVars,
        });
        const logHandle = await logWriter.finalize();
        return { dataHandles: [handle, logHandle] };
      },
    },

    "render-env": {
      description:
        "Render Vaultwarden .env content from the upstream template and caller overrides",
      arguments: RenderEnvArgsSchema,
      execute: async (args: RenderEnvArgs, context: MethodContext) => {
        context.logger.info("Rendering Vaultwarden environment file", {
          version: context.globalArgs.version,
          fqdn: context.globalArgs.fqdn,
          overrideKeys: Object.keys(args.envVars).sort(),
        });
        const { content } = await fetchTemplate(context);
        const parsed = parseEnvTemplate(content);
        const domain = baseUrl(context.globalArgs);
        const envFile = buildEnvFile(parsed, args.envVars, domain);
        const appliedKeys = Object.keys({ DOMAIN: domain, ...args.envVars })
          .sort();
        const handle = await context.writeResource("envFile", "current", {
          version: context.globalArgs.version,
          fqdn: context.globalArgs.fqdn,
          domain,
          renderedAt: new Date().toISOString(),
          envFile,
          appliedKeys,
        });
        context.logger.info("Rendered Vaultwarden environment file", {
          appliedKeys,
        });
        return { dataHandles: [handle] };
      },
    },

    verify: {
      description: "Check the Vaultwarden /alive endpoint over HTTP(S)",
      arguments: VerifyArgsSchema,
      execute: async (args: VerifyArgs, context: MethodContext) => {
        const url = healthUrl(context.globalArgs, args.url);
        const fetcher = context.fetch ?? fetch;
        context.logger.info("Checking Vaultwarden health endpoint", { url });
        let reachable = false;
        let httpStatus: number | undefined;
        try {
          const response = await fetchWithRetry(
            fetcher,
            url,
            "Check Vaultwarden health endpoint",
          );
          httpStatus = response.status;
          reachable = response.ok;
        } catch (error) {
          context.logger.warning("Vaultwarden health check failed", {
            url,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        const handle = await context.writeResource("verification", "current", {
          url,
          reachable,
          httpStatus,
          checkedAt: new Date().toISOString(),
        });
        context.logger.info("Recorded Vaultwarden health result", {
          url,
          reachable,
          httpStatus,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
