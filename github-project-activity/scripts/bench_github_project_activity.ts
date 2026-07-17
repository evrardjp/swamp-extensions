#!/usr/bin/env -S deno run --allow-run --allow-env
/**
 * External benchmark harness for github-project-activity.
 *
 * The harness intentionally measures from outside Swamp. For Swamp modes it
 * shells out to `swamp model method run`, so the measurement includes CLI,
 * method runtime, fixture read, transformation, and Swamp data write overhead.
 * It can also time an arbitrary external command for no-Swamp/database baselines
 * and persist all observations in a separate benchmark model.
 */

type BenchArgs = {
  mode: "fetch" | "swamp-ingest" | "external";
  targetModel: string;
  scenario: string;
  sourceMethod: string;
  methodArgs: Record<string, unknown>;
  benchmarkModel?: string;
  benchmarkName: string;
  extensionVersion?: string;
  notes?: string;
  externalCommand?: string[];
};

function usage(): never {
  console.error(`Usage:
  deno run --allow-run --allow-env scripts/bench_github_project_activity.ts \\
    --mode fetch|swamp-ingest|external \\
    --model github-project-activity \\
    --scenario eso-window-2026-07 \\
    [--source-method sync_github_backfill] \\
    [--method-args '{"since":"2026-06-01T00:00:00Z","until":"2026-07-01T00:00:00Z","state":"all"}'] \\
    [--benchmark-model github-project-activity-benchmarks] \\
    [--external-command 'sqlite-ingest-fixtures ...']
`);
  Deno.exit(2);
}

function parseArgs(): BenchArgs {
  const out: BenchArgs = {
    mode: "swamp-ingest",
    targetModel: "",
    scenario: "",
    sourceMethod: "sync_github_backfill",
    methodArgs: {},
    benchmarkName: "github-project-activity-ingest",
  };
  const args = [...Deno.args];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i] ?? usage();
    switch (a) {
      case "--mode":
        out.mode = next() as BenchArgs["mode"];
        break;
      case "--model":
        out.targetModel = next();
        break;
      case "--scenario":
        out.scenario = next();
        break;
      case "--source-method":
        out.sourceMethod = next();
        break;
      case "--method-args":
        out.methodArgs = JSON.parse(next());
        break;
      case "--benchmark-model":
        out.benchmarkModel = next();
        break;
      case "--benchmark-name":
        out.benchmarkName = next();
        break;
      case "--extension-version":
        out.extensionVersion = next();
        break;
      case "--notes":
        out.notes = next();
        break;
      case "--external-command":
        out.externalCommand = ["bash", "-lc", next()];
        break;
      case "-h":
      case "--help":
        usage();
      default:
        console.error(`Unknown argument: ${a}`);
        usage();
    }
  }
  if (!out.targetModel || !out.scenario) usage();
  return out;
}

async function runCommand(
  command: string[],
  stdinJson?: unknown,
): Promise<{ code: number; stdout: string; stderr: string; command: string }> {
  const cmd = new Deno.Command(command[0], {
    args: command.slice(1),
    stdin: stdinJson === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  if (stdinJson !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(JSON.stringify(stdinJson)));
    await writer.close();
  }
  const output = await child.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    command: command.map((p) => p.includes(" ") ? JSON.stringify(p) : p).join(
      " ",
    ),
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function hostName(): Promise<string | undefined> {
  const r = await runCommand(["hostname"]).catch(() => undefined);
  return r?.stdout.trim() || undefined;
}

async function gitSha(): Promise<string | undefined> {
  const r = await runCommand(["git", "rev-parse", "HEAD"]).catch(() =>
    undefined
  );
  return r?.stdout.trim() || undefined;
}

async function recordBenchmark(args: BenchArgs, run: Record<string, unknown>) {
  if (!args.benchmarkModel) return;
  const input = { run };
  const r = await runCommand([
    "swamp",
    "model",
    "method",
    "run",
    args.benchmarkModel,
    "record_benchmark_run",
    "--stdin",
    "--json",
  ], input);
  if (r.code !== 0) {
    console.error("Failed to record benchmark result:");
    console.error(r.stderr || r.stdout);
    Deno.exit(r.code);
  }
}

async function main() {
  const args = parseArgs();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let command: string[];
  let input: unknown | undefined;

  if (args.mode === "fetch") {
    command = [
      "swamp",
      "model",
      "method",
      "run",
      args.targetModel,
      "fetch_from_github",
      "--stdin",
      "--json",
    ];
    input = {
      scenario: args.scenario,
      sourceMethod: args.sourceMethod,
      methodArgs: args.methodArgs,
    };
  } else if (args.mode === "swamp-ingest") {
    command = [
      "swamp",
      "model",
      "method",
      "run",
      args.targetModel,
      "ingest_fetched_data",
      "--stdin",
      "--json",
    ];
    input = {
      scenario: args.scenario,
      sourceMethod: args.sourceMethod,
      methodArgs: args.methodArgs,
    };
  } else {
    if (!args.externalCommand) usage();
    command = args.externalCommand;
  }

  const result = await runCommand(command, input);
  const finishedAt = new Date().toISOString();
  const durationMs = performance.now() - start;
  const parsed = tryParseJson(result.stdout) as any;
  const summary = parsed?.summary ?? parsed?.result?.summary ?? {};
  const run = {
    benchmarkName: args.benchmarkName,
    scenario: args.scenario,
    mode: args.mode,
    targetModel: args.targetModel,
    extensionVersion: args.extensionVersion,
    gitSha: await gitSha(),
    command: result.command,
    startedAt,
    finishedAt,
    durationMs,
    exitCode: result.code,
    fixtureResponses: summary.fixtureResponses ?? summary.responseCount,
    fixtureBytes: summary.totalBodyBytes,
    dataHandleCount: summary.dataHandleCount ?? parsed?.dataHandles?.length,
    host: await hostName(),
    notes: args.notes,
    metadata: {
      summary,
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length,
    },
  };

  console.log(JSON.stringify({ run, commandResult: result }, null, 2));
  await recordBenchmark(args, run);
  Deno.exit(result.code);
}

await main();
