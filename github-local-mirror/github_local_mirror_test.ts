import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { model } from "./github_local_mirror.ts";

type WriteCall = {
  specName: string;
  name: string;
  data: Record<string, unknown>;
};

async function tempContext() {
  const root = await Deno.makeTempDir();
  const writes: WriteCall[] = [];
  const globalArgs = {
    owner: "owner",
    repo: "repo",
    gitObjectPath: `${root}/repo.git`,
    workspaceRoot: `${root}/worktrees`,
    artifactRoot: `${root}/artifacts`,
    gitRemote: "origin",
    knownRemotes: {},
    sshRemoteBase: "git@github.com:",
    syncOverlapMinutes: 5,
  };
  await Deno.mkdir(globalArgs.workspaceRoot, { recursive: true });
  await Deno.mkdir(globalArgs.artifactRoot, { recursive: true });
  return {
    root,
    writes,
    context: {
      globalArgs,
      definition: { name: "owner-repo-mirror" },
      writeResource: async (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ specName, name, data });
        return { specName, name, version: 1 };
      },
    },
  };
}

async function createMirroredPrRef(
  root: string,
  gitObjectPath: string,
  prNumber: number,
): Promise<string> {
  const source = `${root}/source-${prNumber}`;
  const run = async (cwd: string, args: string[]) => {
    const out = await new Deno.Command("git", {
      cwd,
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (out.code !== 0) {
      throw new Error(new TextDecoder().decode(out.stderr));
    }
    return new TextDecoder().decode(out.stdout).trim();
  };
  await Deno.mkdir(source);
  await run(source, ["init"]);
  await run(source, ["config", "user.email", "test@example.com"]);
  await run(source, ["config", "user.name", "Test"]);
  await run(source, ["config", "commit.gpgsign", "false"]);
  await Deno.writeTextFile(`${source}/README.md`, `PR ${prNumber}\n`);
  await run(source, ["add", "README.md"]);
  await run(source, ["commit", "-m", `PR ${prNumber}`]);
  const headSha = await run(source, ["rev-parse", "HEAD"]);
  await run(root, ["clone", "--bare", source, gitObjectPath]);
  await run(root, [
    "--git-dir",
    gitObjectPath,
    "update-ref",
    `refs/remotes/pull/${prNumber}/head`,
    headSha,
  ]);
  return headSha;
}

Deno.test("status writes current mirrorStatus from local state", async () => {
  const { writes, context } = await tempContext();

  const result = await model.methods.status.execute({}, context);

  assertEquals(result.worktreeCount, 0);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "mirrorStatus");
  assertEquals(writes[0].name, "mirror-status-current");
  assertEquals(writes[0].data.repo, "owner/repo");
  assertEquals(writes[0].data.modelName, "owner-repo-mirror");
});

Deno.test("analyze_worktrees marks missing registered worktree", async () => {
  const { writes, context } = await tempContext();
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/worktrees`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    JSON.stringify([
      {
        id: "worktree-owner-repo-42-abcdef-jp",
        repo: "owner/repo",
        prNumber: 42,
        identity: "jp",
        path: `${context.globalArgs.workspaceRoot}/missing`,
        branch: "review/pr-42-patchhead-abcdef-jp",
        baseHeadSha: "abcdef",
        createdAt: "2026-07-16T00:00:00.000Z",
        status: "active",
      },
    ]),
  );

  await model.methods.analyze_worktrees.execute({}, context);

  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "worktreeAnalysis");
  assertEquals(writes[0].data.missing, true);
  assertEquals(
    writes[0].data.recommendedAction,
    "remove-or-recreate-worktree-record",
  );
});

Deno.test("prepare_worktree uses mirrored PR data and records push hints", async () => {
  const { root, writes, context } = await tempContext();
  const source = `${root}/source`;
  await Deno.mkdir(source);
  const run = async (cwd: string, args: string[]) => {
    const out = await new Deno.Command("git", {
      cwd,
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (out.code !== 0) {
      throw new Error(new TextDecoder().decode(out.stderr));
    }
    return new TextDecoder().decode(out.stdout);
  };
  await run(source, ["init"]);
  await run(source, ["config", "user.email", "test@example.com"]);
  await run(source, ["config", "user.name", "Test"]);
  await run(source, ["config", "commit.gpgsign", "false"]);
  await Deno.writeTextFile(`${source}/README.md`, "hello\n");
  await run(source, ["add", "README.md"]);
  await run(source, ["commit", "-m", "initial"]);
  const headSha = (await run(source, ["rev-parse", "HEAD"])).trim();
  await run(root, ["clone", "--bare", source, "repo.git"]);
  await run(root, [
    "--git-dir",
    context.globalArgs.gitObjectPath,
    "update-ref",
    "refs/remotes/pull/42/head",
    headSha,
  ]);
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/42`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/prs/42/current.json`,
    JSON.stringify({
      number: 42,
      headSha,
      headRef: "feature",
      remoteName: "fork-contributor",
      maintainerCanModify: true,
      observedAt: "2026-07-16T00:00:00.000Z",
    }),
  );
  const result = await model.methods.prepare_worktree.execute({
    prNumber: 42,
    identity: "jp",
  }, context);

  assertStringIncludes(
    result.branch,
    `review/pr-42-patchhead-${headSha.slice(0, 12)}-jp`,
  );
  assertEquals(result.contributorRemote, "fork-contributor");
  assertEquals(
    result.suggestedContributorPush,
    "git push fork-contributor HEAD:feature",
  );
  assertEquals(writes[0].specName, "worktreeSnapshot");
  const stat = await Deno.stat(result.path);
  assertEquals(stat.isDirectory, true);
});

Deno.test("model declares upgrade to current version", () => {
  assertEquals(model.upgrades.at(-1)?.toVersion, model.version);
});

Deno.test("global arguments apply review context defaults", () => {
  const parsed = model.globalArguments.parse({
    owner: "owner",
    repo: "repo",
    gitObjectPath: "/tmp/repo.git",
    workspaceRoot: "/tmp/worktrees",
    artifactRoot: "/tmp/artifacts",
  });

  assertEquals(parsed.timelineCodeGranularity, "observed-push");
  assertEquals(parsed.maxApiPages, 100);
  assertEquals(parsed.needsClarificationLabels, [
    "needs-info",
    "needs-information",
    "needs-clarification",
  ]);
  assertEquals(
    model.globalArguments.safeParse({ ...parsed, maxApiPages: 0 }).success,
    false,
  );
});

Deno.test("prepare_review_context refreshes local state and validates subjects", async () => {
  const { root, writes, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    7,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/7`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/prs/7/current.json`,
    JSON.stringify({
      number: 7,
      baseSha: "base",
      headSha,
      observedAt: "2026-07-20T00:00:00.000Z",
    }),
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/issues/8`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/issues/8/current.json`,
    JSON.stringify({ number: 8, observedAt: "2026-07-20T00:00:00.000Z" }),
  );

  const prResult = await model.methods.prepare_review_context.execute({
    subjectType: "pr",
    number: 7,
  }, context);
  const issueResult = await model.methods.prepare_review_context.execute({
    subjectType: "issue",
    number: 8,
  }, context);

  assertEquals(prResult.dataHandles, []);
  assertEquals(prResult.subject.headSha, headSha);
  assertEquals(issueResult.dataHandles, []);
  assertEquals(issueResult.subject.number, 8);
  assertEquals(writes, []);
  await assertRejects(
    () =>
      model.methods.prepare_review_context.execute({
        subjectType: "pr",
        number: 9,
      }, context),
    Error,
    "not present in the local mirror",
  );
  await assertRejects(
    () =>
      model.methods.prepare_review_context.execute({
        subjectType: "issue",
        number: 9,
      }, context),
    Error,
    "not present in the local mirror",
  );
});

Deno.test("record_pr_analysis rejects stale heads and records current head", async () => {
  const { root, writes, context } = await tempContext();
  const currentHeadSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    7,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/7`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/prs/7/current.json`,
    JSON.stringify({
      number: 7,
      baseSha: "base-sha",
      headSha: currentHeadSha,
      observedAt: "2026-07-20T00:00:00.000Z",
    }),
  );
  const args = {
    prNumber: 7,
    generator: "test-generator",
    codePathWalkthrough: "Walkthrough",
    reviewAttentionMap: "Attention",
  };

  await assertRejects(
    () =>
      model.methods.record_pr_analysis.execute({
        ...args,
        headSha: "stale-head-sha",
      }, context),
    Error,
    "does not match current mirrored head",
  );
  const result = await model.methods.record_pr_analysis.execute({
    ...args,
    headSha: currentHeadSha,
  }, context);

  assertEquals(result.dataHandles.length, 1);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "prAnalysisEvidence");
  assertStringIncludes(writes[0].name, currentHeadSha);
  assertEquals(writes[0].data.baseSha, "base-sha");
  assertEquals(writes[0].data.evidenceRefs, []);
});
