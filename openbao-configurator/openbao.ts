import { z } from "npm:zod@4";

type JsonObject = Record<string, unknown>;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const GlobalArgsSchema = z.object({
  apiAddr: z.string().url().describe(
    "OpenBao API address, for example https://bao.example.com:8200",
  ),
});

const InitializeArgsSchema = z.object({
  vaultName: z.string().default("openbao-creds").describe(
    "Swamp vault where unseal keys and root token will be stored",
  ),
  keyShares: z.number().int().positive().default(5).describe(
    "Total number of unseal key shares to generate",
  ),
  keyThreshold: z.number().int().positive().default(3).describe(
    "Minimum number of key shares required to unseal",
  ),
}).refine((args) => args.keyThreshold <= args.keyShares, {
  message: "keyThreshold must be less than or equal to keyShares",
  path: ["keyThreshold"],
});

const UnsealArgsSchema = z.object({
  unsealKey: z.string().meta({ sensitive: true }).describe(
    "One unseal key share; prefer a vault expression such as vault.get(...) in workflow inputs",
  ),
});

const SealArgsSchema = z.object({
  token: z.string().meta({ sensitive: true }).describe(
    "Root or operator token; prefer a vault expression such as vault.get(...) in workflow inputs",
  ),
});

const RaftStorageConfigSchema = z.object({
  type: z.literal("raft"),
  path: z.string().default("/var/lib/openbao/data").describe(
    "Raft storage data directory",
  ),
  nodeId: z.string().default("vault-node-1").describe(
    "Raft node identifier",
  ),
});

const FileStorageConfigSchema = z.object({
  type: z.literal("file"),
  path: z.string().describe("File storage data directory"),
});

const TcpListenerConfigSchema = z.object({
  type: z.literal("tcp"),
  address: z.string().describe("TCP listener address in host:port format"),
  clusterAddress: z.string().optional().describe(
    "Optional cluster listener address for this TCP listener",
  ),
  tlsDisable: z.boolean().default(false).describe(
    "Disable TLS for this listener",
  ),
  tlsCertFile: z.string().default("/etc/openbao/tls/openbao.crt").describe(
    "TLS certificate path on the OpenBao host",
  ),
  tlsKeyFile: z.string().default("/etc/openbao/tls/openbao.key").describe(
    "TLS private key path on the OpenBao host",
  ),
});

const TelemetryConfigSchema = z.object({
  prometheusRetentionTime: z.string().optional().describe(
    "Prometheus retention duration, for example 24h",
  ),
  disableHostname: z.boolean().optional().describe(
    "Disable adding hostname labels to telemetry",
  ),
}).optional();

const RenderConfigArgsSchema = z.object({
  ui: z.boolean().default(false).describe("Enable the OpenBao web UI"),
  apiAddr: z.string().url().optional().describe(
    "API advertise address; defaults to the model apiAddr",
  ),
  clusterAddr: z.string().url().describe(
    "Cluster advertise address, for example https://bao.example.com:8201",
  ),
  disableMlock: z.boolean().optional().describe(
    "Set OpenBao disable_mlock",
  ),
  storage: z.discriminatedUnion("type", [
    RaftStorageConfigSchema,
    FileStorageConfigSchema,
  ]).default({
    type: "raft",
    path: "/var/lib/openbao/data",
    nodeId: "vault-node-1",
  }),
  listeners: z.array(TcpListenerConfigSchema).min(1).describe(
    "OpenBao listener blocks",
  ),
  telemetry: TelemetryConfigSchema,
  extraHcl: z.string().optional().describe(
    "Trusted raw HCL appended after generated blocks as an escape hatch",
  ),
});

const StatusStateSchema = z.object({
  apiAddr: z.string(),
  initialized: z.boolean().optional(),
  sealed: z.boolean().optional(),
  standby: z.boolean().optional(),
  performanceStandby: z.boolean().optional(),
  serverTimeUtc: z.number().optional(),
  version: z.string().optional(),
  clusterName: z.string().optional(),
  clusterId: z.string().optional(),
  checkedAt: z.string(),
  httpStatus: z.number(),
});

