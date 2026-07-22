import { assert, assertEquals } from "jsr:@std/assert@1";

const extensionDir = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const image = Deno.env.get("FLOCI_IMAGE") ?? "floci/floci:1.5.11";
const externalEndpoint = Deno.env.get("FLOCI_ENDPOINT")?.replace(/\/$/, "");
const evidence: string[] = [];

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function command(
  executable: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    allowFailure?: boolean;
  } = {},
): Promise<Result> {
  const rendered = [executable, ...args].join(" ");
  evidence.push(`$ ${rendered}`);
  const output = await new Deno.Command(executable, {
    args,
    cwd: options.cwd,
    env: options.env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const result = {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
  evidence.push(result.stdout.trim(), result.stderr.trim());
  if (!output.success && !options.allowFailure) {
    throw new Error(
      `${rendered} failed (${output.code}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function swamp(
  repo: string,
  args: string[],
  env: Record<string, string>,
  allowFailure = false,
): Promise<Result> {
  return command("swamp", [...args, "--repo-dir", repo], {
    cwd: repo,
    env,
    allowFailure,
  });
}

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function startFloci(
  name: string,
  port: number,
  storage: string,
): Promise<void> {
  await command("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-u",
    "root",
    "-p",
    `127.0.0.1:${port}:4566`,
    "-v",
    `${storage}:/data`,
    "-e",
    "FLOCI_STORAGE_MODE=persistent",
    "-e",
    "FLOCI_STORAGE_PERSISTENT_PATH=/data",
    image,
  ]);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/_localstack/health`,
      );
      if (response.ok) return;
    } catch {
      // Container startup can briefly refuse connections.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Floci did not become healthy within 60 seconds");
}

async function stopFloci(name: string): Promise<void> {
  await command("docker", ["stop", "--time", "10", name], {
    allowFailure: true,
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const inspect = await command("docker", ["inspect", name], {
      allowFailure: true,
    });
    if (inspect.code !== 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Docker did not remove ${name} within 10 seconds`);
}

async function initRepo(
  repo: string,
  env: Record<string, string>,
): Promise<void> {
  await command("swamp", ["repo", "init", repo, "--tool", "none"], { env });
  await swamp(repo, ["extension", "source", "add", extensionDir], env);
}

async function createModel(
  repo: string,
  type: string,
  name: string,
  values: Record<string, string>,
  env: Record<string, string>,
): Promise<void> {
  const args = ["model", "create", type, name];
  for (const [key, value] of Object.entries(values)) {
    args.push("--global-arg", `${key}=${value}`);
  }
  await swamp(repo, args, env);
}

async function writeIssueDraft(
  classification: "floci-wire-protocol" | "swamp-integration",
  phase: string,
  error: unknown,
): Promise<void> {
  const artifacts = `${extensionDir}/artifacts`;
  await Deno.mkdir(artifacts, { recursive: true });
  const isFloci = classification === "floci-wire-protocol";
  const body = `# ${
    isFloci
      ? "Floci wire-protocol issue draft"
      : "Swamp integration issue draft"
  }

Generated: ${new Date().toISOString()}
Floci image: \`${image}\`
Swamp: real CLI from \`PATH\`
Classification: \`${classification}\`
Phase: \`${phase}\`

## Failure

\`\`\`text
${error instanceof Error ? error.stack ?? error.message : String(error)}
\`\`\`

## Evidence

\`\`\`text
${evidence.filter(Boolean).join("\n")}
\`\`\`

This is a local draft only. Review and redact it before manually submitting any issue.
`;
  await Deno.writeTextFile(
    `${artifacts}/${classification}-issue.md`,
    body,
  );
}

Deno.test({
  name: "Floci S3 protocol, workflow, datastore, restart, and cleanup",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "floci-aws-e2e-" });
    const repo = `${root}/primary`;
    const cleanRepo = `${root}/rehydrated`;
    const cleanupRepo = `${root}/cleanup`;
    const managedFloci = externalEndpoint === undefined;
    const port = managedFloci ? freePort() : 0;
    const endpoint = externalEndpoint ?? `http://127.0.0.1:${port}`;
    const container = `floci-aws-${crypto.randomUUID().slice(0, 8)}`;
    const storage = `${container}-data`;
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const bucket = `floci-smoke-${suffix}`;
    const datastoreBucket = `floci-datastore-${suffix}`;
    const env = {
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      AWS_DEFAULT_REGION: "us-east-1",
      AWS_REGION: "us-east-1",
      AWS_ENDPOINT_URL: endpoint,
    };
    const connection = {
      endpoint,
      region: "us-east-1",
    };
    let phase = "container-start";
    let classification: "floci-wire-protocol" | "swamp-integration" =
      "swamp-integration";

    try {
      if (managedFloci) {
        await command("docker", ["volume", "create", storage]);
        await command("docker", [
          "run",
          "--rm",
          "-u",
          "root",
          "-v",
          `${storage}:/data`,
          "--entrypoint",
          "/bin/chmod",
          image,
          "0777",
          "/data",
        ]);
        await startFloci(container, port, storage);
      }
      phase = "repository-and-model-scaffolding";
      classification = "swamp-integration";
      await initRepo(repo, env);
      await createModel(
        repo,
        "@evrardjp/floci-aws/health",
        "floci-health",
        connection,
        env,
      );
      await createModel(
        repo,
        "@evrardjp/floci-aws/s3-bucket",
        "protocol-bucket",
        { ...connection, bucket },
        env,
      );
      await createModel(
        repo,
        "@evrardjp/floci-aws/s3-object",
        "protocol-object",
        { ...connection, bucket, key: "protocol.txt" },
        env,
      );

      phase = "direct-model-wire-protocol";
      classification = "floci-wire-protocol";
      await swamp(
        repo,
        ["model", "method", "run", "floci-health", "status"],
        env,
      );
      await swamp(
        repo,
        ["model", "method", "run", "protocol-bucket", "create"],
        env,
      );
      await swamp(
        repo,
        ["model", "method", "run", "protocol-bucket", "head"],
        env,
      );
      await swamp(repo, [
        "model",
        "method",
        "run",
        "protocol-object",
        "put",
        "--input",
        "body=protocol-body",
        "--input",
        "ifNoneMatch=*",
      ], env);
      await swamp(
        repo,
        ["model", "method", "run", "protocol-object", "head"],
        env,
      );
      await swamp(
        repo,
        ["model", "method", "run", "protocol-object", "get"],
        env,
      );
      await swamp(
        repo,
        ["model", "method", "run", "protocol-object", "list"],
        env,
      );
      await swamp(repo, ["model", "get", "protocol-object", "--json"], env);
      await swamp(
        repo,
        ["model", "method", "run", "protocol-object", "delete"],
        env,
      );
      await swamp(repo, ["model", "get", "protocol-bucket", "--json"], env);
      await swamp(
        repo,
        ["model", "method", "run", "protocol-bucket", "delete"],
        env,
      );

      const workflowBucket = `floci-workflow-${suffix}`;
      phase = "bundled-workflow";
      classification = "swamp-integration";
      await swamp(
        repo,
        ["workflow", "validate", "@evrardjp/floci-aws-smoke", "--json"],
        env,
      );
      await swamp(repo, [
        "workflow",
        "run",
        "@evrardjp/floci-aws-smoke",
        "--input",
        `endpoint=${endpoint}`,
        "--input",
        `bucket=${workflowBucket}`,
      ], env);

      await createModel(
        repo,
        "@evrardjp/floci-aws/s3-bucket",
        "datastore-bucket",
        { ...connection, bucket: datastoreBucket },
        env,
      );
      phase = "s3-datastore-setup-and-sync";
      await swamp(repo, [
        "model",
        "method",
        "run",
        "datastore-bucket",
        "create",
      ], env);
      await swamp(
        repo,
        ["extension", "pull", "@swamp/s3-datastore", "--yes"],
        env,
      );
      const datastoreConfig = JSON.stringify({
        bucket: datastoreBucket,
        prefix: `phase1/${suffix}`,
        region: "us-east-1",
        endpoint,
        forcePathStyle: true,
      });
      await swamp(repo, [
        "datastore",
        "setup",
        "extension",
        "@swamp/s3-datastore",
        "--config",
        datastoreConfig,
      ], env);
      await swamp(repo, ["datastore", "status"], env);
      await swamp(repo, ["datastore", "sync", "--push"], env);

      const locks = await Promise.all([
        swamp(repo, ["datastore", "sync"], env, true),
        swamp(repo, ["datastore", "sync"], env, true),
      ]);
      assert(
        locks.every((result) => result.code === 0 || result.code === 75),
        `unexpected lock-test exit codes: ${
          locks.map((result) => result.code)
        }`,
      );

      if (managedFloci) {
        await stopFloci(container);
        phase = "floci-container-restart";
        classification = "swamp-integration";
        await startFloci(container, port, storage);
      }
      phase = "post-restart-datastore-pull";
      await swamp(repo, ["datastore", "sync", "--pull"], env);
      phase = "post-restart-floci-health";
      classification = "floci-wire-protocol";
      await swamp(
        repo,
        ["model", "method", "run", "floci-health", "status"],
        env,
      );

      phase = "clean-repository-rehydration";
      classification = "swamp-integration";
      await initRepo(cleanRepo, env);
      await swamp(cleanRepo, [
        "extension",
        "pull",
        "@swamp/s3-datastore",
        "--yes",
      ], env);
      await swamp(cleanRepo, [
        "datastore",
        "setup",
        "extension",
        "@swamp/s3-datastore",
        "--config",
        datastoreConfig,
        "--skip-migration",
      ], env);
      await swamp(cleanRepo, ["datastore", "sync", "--pull"], env);
      const rehydrated = await swamp(
        cleanRepo,
        [
          "data",
          "query",
          'modelName == "floci-health" && name == "status"',
          "--select",
          "name",
        ],
        env,
      );
      assertEquals(rehydrated.stdout.includes("status"), true);

      phase = "remote-datastore-cleanup";
      await initRepo(cleanupRepo, env);
      await createModel(
        cleanupRepo,
        "@evrardjp/floci-aws/s3-object",
        "datastore-objects",
        { ...connection, bucket: datastoreBucket, key: "cleanup" },
        env,
      );
      await createModel(
        cleanupRepo,
        "@evrardjp/floci-aws/s3-bucket",
        "cleanup-datastore-bucket",
        { ...connection, bucket: datastoreBucket },
        env,
      );
      await swamp(cleanupRepo, [
        "model",
        "method",
        "run",
        "datastore-objects",
        "deletePrefix",
        "--input",
        `prefix=phase1/${suffix}`,
      ], env);
      await swamp(cleanupRepo, [
        "model",
        "method",
        "run",
        "cleanup-datastore-bucket",
        "delete",
      ], env);
    } catch (error) {
      if (managedFloci) {
        await command("docker", ["logs", container], { allowFailure: true });
      }
      await writeIssueDraft(classification, phase, error);
      throw error;
    } finally {
      if (managedFloci) {
        await stopFloci(container);
        await command("docker", ["volume", "rm", "--force", storage], {
          allowFailure: true,
        });
      }
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
    }
  },
});
