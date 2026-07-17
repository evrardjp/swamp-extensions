import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
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
