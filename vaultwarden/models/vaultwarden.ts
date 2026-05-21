import { z } from "npm:zod@4";
import type { ModelDefinition } from "jsr:@systeminit/swamp-testing";

// @ts-ignore: Deno global available at bundle runtime
const DenoCmd = Deno.Command;
// @ts-ignore: Deno global available at bundle runtime
const DenoFs = { writeTextFile: Deno.writeTextFile, remove: Deno.remove };

// ─── SSH / SCP helpers ────────────────────────────────────────────────────────

async function sshRaw(
  host: string,
  user: string,
  keyPath: string,
  command: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = new DenoCmd("ssh", {
    args: [
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=10",
      "-o", "BatchMode=yes",
      "-i", keyPath,
      `${user}@${host}`,
      command,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await proc.output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
}

async function sshOrThrow(
  host: string,
  user: string,
  keyPath: string,
  command: string,
): Promise<string> {
  const r = await sshRaw(host, user, keyPath, command);
  if (r.code !== 0) {
    throw new Error(`SSH command failed on ${host} (exit ${r.code}): ${r.stderr.slice(-500)}`);
  }
  return r.stdout;
}

async function scpOrThrow(
  localPath: string,
  host: string,
  user: string,
  keyPath: string,
  remotePath: string,
): Promise<void> {
  const proc = new DenoCmd("scp", {
    args: ["-o", "StrictHostKeyChecking=no", "-i", keyPath, localPath, `${user}@${host}:${remotePath}`],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await proc.output();
  if (result.code !== 0) {
    throw new Error(
      `SCP to ${host}:${remotePath} failed (exit ${result.code}): ${
        new TextDecoder().decode(result.stderr).slice(-500)
      }`,
    );
  }
}

// ─── .env.template parser ─────────────────────────────────────────────────────

interface EnvVar {
  key: string;
  defaultValue: string;
  description: string;
  section: string;
  commented: boolean;
  allowedValues: string[];
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
        vars.set(key, { key, defaultValue, description: descBuffer.join(" ").trim(), section: currentSection, commented: true, allowedValues: extractAllowedValues(descBuffer) });
      }
      descBuffer = [];
      continue;
    }
    if (/^[A-Z_][A-Z0-9_]*=/.test(line)) {
      const eqIdx = line.indexOf("=");
      const key = line.slice(0, eqIdx).trim();
      const defaultValue = line.slice(eqIdx + 1).trim();
      if (!vars.has(key)) {
        vars.set(key, { key, defaultValue, description: descBuffer.join(" ").trim(), section: currentSection, commented: false, allowedValues: extractAllowedValues(descBuffer) });
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

function extractAllowedValues(lines: string[]): string[] {
  for (const line of lines) {
    const match = line.toLowerCase().match(/(?:valid values?|possible values?|allowed values?)[:\s]+(.+)/);
    if (match) return match[1].split(/[,|]/).map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

function quoteEnvValue(value: string): string {
  // Single-quote values to prevent docker-compose variable interpolation.
  // Per vaultwarden docs: https://github.com/dani-garcia/vaultwarden/wiki/Enabling-admin-page
  // Handle embedded single quotes with shell-style '\'' escaping.
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildEnvFile(parsedVars: Map<string, EnvVar>, overrides: Record<string, string>, fqdn: string): string {
  const lines: string[] = [];
  const handled = new Set<string>();

  for (const v of parsedVars.values()) {
    if (overrides[v.key] !== undefined) {
      lines.push(`${v.key}=${quoteEnvValue(overrides[v.key])}`);
      handled.add(v.key);
    } else if (v.commented) {
      lines.push(`# ${v.key}=${v.defaultValue}`);
    } else {
      lines.push(`${v.key}=${v.defaultValue}`);
    }
  }

  if (!handled.has("DOMAIN") && !parsedVars.has("DOMAIN")) {
    lines.push(`DOMAIN=https://${fqdn}`);
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (!handled.has(key) && !parsedVars.has(key)) {
      lines.push(`${key}=${quoteEnvValue(value)}`);
    }
  }

  return lines.join("\n") + "\n";
}

function renderDockerCompose(version: string, workDir: string): string {
  const tag = version === "latest" ? "latest" : version;
  return `services:
  vaultwarden:
    image: vaultwarden/server:${tag}
    restart: always
    env_file: .env
    volumes:
      - vaultwarden-data:/data
      - ${workDir}/certs:${workDir}/certs:ro
    ports:
      - "0.0.0.0:8000:80"
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:80/alive || curl -sfk https://localhost:80/alive"]
      interval: 10s
      timeout: 5s
      retries: 30
      start_period: 20s
volumes:
  vaultwarden-data:
`;
}

function templateUrl(version: string): string {
  const branch = version === "latest" ? "main" : version;
  return `https://raw.githubusercontent.com/dani-garcia/vaultwarden/${branch}/.env.template`;
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const GlobalArgsSchema = z.object({
  version: z.string().default("latest").describe("Vaultwarden docker image tag and template branch"),
  host: z.string().default("192.168.164.11").describe("IP or hostname of the vaultwarden VM"),
  fqdn: z.string().default("vaultwarden.lab.evrard.eu").describe("FQDN for the DOMAIN env var and verify curl"),
  sshUser: z.string().default("admin").describe("SSH user on the vaultwarden VM"),
  sshKeyPath: z.string().default("~/.ssh/id_ed25519").describe("Path to SSH private key"),
  workDir: z.string().default("/opt/vaultwarden").describe("Working directory on the VM for docker-compose files"),
});

const DiscoverArgsSchema = z.object({
  _fetch: z.unknown().optional(),
});

const DeployArgsSchema = z.object({
  envVars: z.record(z.string(), z.string()).default({}).describe("Environment variable overrides applied on top of template defaults"),
  _fetch: z.unknown().optional(),
  _ssh: z.unknown().optional(),
  _scp: z.unknown().optional(),
});

const ConfigureArgsSchema = z.object({
  envVars: z.record(z.string(), z.string()).describe("Environment variable key-value pairs to update or append"),
  _ssh: z.unknown().optional(),
  _scp: z.unknown().optional(),
});

const VerifyArgsSchema = z.object({
  _ssh: z.unknown().optional(),
  _curl: z.unknown().optional(),
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

const DeploymentResourceSchema = z.object({
  host: z.string(),
  version: z.string(),
  workDir: z.string(),
  deployedAt: z.string(),
});

const VerificationResourceSchema = z.object({
  host: z.string(),
  fqdn: z.string(),
  containerRunning: z.boolean(),
  httpReachable: z.boolean(),
  verifiedAt: z.string(),
});

/** Vaultwarden lifecycle model: discover env vars from .env.template, deploy and manage a vaultwarden docker-compose stack over SSH. */
export const model = {
  type: "@evrardjp/vaultwarden",
  version: "2026.05.21.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    envTemplate: {
      description: "Parsed .env.template from vaultwarden GitHub (env var catalog)",
      schema: EnvTemplateResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    deployment: {
      description: "Current vaultwarden deployment state",
      schema: DeploymentResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    verification: {
      description: "Latest vaultwarden health verification result",
      schema: VerificationResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  files: {
    log: {
      description: "Operation log",
      contentType: "text/plain",
      lifetime: "7d",
      garbageCollection: 5,
      streaming: true,
    },
  },
  checks: {
    "ssh-reachable": {
      description: "Verify SSH connectivity to the vaultwarden VM",
      labels: ["live"],
      execute: async (context) => {
        const { host, sshUser, sshKeyPath } = context.globalArgs;
        const r = await sshRaw(host, sshUser, sshKeyPath, "true");
        if (r.code !== 0) {
          return { pass: false, errors: [`Cannot reach ${sshUser}@${host} via SSH: ${r.stderr}`] };
        }
        return { pass: true };
      },
    },
  },
  methods: {
    discover: {
      description: "Fetch and parse vaultwarden .env.template to catalog all supported env vars",
      arguments: DiscoverArgsSchema,
      execute: async (args, context) => {
        // deno-lint-ignore no-explicit-any
        const a = args as any;
        const { version } = context.globalArgs;
        const logWriter = context.createFileWriter("log", "discover");
        const log = async (msg: string) => { context.logger.info(msg); await logWriter.writeLine(msg); };

        const url = templateUrl(version);
        await log(`Fetching .env.template from ${url}`);

        const fetchFn = a._fetch ?? fetch;
        const resp = await fetchFn(url);
        if (!resp.ok) {
          throw new Error(
            `Failed to fetch .env.template for vaultwarden version "${version}": HTTP ${resp.status} from ${url}`,
          );
        }

        const content = await resp.text();
        const envVars = parseEnvTemplate(content);
        await log(`Parsed ${envVars.size} env vars from template`);

        const handle = await context.writeResource("envTemplate", "current", {
          version,
          fetchedAt: new Date().toISOString(),
          templateUrl: url,
          envVars: [...envVars.values()],
        });

        const logHandle = await logWriter.finalize();
        return { dataHandles: [handle, logHandle] };
      },
    },

    deploy: {
      description: "Deploy vaultwarden via docker-compose (fetches template, builds .env, uploads files, starts with healthcheck --wait)",
      arguments: DeployArgsSchema,
      execute: async (args, context) => {
        // deno-lint-ignore no-explicit-any
        const a = args as any;
        const { version, host, fqdn, sshUser, sshKeyPath, workDir } = context.globalArgs;
        const logWriter = context.createFileWriter("log", "deploy");
        const log = async (msg: string) => { context.logger.info(msg); await logWriter.writeLine(msg); };

        const fetchFn = a._fetch ?? fetch;
        const sshFn = a._ssh ?? sshOrThrow;
        const scpFn = a._scp ?? scpOrThrow;

        const url = templateUrl(version);
        await log(`Fetching .env.template from ${url}`);
        const resp = await fetchFn(url);
        if (!resp.ok) {
          throw new Error(
            `Failed to fetch .env.template for vaultwarden version "${version}": HTTP ${resp.status} from ${url}`,
          );
        }

        const content = await resp.text();
        const parsedVars = parseEnvTemplate(content);
        await log(`Parsed ${parsedVars.size} env vars from template`);

        const envContent = buildEnvFile(parsedVars, a.envVars as Record<string, string>, fqdn);
        const composeContent = renderDockerCompose(version, workDir);

        const tmpEnv = `/tmp/vaultwarden-${Date.now()}.env`;
        const tmpCompose = `/tmp/vaultwarden-compose-${Date.now()}.yml`;
        await DenoFs.writeTextFile(tmpEnv, envContent);
        await DenoFs.writeTextFile(tmpCompose, composeContent);

        try {
          await log(`Creating workdir ${workDir} on ${host}`);
          await sshFn(host, sshUser, sshKeyPath, `sudo mkdir -p ${workDir} && sudo chown ${sshUser}:${sshUser} ${workDir}`);

          await log("Uploading .env");
          await scpFn(tmpEnv, host, sshUser, sshKeyPath, `${workDir}/.env`);

          await log("Uploading docker-compose.yml");
          await scpFn(tmpCompose, host, sshUser, sshKeyPath, `${workDir}/docker-compose.yml`);

          await log(`Starting vaultwarden (docker compose up -d --wait)`);
          await sshFn(host, sshUser, sshKeyPath, `docker compose -f ${workDir}/docker-compose.yml up -d --wait`);

          const handle = await context.writeResource("deployment", "current", {
            host,
            version,
            workDir,
            deployedAt: new Date().toISOString(),
          });

          await log("Vaultwarden deployment complete");
          const logHandle = await logWriter.finalize();
          return { dataHandles: [handle, logHandle] };
        } finally {
          await DenoFs.remove(tmpEnv).catch(() => {});
          await DenoFs.remove(tmpCompose).catch(() => {});
        }
      },
    },

    configure: {
      description: "Update specific env vars in the running vaultwarden .env and force-recreate the container",
      arguments: ConfigureArgsSchema,
      execute: async (args, context) => {
        // deno-lint-ignore no-explicit-any
        const a = args as any;
        const { host, sshUser, sshKeyPath, workDir } = context.globalArgs;
        const logWriter = context.createFileWriter("log", "configure");
        const log = async (msg: string) => { context.logger.info(msg); await logWriter.writeLine(msg); };

        const sshFn = a._ssh ?? sshOrThrow;
        const scpFn = a._scp ?? scpOrThrow;

        await log(`Reading current .env from ${host}:${workDir}/.env`);
        const currentEnv = await sshFn(host, sshUser, sshKeyPath, `cat ${workDir}/.env`);

        const envVars = a.envVars as Record<string, string>;
        const lines = (currentEnv as string).split("\n");
        const updatedLines: string[] = [];
        const updated = new Set<string>();

        for (const line of lines) {
          const m = /^#?\s*([A-Z_][A-Z0-9_]*)=/.exec(line);
          if (m && envVars[m[1]] !== undefined) {
            updatedLines.push(`${m[1]}=${quoteEnvValue(envVars[m[1]])}`);
            updated.add(m[1]);
          } else {
            updatedLines.push(line);
          }
        }

        for (const [key, value] of Object.entries(envVars)) {
          if (!updated.has(key)) updatedLines.push(`${key}=${quoteEnvValue(value)}`);
        }

        const newEnv = updatedLines.join("\n");
        const tmpEnv = `/tmp/vaultwarden-cfg-${Date.now()}.env`;
        await DenoFs.writeTextFile(tmpEnv, newEnv);

        try {
          await log("Uploading updated .env");
          await scpFn(tmpEnv, host, sshUser, sshKeyPath, `${workDir}/.env`);

          await log("Force-recreating vaultwarden container");
          await sshFn(host, sshUser, sshKeyPath, `docker compose -f ${workDir}/docker-compose.yml up -d --force-recreate vaultwarden`);

          const handle = await context.writeResource("deployment", "current", {
            host,
            version: context.globalArgs.version,
            workDir,
            deployedAt: new Date().toISOString(),
          });

          await log("Vaultwarden reconfigured");
          const logHandle = await logWriter.finalize();
          return { dataHandles: [handle, logHandle] };
        } finally {
          await DenoFs.remove(tmpEnv).catch(() => {});
        }
      },
    },

    verify: {
      description: "Check vaultwarden health: SSH docker ps and local curl via --resolve",
      arguments: VerifyArgsSchema,
      execute: async (args, context) => {
        // deno-lint-ignore no-explicit-any
        const a = args as any;
        const { host, fqdn, sshUser, sshKeyPath, workDir } = context.globalArgs;
        const logWriter = context.createFileWriter("log", "verify");
        const log = async (msg: string) => { context.logger.info(msg); await logWriter.writeLine(msg); };

        const sshRawFn = a._ssh ?? ((h: string, u: string, k: string, c: string) => sshRaw(h, u, k, c));
        const curlFn = a._curl as ((host: string, fqdn: string) => Promise<{ code: number }>) | undefined;

        await log(`Verifying vaultwarden on ${host} (${fqdn})`);

        let containerRunning = false;
        try {
          const psResult = await sshRawFn(
            host, sshUser, sshKeyPath,
            `docker compose -f ${workDir}/docker-compose.yml ps --format json`,
          );
          if (psResult.code === 0 && psResult.stdout) {
            const containers = (psResult.stdout as string).split("\n").filter(Boolean).map((l: string) => {
              try { return JSON.parse(l); } catch { return null; }
            }).filter(Boolean);
            containerRunning = containers.some((c: Record<string, string>) =>
              (c.Service === "vaultwarden" || (c.Name && c.Name.includes("vaultwarden"))) &&
              (c.State === "running" || c.Health === "healthy")
            );
          }
          await log(`Container running: ${containerRunning}`);
        } catch (e) {
          await log(`SSH docker ps failed: ${e instanceof Error ? e.message : String(e)}`);
        }

        let httpReachable = false;
        try {
          if (curlFn) {
            const r = await curlFn(host, fqdn);
            httpReachable = r.code === 0;
          } else {
            const curlProc = new DenoCmd("curl", {
              args: ["-sSf", "-k", "--max-time", "15", "--resolve", `${fqdn}:443:${host}`, `https://${fqdn}/alive`],
              stdout: "piped",
              stderr: "piped",
            });
            const curlResult = await curlProc.output();
            httpReachable = curlResult.code === 0;
          }
          await log(`HTTP reachable (https://${fqdn}/alive): ${httpReachable}`);
        } catch (e) {
          await log(`curl check failed: ${e instanceof Error ? e.message : String(e)}`);
        }

        const handle = await context.writeResource("verification", "current", {
          host,
          fqdn,
          containerRunning,
          httpReachable,
          verifiedAt: new Date().toISOString(),
        });

        await log("Verification complete");
        const logHandle = await logWriter.finalize();
        return { dataHandles: [handle, logHandle] };
      },
    },
  },
} satisfies ModelDefinition<typeof GlobalArgsSchema>;