const InitializedStateSchema = z.object({
  apiAddr: z.string(),
  vaultName: z.string(),
  keyShares: z.number(),
  keyThreshold: z.number(),
  initializedAt: z.string().optional(),
  skippedAt: z.string().optional(),
  skipped: z.boolean().optional(),
});

const UnsealStateSchema = z.object({
  apiAddr: z.string(),
  progress: z.number(),
  threshold: z.number(),
  sealed: z.boolean(),
  unsealedAt: z.string().optional(),
});

const SealStateSchema = z.object({
  apiAddr: z.string(),
  sealedAt: z.string(),
});

const RenderedConfigSchema = z.object({
  apiAddr: z.string(),
  clusterAddr: z.string(),
  storageBackend: z.string(),
  listenerAddresses: z.array(z.string()),
  tlsEnabled: z.boolean(),
  content: z.string(),
  contentSha256: z.string(),
  warnings: z.array(z.string()),
  renderedAt: z.string(),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type InitializeArgs = z.infer<typeof InitializeArgsSchema>;
type UnsealArgs = z.infer<typeof UnsealArgsSchema>;
type SealArgs = z.infer<typeof SealArgsSchema>;
type RenderConfigArgs = z.infer<typeof RenderConfigArgsSchema>;

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
  putSecret?: (vaultName: string, key: string, value: string) => Promise<void>;
  fetch?: FetchLike;
}

function apiUrl(apiAddr: string, path: string): string {
  return `${apiAddr.replace(/\/+$/, "")}/v1/${path.replace(/^\/+/, "")}`;
}

async function readJson(response: Response): Promise<JsonObject> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `OpenBao returned non-JSON response: ${error}; body=${
        text.slice(0, 300)
      }`,
    );
  }
}

async function fetchWithRetry(
  fetcher: FetchLike,
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const signal = AbortSignal.timeout(15_000);
    try {
      const response = await fetcher(url, { ...init, signal });
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

async function requestJson(
  context: MethodContext,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: JsonObject }> {
  const fetcher = context.fetch ?? fetch;
  const url = apiUrl(context.globalArgs.apiAddr, path);
  const response = await fetchWithRetry(fetcher, url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  }, `OpenBao ${path}`);
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(
      `OpenBao ${path} failed with HTTP ${response.status}: ${
        JSON.stringify(body).slice(0, 500)
      }`,
    );
  }
  return { status: response.status, body };
}

async function putSecret(
  context: MethodContext,
  vaultName: string,
  key: string,
  value: string,
): Promise<void> {
  if (!context.putSecret) {
    throw new Error(
      "This Swamp runtime does not expose context.putSecret; cannot store OpenBao secrets safely",
    );
  }
  await context.putSecret(vaultName, key, value);
}

function healthResource(
  apiAddr: string,
  status: number,
  body: JsonObject,
): Record<string, unknown> {
  return {
    apiAddr,
    initialized: body.initialized as boolean | undefined,
    sealed: body.sealed as boolean | undefined,
    standby: body.standby as boolean | undefined,
    performanceStandby: body.performance_standby as boolean | undefined,
    serverTimeUtc: body.server_time_utc as number | undefined,
    version: body.version as string | undefined,
    clusterName: body.cluster_name as string | undefined,
    clusterId: body.cluster_id as string | undefined,
    checkedAt: new Date().toISOString(),
    httpStatus: status,
  };
}

function hclString(value: string): string {
  return JSON.stringify(value);
}

function hclBool(value: boolean): string {
  return value ? "true" : "false";
}

async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

function validateConfig(args: RenderConfigArgs, apiAddr: string): string[] {
  const errors: string[] = [];
  const apiScheme = new URL(apiAddr).protocol;
  const clusterScheme = new URL(args.clusterAddr).protocol;

  if (apiScheme !== clusterScheme) {
    errors.push("apiAddr and clusterAddr must use the same URL scheme");
  }

  for (const listener of args.listeners) {
    if (!listener.tlsDisable && apiScheme !== "https:") {
      errors.push(
        `TLS-enabled listener ${listener.address} requires an https apiAddr`,
      );
    }
    if (listener.tlsDisable && apiScheme !== "http:") {
      errors.push(
        `TLS-disabled listener ${listener.address} requires an http apiAddr`,
      );
    }
    if (!listener.tlsDisable && !listener.tlsCertFile) {
      errors.push(`TLS listener ${listener.address} requires tlsCertFile`);
    }
    if (!listener.tlsDisable && !listener.tlsKeyFile) {
      errors.push(`TLS listener ${listener.address} requires tlsKeyFile`);
    }
  }

  return errors;
}

function renderOpenBaoHcl(args: RenderConfigArgs, apiAddr: string): string {
  const lines: string[] = [];
  lines.push(`ui = ${hclBool(args.ui)}`);

  if (args.disableMlock !== undefined) {
    lines.push(`disable_mlock = ${hclBool(args.disableMlock)}`);
  }

  lines.push("");
  if (args.storage.type === "raft") {
    lines.push('storage "raft" {');
    lines.push(`  path    = ${hclString(args.storage.path)}`);
    lines.push(`  node_id = ${hclString(args.storage.nodeId)}`);
    lines.push("}");
  } else {
    lines.push('storage "file" {');
    lines.push(`  path = ${hclString(args.storage.path)}`);
    lines.push("}");
  }

  for (const listener of args.listeners) {
    lines.push("");
    lines.push('listener "tcp" {');
    lines.push(`  address = ${hclString(listener.address)}`);
    if (listener.clusterAddress) {
      lines.push(`  cluster_address = ${hclString(listener.clusterAddress)}`);
    }
    if (listener.tlsDisable) {
      lines.push("  tls_disable = true");
    } else {
      lines.push(`  tls_cert_file = ${hclString(listener.tlsCertFile)}`);
      lines.push(`  tls_key_file  = ${hclString(listener.tlsKeyFile)}`);
    }
    lines.push("}");
  }

  if (args.telemetry) {
    lines.push("");
    lines.push("telemetry {");
    if (args.telemetry.prometheusRetentionTime !== undefined) {
      lines.push(
        `  prometheus_retention_time = ${
          hclString(args.telemetry.prometheusRetentionTime)
        }`,
      );
    }
    if (args.telemetry.disableHostname !== undefined) {
      lines.push(
        `  disable_hostname = ${hclBool(args.telemetry.disableHostname)}`,
      );
    }
    lines.push("}");
  }

  lines.push("");
  lines.push(`cluster_addr = ${hclString(args.clusterAddr)}`);
  lines.push(`api_addr     = ${hclString(apiAddr)}`);

  if (args.extraHcl) {
    lines.push("");
    lines.push(args.extraHcl.trimEnd());
  }

  return `${lines.join("\n")}\n`;
}

async function status(
  context: MethodContext,
): Promise<Record<string, unknown>> {
  const fetcher = context.fetch ?? fetch;
  const response = await fetchWithRetry(
    fetcher,
    apiUrl(
      context.globalArgs.apiAddr,
      "sys/health?standbyok=true&sealedcode=200&uninitcode=200",
    ),
    {},
    "OpenBao health check",
  );
  const body = await readJson(response);
  return healthResource(context.globalArgs.apiAddr, response.status, body);
}

/** Swamp model for OpenBao API lifecycle control. Deployment is handled by cfgmgmt models. */
export const model = {
  type: "@evrardjp/openbao-configurator",
  version: "2026.07.03.4",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.03.4",
      description: "Version bump with no global argument schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    renderedConfig: {
      description: "Rendered OpenBao HCL configuration",
      schema: RenderedConfigSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    status: {
      description: "OpenBao health/status snapshot from the API",
      schema: StatusStateSchema,
      lifetime: "7d",
      garbageCollection: 20,
    },
    initState: {
      description:
        "OpenBao initialization state; generated keys are stored in the Swamp vault",
      schema: InitializedStateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    unseal: {
      description: "Unseal progress after submitting one key share",
      schema: UnsealStateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    seal: {
      description: "Seal confirmation",
      schema: SealStateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  files: {
    log: {
      description: "OpenBao lifecycle operation log",
      contentType: "text/plain",
      lifetime: "7d",
      garbageCollection: 5,
      streaming: true,
    },
  },
  methods: {
    renderConfig: {
      description:
        "Render an OpenBao HCL configuration from typed, schema-aware arguments without deploying it",
      arguments: RenderConfigArgsSchema,
      execute: async (args: RenderConfigArgs, context: MethodContext) => {
        const apiAddr = args.apiAddr ?? context.globalArgs.apiAddr;
        context.logger.info("Rendering OpenBao configuration", {
          apiAddr,
          clusterAddr: args.clusterAddr,
          storageBackend: args.storage.type,
          listenerCount: args.listeners.length,
          hasExtraHcl: Boolean(args.extraHcl),
        });
        const errors = validateConfig(args, apiAddr);
        if (errors.length > 0) {
          throw new Error(
            `Invalid OpenBao configuration: ${errors.join("; ")}`,
          );
        }

        const content = renderOpenBaoHcl(args, apiAddr);
        const contentSha256 = await sha256Hex(content);
        const warnings = args.extraHcl
          ? [
            "extraHcl was appended without structural validation; validate the rendered HCL with bao server -config before deployment",
          ]
          : [];
        const handle = await context.writeResource(
          "renderedConfig",
          "current",
          {
            apiAddr,
            clusterAddr: args.clusterAddr,
            storageBackend: args.storage.type,
            listenerAddresses: args.listeners.map((listener) =>
              listener.address
            ),
            tlsEnabled: args.listeners.some((listener) => !listener.tlsDisable),
            content,
            contentSha256,
            warnings,
            renderedAt: new Date().toISOString(),
          },
        );
        context.logger.info("Rendered OpenBao configuration", {
          contentSha256,
          warningCount: warnings.length,
        });
        return { dataHandles: [handle] };
      },
    },

    status: {
      description: "Read OpenBao health/status from the API",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        context.logger.info("Reading OpenBao health status", {
          apiAddr: context.globalArgs.apiAddr,
        });
        const snapshot = await status(context);
        const handle = await context.writeResource(
          "status",
          "current",
          snapshot,
        );
        context.logger.info("Recorded OpenBao health status", {
          apiAddr: context.globalArgs.apiAddr,
          httpStatus: snapshot.httpStatus,
          initialized: snapshot.initialized,
          sealed: snapshot.sealed,
        });
        return { dataHandles: [handle] };
      },
    },

    initialize: {
      description:
        "Initialize OpenBao through the API, then store unseal keys and root token in a Swamp vault",
      arguments: InitializeArgsSchema,
      execute: async (args: InitializeArgs, context: MethodContext) => {
        const logWriter = context.createFileWriter("log", "initialize", {
          streaming: true,
        });
        const log = async (msg: string, props?: Record<string, unknown>) => {
          context.logger.info(msg, props);
          await logWriter.writeLine(
            props ? `${msg} ${JSON.stringify(props)}` : msg,
          );
        };

        await log("Checking OpenBao initialization state", {
          apiAddr: context.globalArgs.apiAddr,
        });
        const initStatus = await requestJson(context, "sys/init");
        if (initStatus.body.initialized === true) {
          await log("OpenBao is already initialized; skipping init");
          const skipHandle = await context.writeResource(
            "initState",
            "result",
            {
              apiAddr: context.globalArgs.apiAddr,
              vaultName: args.vaultName,
              keyShares: args.keyShares,
              keyThreshold: args.keyThreshold,
              skipped: true,
              skippedAt: new Date().toISOString(),
            },
          );
          const logHandle = await logWriter.finalize();
          return { dataHandles: [skipHandle, logHandle] };
        }

        await log("Initializing OpenBao", {
          keyShares: args.keyShares,
          keyThreshold: args.keyThreshold,
        });
        const init = await requestJson(context, "sys/init", {
          method: "PUT",
          body: JSON.stringify({
            secret_shares: args.keyShares,
            secret_threshold: args.keyThreshold,
          }),
        });
        const unsealKeys = (init.body.keys_base64 ??
          init.body.unseal_keys_b64 ?? init.body.keys) as string[] | undefined;
        const rootToken = init.body.root_token as string | undefined;
        if (
          !Array.isArray(unsealKeys) || unsealKeys.length === 0 || !rootToken
        ) {
          throw new Error(
            "OpenBao init response did not contain unseal keys and root token",
          );
        }

        await log("Storing OpenBao unseal keys", {
          keyCount: unsealKeys.length,
          vaultName: args.vaultName,
        });
        for (let i = 0; i < unsealKeys.length; i++) {
          const secretName = `OPENBAO_UNSEAL_KEY_${i + 1}`;
          await putSecret(context, args.vaultName, secretName, unsealKeys[i]);
          await log(`Stored ${secretName}`);
        }
        await putSecret(
          context,
          args.vaultName,
          "OPENBAO_ROOT_TOKEN",
          rootToken,
        );
        await log("Stored OPENBAO_ROOT_TOKEN");

        const initHandle = await context.writeResource("initState", "result", {
          apiAddr: context.globalArgs.apiAddr,
          vaultName: args.vaultName,
          keyShares: args.keyShares,
          keyThreshold: args.keyThreshold,
          initializedAt: new Date().toISOString(),
        });
        const logHandle = await logWriter.finalize();
        return { dataHandles: [initHandle, logHandle] };
      },
    },

    unseal: {
      description: "Submit one unseal key share through the OpenBao API",
      arguments: UnsealArgsSchema,
      execute: async (args: UnsealArgs, context: MethodContext) => {
        context.logger.info("Submitting one OpenBao unseal key share", {
          apiAddr: context.globalArgs.apiAddr,
        });
        const unseal = await requestJson(context, "sys/unseal", {
          method: "PUT",
          body: JSON.stringify({ key: args.unsealKey }),
        });
        const progress = unseal.body.progress as number;
        const threshold = unseal.body.t as number;
        const sealed = unseal.body.sealed as boolean;
        const handle = await context.writeResource("unseal", "result", {
          apiAddr: context.globalArgs.apiAddr,
          progress,
          threshold,
          sealed,
          unsealedAt: !sealed ? new Date().toISOString() : undefined,
        });
        context.logger.info("Recorded OpenBao unseal progress", {
          apiAddr: context.globalArgs.apiAddr,
          progress,
          threshold,
          sealed,
        });
        return { dataHandles: [handle] };
      },
    },

    seal: {
      description: "Seal OpenBao through the API using an operator token",
      arguments: SealArgsSchema,
      execute: async (args: SealArgs, context: MethodContext) => {
        context.logger.info("Sealing OpenBao", {
          apiAddr: context.globalArgs.apiAddr,
        });
        await requestJson(context, "sys/seal", {
          method: "PUT",
          headers: { "x-vault-token": args.token },
          body: JSON.stringify({}),
        });
        const handle = await context.writeResource("seal", "result", {
          apiAddr: context.globalArgs.apiAddr,
          sealedAt: new Date().toISOString(),
        });
        context.logger.info("Recorded OpenBao seal confirmation", {
          apiAddr: context.globalArgs.apiAddr,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
