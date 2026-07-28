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
  assertEquals(
    (writes[0].data.prLink as Record<string, unknown>).prNumber,
    42,
  );
  assertEquals(
    (writes[0].data.prLink as Record<string, unknown>).headShaAtAttachment,
    headSha,
  );
  assertEquals(
    (writes[0].data.prLink as Record<string, unknown>).mode,
    "created-from-pr",
  );
  const stat = await Deno.stat(result.path);
  assertEquals(stat.isDirectory, true);
  const repeated = await model.methods.prepare_worktree.execute({
    prNumber: 42,
    identity: "jp",
  }, context);
  assertEquals(repeated.path, result.path);
  assertEquals(
    JSON.parse(
      await Deno.readTextFile(
        `${context.globalArgs.artifactRoot}/worktrees/index.json`,
      ),
    ).length,
    1,
  );
  const workspaceLink = `${root}/workspace-link`;
  await Deno.symlink(context.globalArgs.workspaceRoot, workspaceLink);
  const registryPath =
    `${context.globalArgs.artifactRoot}/worktrees/index.json`;
  const legacyRegistry = JSON.parse(await Deno.readTextFile(registryPath));
  const legacyPath = `${workspaceLink}/${result.path.split("/").at(-1)}`;
  legacyRegistry[0].path = legacyPath;
  await Deno.writeTextFile(registryPath, JSON.stringify(legacyRegistry));
  context.globalArgs.workspaceRoot = workspaceLink;

  const normalized = await model.methods.prepare_worktree.execute({
    prNumber: 42,
    identity: "jp",
  }, context);

  assertEquals(
    await Deno.realPath(normalized.path),
    await Deno.realPath(result.path),
  );
  assertEquals(
    JSON.parse(await Deno.readTextFile(registryPath))[0].path,
    normalized.path,
  );
});

Deno.test("create_worktree creates development branches and validates its source", async () => {
  const { root, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    1,
  );
  const update = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "update-ref",
      "refs/remotes/origin/main",
      headSha,
    ],
  }).output();
  assertEquals(update.code, 0);

  const result = await model.methods.create_worktree.execute({
    branch: "feature/development",
  }, context);

  assertEquals(result.createdReason, "development");
  assertEquals(result.branch, "feature/development");
  assertEquals(result.baseHeadSha, headSha);
  assertEquals((await Deno.stat(result.path)).isDirectory, true);
  const registry = JSON.parse(
    await Deno.readTextFile(
      `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    ),
  );
  assertEquals(result.worktreeId, registry[0].id);
  assertEquals(registry[0].createdReason, "development");
  assertEquals(registry[0].creationBaseRef, "HEAD");
  assertEquals(registry[0].prLink, undefined);
  assertEquals(registry[0].filesystemState, "active");

  const repeated = await model.methods.create_worktree.execute({
    branch: "feature/development",
  }, context);
  assertEquals(repeated.path, result.path);
  assertEquals(repeated.worktreeId, result.worktreeId);
  assertEquals(
    JSON.parse(
      await Deno.readTextFile(
        `${context.globalArgs.artifactRoot}/worktrees/index.json`,
      ),
    ).length,
    1,
  );

  const partialBranch = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "branch",
      "feature/recover-partial",
      headSha,
    ],
  }).output();
  assertEquals(partialBranch.code, 0);
  const recovered = await model.methods.create_worktree.execute({
    branch: "feature/recover-partial",
  }, context);
  assertEquals(recovered.branch, "feature/recover-partial");
  assertEquals((await Deno.stat(recovered.path)).isDirectory, true);

  const longPrefix = `feature/${"a".repeat(190)}`;
  const firstLong = await model.methods.create_worktree.execute({
    branch: `${longPrefix}-one`,
  }, context);
  const secondLong = await model.methods.create_worktree.execute({
    branch: `${longPrefix}-two`,
  }, context);
  assertEquals(firstLong.worktreeId === secondLong.worktreeId, false);

  await assertRejects(
    () => model.methods.create_worktree.execute({}, context),
    Error,
    "exactly one",
  );
  await assertRejects(
    () =>
      model.methods.create_worktree.execute({
        branch: "feature/missing-base",
        baseRef: "refs/remotes/origin/does-not-exist",
      }, context),
    Error,
    "base ref is not a valid local commit",
  );
  await assertRejects(
    () =>
      model.methods.create_worktree.execute({
        prNumber: 1,
        branch: "both",
      }, context),
    Error,
    "exactly one",
  );
  await assertRejects(
    () =>
      model.methods.create_worktree.execute({ branch: "bad..branch" }, context),
    Error,
    "invalid branch name",
  );
  await assertRejects(
    () => model.methods.create_worktree.execute({ branch: "review" }, context),
    Error,
    "reserved name",
  );
});

Deno.test("concurrent worktree creation preserves every registry record", async () => {
  const { root, context } = await tempContext();
  await createMirroredPrRef(root, context.globalArgs.gitObjectPath, 2);

  const [first, second] = await Promise.all([
    model.methods.create_worktree.execute(
      { branch: "concurrent/first" },
      context,
    ),
    model.methods.create_worktree.execute(
      { branch: "concurrent/second" },
      context,
    ),
  ]);

  const registry = JSON.parse(
    await Deno.readTextFile(
      `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    ),
  );
  assertEquals(registry.length, 2);
  assertEquals(
    new Set(registry.map((record: { id: string }) => record.id)),
    new Set([first.worktreeId, second.worktreeId]),
  );
});

Deno.test("legacy worktrees normalize for analysis without rewriting the registry", async () => {
  const { writes, context } = await tempContext();
  const indexPath = `${context.globalArgs.artifactRoot}/worktrees/index.json`;
  const legacy = [{
    id: "legacy-7",
    repo: "owner/repo",
    prNumber: 7,
    path: `${context.globalArgs.workspaceRoot}/missing-legacy`,
    branch: "review/pr-7-patchhead-abcdefabcdef",
    baseHeadSha: "abcdef",
    createdAt: "2026-07-16T00:00:00.000Z",
    status: "active",
  }];
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/worktrees`, {
    recursive: true,
  });
  await Deno.writeTextFile(indexPath, JSON.stringify(legacy));

  await model.methods.analyze_worktrees.execute({}, context);

  assertEquals(writes[0].data.createdReason, "review");
  assertEquals(writes[0].data.prNumber, 7);
  assertEquals(writes[0].data.prLink, {
    prNumber: 7,
    attachedAt: legacy[0].createdAt,
    headShaAtAttachment: "abcdef",
    mode: "created-from-pr",
  });
  assertEquals(writes[0].data.filesystemState, "active");
  assertEquals(JSON.parse(await Deno.readTextFile(indexPath)), legacy);
});

Deno.test("attach and detach preserve development provenance and removal is safe", async () => {
  const { root, context } = await tempContext();
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
      headSha,
      observedAt: "2026-07-23T00:00:00.000Z",
    }),
  );
  const development = await model.methods.create_worktree.execute({
    branch: "feature/attach",
    baseRef: `refs/remotes/pull/7/head`,
  }, context);
  const registryPath =
    `${context.globalArgs.artifactRoot}/worktrees/index.json`;
  let registry = JSON.parse(await Deno.readTextFile(registryPath));

  const attached = await model.methods.attach_worktree.execute({
    worktreeId: registry[0].id,
    prNumber: 7,
  }, context);
  assertEquals(attached.match, true);
  assertEquals(attached.createdReason, "development");
  assertEquals(attached.worktreeId, development.worktreeId);
  assertEquals(attached.path, development.path);
  assertEquals(attached.branch, development.branch);
  assertEquals(attached.prNumber, 7);
  assertEquals(attached.worktreeHeadSha, headSha);
  assertEquals(attached.prHeadSha, headSha);
  registry = JSON.parse(await Deno.readTextFile(registryPath));
  assertEquals(registry[0].creationBaseRef, "refs/remotes/pull/7/head");
  assertEquals(registry[0].prLink.headShaAtAttachment, headSha);
  assertEquals(registry[0].prLink.mode, "explicit");
  await model.methods.detach_worktree.execute({
    worktreeId: registry[0].id,
  }, context);
  registry = JSON.parse(await Deno.readTextFile(registryPath));
  assertEquals(registry[0].createdReason, "development");
  assertEquals(registry[0].prLink, undefined);
  assertEquals(registry[0].autoAttachSuppressed, true);
  const refreshed = await model.methods.refresh_pr_worktrees.execute(
    {},
    context,
  );
  assertEquals(
    refreshed.actions.some((action) => action.action === "attached"),
    false,
  );
  registry = JSON.parse(await Deno.readTextFile(registryPath));
  assertEquals(registry[0].prLink, undefined);

  await Deno.writeTextFile(`${development.path}/dirty.txt`, "local\n");
  await assertRejects(
    () =>
      model.methods.remove_worktree.execute({
        worktreeId: registry[0].id,
        force: false,
        deleteBranch: false,
      }, context),
    Error,
    "local changes",
  );
  await model.methods.remove_worktree.execute({
    worktreeId: registry[0].id,
    force: true,
    deleteBranch: false,
  }, context);
  await assertRejects(() => Deno.stat(development.path), Deno.errors.NotFound);
});

Deno.test("refresh auto-attaches a first lineage and materializes it in the same run", async () => {
  const { root, context } = await tempContext();
  const oldHead = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    12,
  );
  const development = await model.methods.create_worktree.execute({
    branch: "feature/first-lineage",
    baseRef: "refs/remotes/pull/12/head",
  }, context);
  for (
    const [key, value] of [[
      "branch.feature/first-lineage.remote",
      "contributor",
    ], [
      "branch.feature/first-lineage.merge",
      "refs/heads/feature",
    ], [
      "remote.contributor.url",
      "git@github.com:contributor/repo.git",
    ]]
  ) {
    const configured = await new Deno.Command("git", {
      cwd: development.path,
      args: ["config", key, value],
    }).output();
    assertEquals(configured.code, 0);
  }
  const source = `${root}/source-12`;
  await Deno.writeTextFile(`${source}/README.md`, "new revision\n");
  const commit = await new Deno.Command("git", {
    cwd: source,
    args: ["commit", "-am", "new revision"],
    stderr: "piped",
  }).output();
  if (commit.code !== 0) {
    throw new Error(new TextDecoder().decode(commit.stderr));
  }
  const headOutput = await new Deno.Command("git", {
    cwd: source,
    args: ["rev-parse", "HEAD"],
    stdout: "piped",
  }).output();
  const newHead = new TextDecoder().decode(headOutput.stdout).trim();
  const fetch = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "fetch",
      source,
      "HEAD",
    ],
  }).output();
  assertEquals(fetch.code, 0);
  const update = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "update-ref",
      "refs/remotes/pull/12/head",
      newHead,
    ],
  }).output();
  assertEquals(update.code, 0);
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/12`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/prs/12/current.json`,
    JSON.stringify({
      number: 12,
      state: "open",
      merged: false,
      headSha: newHead,
      remoteName: "fork-contributor",
      headRef: "feature",
      headFullName: "contributor/repo",
      headSshUrl: "git@github.com:contributor/repo.git",
      observedAt: "2026-07-23T00:00:00.000Z",
    }),
  );

  const dryRun = await model.methods.refresh_pr_worktrees.execute({
    dryRun: true,
  }, context);
  assertEquals(dryRun.actions.map((action) => action.action), [
    "attached",
    "materialized",
  ]);
  let registry = JSON.parse(
    await Deno.readTextFile(
      `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    ),
  );
  assertEquals(registry[0].prLink, undefined);

  const result = await model.methods.refresh_pr_worktrees.execute({}, context);

  assertEquals(result.actions.map((action) => action.action), [
    "attached",
    "materialized",
  ]);
  registry = JSON.parse(
    await Deno.readTextFile(
      `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    ),
  );
  const automaticallyLinked = registry.find((record: { branch: string }) =>
    record.branch === "feature/first-lineage"
  );
  assertEquals(automaticallyLinked.creationBaseSha, oldHead);
  assertEquals(automaticallyLinked.prLink, {
    prNumber: 12,
    attachedAt: automaticallyLinked.prLink.attachedAt,
    headShaAtAttachment: newHead,
    mode: "automatic",
  });
  assertEquals(automaticallyLinked.revisionState, "superseded");
  assertEquals(
    registry.filter((record: { revisionState?: string }) =>
      record.revisionState === "current"
    ).length,
    1,
  );
});

Deno.test("create_worktree recovers a validated orphan after publication failure", async () => {
  const { root, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    13,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/13`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/prs/13/current.json`,
    JSON.stringify({
      number: 13,
      state: "open",
      merged: false,
      headSha,
      observedAt: "2026-07-23T00:00:00.000Z",
    }),
  );
  const writeResource = context.writeResource;
  let rejectSnapshot = true;
  context.writeResource = (specName, name, data) => {
    if (specName === "worktreeSnapshot" && rejectSnapshot) {
      rejectSnapshot = false;
      return Promise.reject(new Error("snapshot unavailable"));
    }
    return writeResource(specName, name, data);
  };

  await assertRejects(
    () => model.methods.create_worktree.execute({ prNumber: 13 }, context),
    Error,
    "snapshot unavailable",
  );
  await Deno.remove(
    `${context.globalArgs.artifactRoot}/worktrees/index.json`,
  );

  const recovered = await model.methods.create_worktree.execute({
    prNumber: 13,
  }, context);

  assertEquals((await Deno.stat(recovered.path)).isDirectory, true);
  const registry = JSON.parse(
    await Deno.readTextFile(
      `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    ),
  );
  assertEquals(registry.length, 1);
  assertEquals(registry[0].prLink.headShaAtAttachment, headSha);
});

Deno.test("create_worktree recovers an advanced development orphan", async () => {
  const { root, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    60,
  );
  const created = await model.methods.create_worktree.execute({
    branch: "feature/advanced-orphan",
    baseRef: "refs/remotes/pull/60/head",
  }, context);
  await Deno.remove(
    `${context.globalArgs.artifactRoot}/worktrees/index.json`,
  );
  for (
    const [key, value] of [["user.email", "test@example.com"], [
      "user.name",
      "Test",
    ], ["commit.gpgsign", "false"]]
  ) {
    await new Deno.Command("git", {
      cwd: created.path,
      args: ["config", key, value],
    }).output();
  }
  await Deno.writeTextFile(`${created.path}/README.md`, "advanced orphan\n");
  const commit = await new Deno.Command("git", {
    cwd: created.path,
    args: ["commit", "-am", "advance orphan"],
    stderr: "piped",
  }).output();
  assertEquals(commit.code, 0);

  const recovered = await model.methods.create_worktree.execute({
    branch: "feature/advanced-orphan",
    baseRef: "refs/remotes/pull/60/head",
  }, context);

  assertEquals(recovered.path, created.path);
  assertEquals(recovered.baseHeadSha, headSha);
  const registry = JSON.parse(
    await Deno.readTextFile(
      `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    ),
  );
  assertEquals(registry.length, 1);
  assertEquals(registry[0].creationBaseSha, headSha);
});

Deno.test("attach and detach replay intended registry state after snapshot failures", async () => {
  const { root, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    14,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/14`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/prs/14/current.json`,
    JSON.stringify({
      number: 14,
      headSha,
      observedAt: "2026-07-23T00:00:00.000Z",
    }),
  );
  await model.methods.create_worktree.execute({
    branch: "feature/replay-association",
    baseRef: "refs/remotes/pull/14/head",
  }, context);
  const registryPath =
    `${context.globalArgs.artifactRoot}/worktrees/index.json`;
  const worktreeId = JSON.parse(await Deno.readTextFile(registryPath))[0].id;
  const writeResource = context.writeResource;
  let rejectSnapshot = true;
  let failureNumber = 0;
  context.writeResource = (specName, name, data) => {
    if (specName === "worktreeSnapshot" && rejectSnapshot) {
      rejectSnapshot = false;
      failureNumber++;
      return Promise.reject(new Error(`snapshot failure ${failureNumber}`));
    }
    return writeResource(specName, name, data);
  };

  await assertRejects(
    () =>
      model.methods.attach_worktree.execute(
        { worktreeId, prNumber: 14 },
        context,
      ),
    Error,
    "snapshot failure 1",
  );
  const attachedAt = JSON.parse(await Deno.readTextFile(registryPath))[0].prLink
    .attachedAt;
  await model.methods.attach_worktree.execute({
    worktreeId,
    prNumber: 14,
  }, context);
  assertEquals(
    JSON.parse(await Deno.readTextFile(registryPath))[0].prLink.attachedAt,
    attachedAt,
  );

  rejectSnapshot = true;
  await assertRejects(
    () => model.methods.detach_worktree.execute({ worktreeId }, context),
    Error,
    "snapshot failure 2",
  );
  assertEquals(
    JSON.parse(await Deno.readTextFile(registryPath))[0].prLink,
    undefined,
  );
  await model.methods.detach_worktree.execute({ worktreeId }, context);
});

Deno.test("remove_worktree retries snapshot publication and branch deletion", async () => {
  const { root, context } = await tempContext();
  await createMirroredPrRef(root, context.globalArgs.gitObjectPath, 15);
  const worktree = await model.methods.create_worktree.execute({
    branch: "feature/remove-retry",
    baseRef: "refs/remotes/pull/15/head",
  }, context);
  const registryPath =
    `${context.globalArgs.artifactRoot}/worktrees/index.json`;
  const worktreeId = JSON.parse(await Deno.readTextFile(registryPath))[0].id;
  const writeResource = context.writeResource;
  let rejectSnapshot = true;
  context.writeResource = (specName, name, data) => {
    if (specName === "worktreeSnapshot" && rejectSnapshot) {
      rejectSnapshot = false;
      return Promise.reject(new Error("remove snapshot unavailable"));
    }
    return writeResource(specName, name, data);
  };

  await assertRejects(
    () =>
      model.methods.remove_worktree.execute({
        worktreeId,
        deleteBranch: true,
      }, context),
    Error,
    "remove snapshot unavailable",
  );
  await assertRejects(() => Deno.stat(worktree.path), Deno.errors.NotFound);
  assertEquals(
    JSON.parse(await Deno.readTextFile(registryPath))[0].filesystemState,
    "removed",
  );
  const retried = await model.methods.remove_worktree.execute({
    worktreeId,
    deleteBranch: true,
  }, context);
  assertEquals(retried.alreadyRemoved, true);
  const branch = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "show-ref",
      "--verify",
      "refs/heads/feature/remove-retry",
    ],
  }).output();
  assertEquals(branch.code === 0, false);
  const repeated = await model.methods.remove_worktree.execute({
    worktreeId,
    deleteBranch: true,
  }, context);
  assertEquals(repeated.alreadyRemoved, true);
  assertEquals(repeated.branchDeleted, true);
});

Deno.test("force removal tolerates an unavailable creation base", async () => {
  const { root, context } = await tempContext();
  await createMirroredPrRef(root, context.globalArgs.gitObjectPath, 17);
  const worktree = await model.methods.create_worktree.execute({
    branch: "feature/unavailable-base",
    baseRef: "refs/remotes/pull/17/head",
  }, context);
  const registryPath =
    `${context.globalArgs.artifactRoot}/worktrees/index.json`;
  const registry = JSON.parse(await Deno.readTextFile(registryPath));
  registry[0].creationBaseSha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  registry[0].baseHeadSha = registry[0].creationBaseSha;
  await Deno.writeTextFile(registryPath, JSON.stringify(registry));
  await Deno.writeTextFile(`${worktree.path}/untracked.txt`, "discard\n");

  const removed = await model.methods.remove_worktree.execute({
    worktreeId: worktree.worktreeId,
    force: true,
  }, context);

  assertEquals(removed.aheadCommitCount, 0);
  await assertRejects(() => Deno.stat(worktree.path), Deno.errors.NotFound);
});

Deno.test("force removal accepts a verified detached worktree", async () => {
  const { root, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    65,
  );
  const worktree = await model.methods.create_worktree.execute({
    branch: "feature/detached-removal",
    baseRef: "refs/remotes/pull/65/head",
  }, context);
  const detached = await new Deno.Command("git", {
    cwd: worktree.path,
    args: ["checkout", "--detach", headSha],
    stderr: "piped",
  }).output();
  assertEquals(detached.code, 0);

  await model.methods.remove_worktree.execute({
    worktreeId: worktree.worktreeId,
    force: true,
  }, context);

  await assertRejects(() => Deno.stat(worktree.path), Deno.errors.NotFound);
});

Deno.test("missing worktree cannot delete an ahead branch without force", async () => {
  const { root, context } = await tempContext();
  await createMirroredPrRef(root, context.globalArgs.gitObjectPath, 19);
  const worktree = await model.methods.create_worktree.execute({
    branch: "feature/missing-ahead",
    baseRef: "refs/remotes/pull/19/head",
  }, context);
  for (
    const [key, value] of [["user.email", "test@example.com"], [
      "user.name",
      "Test",
    ], ["commit.gpgsign", "false"]]
  ) {
    await new Deno.Command("git", {
      cwd: worktree.path,
      args: ["config", key, value],
    }).output();
  }
  await Deno.writeTextFile(`${worktree.path}/README.md`, "ahead\n");
  const commit = await new Deno.Command("git", {
    cwd: worktree.path,
    args: ["commit", "-am", "ahead"],
    stderr: "piped",
  }).output();
  assertEquals(commit.code, 0);
  const removal = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "worktree",
      "remove",
      worktree.path,
    ],
    stderr: "piped",
  }).output();
  assertEquals(removal.code, 0);

  await assertRejects(
    () =>
      model.methods.remove_worktree.execute({
        worktreeId: worktree.worktreeId,
        deleteBranch: true,
      }, context),
    Error,
    "1 local commits",
  );
  const branch = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "show-ref",
      "--verify",
      "refs/heads/feature/missing-ahead",
    ],
  }).output();
  assertEquals(branch.code, 0);

  const forced = await model.methods.remove_worktree.execute({
    worktreeId: worktree.worktreeId,
    deleteBranch: true,
    force: true,
  }, context);
  assertEquals(forced.branchDeleted, true);
});

Deno.test("branch deletion retains refs advanced after safety checks", async () => {
  const { root, context } = await tempContext();
  await createMirroredPrRef(root, context.globalArgs.gitObjectPath, 20);
  const worktree = await model.methods.create_worktree.execute({
    branch: "feature/concurrent-advance",
    baseRef: "refs/remotes/pull/20/head",
  }, context);
  const source = `${root}/source-20`;
  await Deno.writeTextFile(`${source}/README.md`, "external advance\n");
  const commit = await new Deno.Command("git", {
    cwd: source,
    args: ["commit", "-am", "external advance"],
    stderr: "piped",
  }).output();
  assertEquals(commit.code, 0);
  const head = await new Deno.Command("git", {
    cwd: source,
    args: ["rev-parse", "HEAD"],
    stdout: "piped",
  }).output();
  const externalHead = new TextDecoder().decode(head.stdout).trim();
  const fetch = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "fetch",
      source,
      "HEAD",
    ],
  }).output();
  assertEquals(fetch.code, 0);
  const originalWriteResource = context.writeResource;
  let advanceBranch = true;
  context.writeResource = async (specName, name, data) => {
    if (specName === "worktreeSnapshot" && advanceBranch) {
      advanceBranch = false;
      const update = await new Deno.Command("git", {
        args: [
          "--git-dir",
          context.globalArgs.gitObjectPath,
          "update-ref",
          "refs/heads/feature/concurrent-advance",
          externalHead,
        ],
      }).output();
      assertEquals(update.code, 0);
    }
    return await originalWriteResource(specName, name, data);
  };

  await assertRejects(
    () =>
      model.methods.remove_worktree.execute({
        worktreeId: worktree.worktreeId,
        deleteBranch: true,
        force: true,
      }, context),
    Error,
    "branch changed after safety checks and was retained",
  );
  const retained = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "rev-parse",
      "refs/heads/feature/concurrent-advance",
    ],
    stdout: "piped",
  }).output();
  assertEquals(new TextDecoder().decode(retained.stdout).trim(), externalHead);

  context.writeResource = originalWriteResource;
  const retried = await model.methods.remove_worktree.execute({
    worktreeId: worktree.worktreeId,
    deleteBranch: true,
    force: true,
  }, context);
  assertEquals(retried.alreadyRemoved, true);
  assertEquals(retried.branchDeleted, true);
});

Deno.test("refresh republishes only worktree snapshots marked pending", async () => {
  const { root, writes, context } = await tempContext();
  await createMirroredPrRef(root, context.globalArgs.gitObjectPath, 16);
  const worktree = await model.methods.create_worktree.execute({
    branch: "feature/pending-snapshot",
    baseRef: "refs/remotes/pull/16/head",
  }, context);
  const originalWriteResource = context.writeResource;
  context.writeResource = (specName, name, data) =>
    specName === "worktreeSnapshot"
      ? Promise.reject(new Error("snapshot unavailable"))
      : originalWriteResource(specName, name, data);

  await assertRejects(
    () =>
      model.methods.remove_worktree.execute({
        worktreeId: worktree.worktreeId,
      }, context),
    Error,
    "snapshot unavailable",
  );
  const registryPath =
    `${context.globalArgs.artifactRoot}/worktrees/index.json`;
  assertEquals(
    JSON.parse(await Deno.readTextFile(registryPath))[0].snapshotPending,
    true,
  );

  context.writeResource = originalWriteResource;
  writes.length = 0;
  const refreshed = await model.methods.refresh_pr_worktrees.execute(
    {},
    context,
  );

  assertEquals(refreshed.complete, true);
  assertEquals(
    writes.filter((write) => write.specName === "worktreeSnapshot").length,
    1,
  );
  assertEquals(
    JSON.parse(await Deno.readTextFile(registryPath))[0].snapshotPending,
    false,
  );
});

Deno.test("refresh is incomplete when development worktree inspection is skipped", async () => {
  const { root, context } = await tempContext();
  await createMirroredPrRef(root, context.globalArgs.gitObjectPath, 18);
  const worktree = await model.methods.create_worktree.execute({
    branch: "feature/missing-unlinked",
    baseRef: "refs/remotes/pull/18/head",
  }, context);
  const removal = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "worktree",
      "remove",
      worktree.path,
    ],
    stderr: "piped",
  }).output();
  assertEquals(removal.code, 0);

  const refreshed = await model.methods.refresh_pr_worktrees.execute(
    {},
    context,
  );

  assertEquals(refreshed.complete, false);
  assertEquals(refreshed.actions, [{
    action: "skipped",
    worktreeId: worktree.worktreeId,
    reason: "worktree-inspection-incomplete",
  }]);
});

Deno.test("analyze_worktrees reports ambiguous exact-head PR candidates", async () => {
  const { root, writes, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    1,
  );
  await model.methods.create_worktree.execute({
    branch: "feature/ambiguous",
    baseRef: "refs/remotes/pull/1/head",
  }, context);
  for (const number of [1, 2]) {
    await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/${number}`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${context.globalArgs.artifactRoot}/prs/${number}/current.json`,
      JSON.stringify({
        number,
        headSha,
        observedAt: "2026-07-23T00:00:00.000Z",
      }),
    );
  }
  writes.length = 0;

  await model.methods.analyze_worktrees.execute({}, context);

  assertEquals(writes[0].data.candidateAmbiguous, true);
  assertEquals(writes[0].data.candidatePrNumber, undefined);
  assertEquals(
    writes[0].data.recommendedAction,
    "choose-pull-request-manually",
  );
});

Deno.test("refresh_pr_worktrees preserves merged worktrees with local-only commits", async () => {
  const { root, writes, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    42,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/42`, {
    recursive: true,
  });
  const prPath = `${context.globalArgs.artifactRoot}/prs/42/current.json`;
  await Deno.writeTextFile(
    prPath,
    JSON.stringify({
      number: 42,
      state: "open",
      merged: false,
      headSha,
      observedAt: "2026-07-23T00:00:00.000Z",
    }),
  );
  const worktree = await model.methods.prepare_worktree.execute({
    prNumber: 42,
  }, context);
  for (
    const [key, value] of [["user.email", "test@example.com"], [
      "user.name",
      "Test",
    ], ["commit.gpgsign", "false"]]
  ) {
    await new Deno.Command("git", {
      cwd: worktree.path,
      args: ["config", key, value],
    }).output();
  }
  await Deno.writeTextFile(`${worktree.path}/README.md`, "local commit\n");
  await new Deno.Command("git", {
    cwd: worktree.path,
    args: ["commit", "-am", "local"],
  }).output();
  await Deno.writeTextFile(
    prPath,
    JSON.stringify({
      number: 42,
      state: "closed",
      merged: true,
      headSha,
      observedAt: "2026-07-23T01:00:00.000Z",
    }),
  );
  writes.length = 0;

  const result = await model.methods.refresh_pr_worktrees.execute({}, context);

  assertEquals(result.complete, true);
  assertEquals(result.actions[0], {
    action: "retained",
    worktreeId: worktree.worktreeId,
    prNumber: 42,
    reason: "worktree-has-local-only-commits",
  });
  assertEquals((await Deno.stat(worktree.path)).isDirectory, true);
  assertEquals(writes.at(-1)?.specName, "worktreeRefreshRun");
});

Deno.test("attach_worktree records the mirrored head when local HEAD is ahead", async () => {
  const { root, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    43,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/43`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/prs/43/current.json`,
    JSON.stringify({
      number: 43,
      state: "open",
      merged: false,
      headSha,
      observedAt: "2026-07-23T00:00:00.000Z",
    }),
  );
  const worktree = await model.methods.create_worktree.execute({
    branch: "feature/ahead-attachment",
    baseRef: "refs/remotes/pull/43/head",
  }, context);
  for (
    const [key, value] of [["user.email", "test@example.com"], [
      "user.name",
      "Test",
    ], ["commit.gpgsign", "false"]]
  ) {
    await new Deno.Command("git", {
      cwd: worktree.path,
      args: ["config", key, value],
    }).output();
  }
  await Deno.writeTextFile(`${worktree.path}/README.md`, "ahead\n");
  const commit = await new Deno.Command("git", {
    cwd: worktree.path,
    args: ["commit", "-am", "ahead"],
    stderr: "piped",
  }).output();
  assertEquals(commit.code, 0);

  const attached = await model.methods.attach_worktree.execute({
    worktreeId: worktree.worktreeId,
    prNumber: 43,
  }, context);

  assertEquals(attached.match, false);
  assertEquals(attached.prHeadSha, headSha);
  assertEquals(attached.worktreeHeadSha === headSha, false);
  let registry = JSON.parse(
    await Deno.readTextFile(
      `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    ),
  );
  assertEquals(registry[0].creationBaseSha, headSha);
  assertEquals(registry[0].prLink.headShaAtAttachment, headSha);
  assertEquals(registry[0].revisionState, "superseded");

  const refreshed = await model.methods.refresh_pr_worktrees.execute(
    {},
    context,
  );
  assertEquals(refreshed.complete, true);
  assertEquals(
    refreshed.actions.some((action) => action.action === "materialized"),
    false,
  );
  registry = JSON.parse(
    await Deno.readTextFile(
      `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    ),
  );
  assertEquals(registry[0].revisionState, "current");

  const attachedAt = registry[0].prLink.attachedAt;
  const localHeadSha = attached.worktreeHeadSha;
  const update = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "update-ref",
      "refs/remotes/pull/43/head",
      localHeadSha,
    ],
  }).output();
  assertEquals(update.code, 0);
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/prs/43/current.json`,
    JSON.stringify({
      number: 43,
      state: "open",
      merged: false,
      headSha: localHeadSha,
      observedAt: "2026-07-23T01:00:00.000Z",
    }),
  );

  const replayed = await model.methods.attach_worktree.execute({
    worktreeId: worktree.worktreeId,
    prNumber: 43,
  }, context);

  assertEquals(replayed.match, true);
  registry = JSON.parse(
    await Deno.readTextFile(
      `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    ),
  );
  assertEquals(registry[0].prLink.attachedAt, attachedAt);
  assertEquals(registry[0].prLink.headShaAtAttachment, localHeadSha);
  assertEquals(registry[0].revisionState, "current");
});

Deno.test("refresh recognizes an updated descendant with an exact identity", async () => {
  const { root, context } = await tempContext();
  const oldHead = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    61,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/61`, {
    recursive: true,
  });
  const prPath = `${context.globalArgs.artifactRoot}/prs/61/current.json`;
  await Deno.writeTextFile(
    prPath,
    JSON.stringify({
      number: 61,
      state: "open",
      merged: false,
      headSha: oldHead,
      observedAt: "2026-07-23T00:00:00.000Z",
    }),
  );
  const identity = "team\0a";
  const worktree = await model.methods.prepare_worktree.execute({
    prNumber: 61,
    identity,
  }, context);
  const source = `${root}/source-61`;
  await Deno.writeTextFile(`${source}/README.md`, "new PR revision\n");
  const upstreamCommit = await new Deno.Command("git", {
    cwd: source,
    args: ["commit", "-am", "new PR revision"],
    stderr: "piped",
  }).output();
  assertEquals(upstreamCommit.code, 0);
  const newHeadOutput = await new Deno.Command("git", {
    cwd: source,
    args: ["rev-parse", "HEAD"],
    stdout: "piped",
  }).output();
  const newHead = new TextDecoder().decode(newHeadOutput.stdout).trim();
  const fetch = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "fetch",
      source,
      "HEAD",
    ],
    stderr: "piped",
  }).output();
  assertEquals(fetch.code, 0);
  const update = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "update-ref",
      "refs/remotes/pull/61/head",
      newHead,
    ],
  }).output();
  assertEquals(update.code, 0);
  await Deno.writeTextFile(
    prPath,
    JSON.stringify({
      number: 61,
      state: "open",
      merged: false,
      headSha: newHead,
      observedAt: "2026-07-23T01:00:00.000Z",
    }),
  );
  const reset = await new Deno.Command("git", {
    cwd: worktree.path,
    args: ["reset", "--hard", newHead],
    stderr: "piped",
  }).output();
  assertEquals(reset.code, 0);
  for (
    const [key, value] of [["user.email", "test@example.com"], [
      "user.name",
      "Test",
    ], ["commit.gpgsign", "false"]]
  ) {
    await new Deno.Command("git", {
      cwd: worktree.path,
      args: ["config", key, value],
    }).output();
  }
  await Deno.writeTextFile(
    `${worktree.path}/README.md`,
    "local after update\n",
  );
  const localCommit = await new Deno.Command("git", {
    cwd: worktree.path,
    args: ["commit", "-am", "local after update"],
    stderr: "piped",
  }).output();
  assertEquals(localCommit.code, 0);

  const refreshed = await model.methods.refresh_pr_worktrees.execute({
    identity,
  }, context);

  assertEquals(refreshed.complete, true);
  assertEquals(
    refreshed.actions.some((action) => action.action === "materialized"),
    false,
  );
  const registry = JSON.parse(
    await Deno.readTextFile(
      `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    ),
  );
  assertEquals(registry.length, 1);
  assertEquals(registry[0].identity, identity);
  assertEquals(registry[0].revisionState, "current");
});

Deno.test("attach_worktree rejects a renamed or replaced checkout", async () => {
  const { root, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    57,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/57`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/prs/57/current.json`,
    JSON.stringify({
      number: 57,
      state: "open",
      merged: false,
      headSha,
      observedAt: "2026-07-23T00:00:00.000Z",
    }),
  );
  const worktree = await model.methods.create_worktree.execute({
    branch: "feature/renamed-before-attachment",
    baseRef: "refs/remotes/pull/57/head",
  }, context);
  const registryPath =
    `${context.globalArgs.artifactRoot}/worktrees/index.json`;
  const originalRegistry = await Deno.readTextFile(registryPath);
  const tamperedRegistry = JSON.parse(originalRegistry);
  tamperedRegistry[0].gitWorktreeId = "../escape";
  delete tamperedRegistry[0].gitWorktreeToken;
  await Deno.mkdir(`${context.globalArgs.gitObjectPath}/escape`);
  await Deno.writeTextFile(registryPath, JSON.stringify(tamperedRegistry));
  await assertRejects(
    () =>
      model.methods.attach_worktree.execute({
        worktreeId: worktree.worktreeId,
        prNumber: 57,
      }, context),
    Error,
    "invalid registered Git worktree ID",
  );
  await assertRejects(
    () => Deno.stat(`${context.globalArgs.gitObjectPath}/escape/swamp-token`),
    Deno.errors.NotFound,
  );
  await Deno.writeTextFile(registryPath, originalRegistry);
  const renamed = await new Deno.Command("git", {
    cwd: worktree.path,
    args: ["branch", "-m", "feature/renamed-externally"],
    stderr: "piped",
  }).output();
  assertEquals(renamed.code, 0);

  await assertRejects(
    () =>
      model.methods.attach_worktree.execute({
        worktreeId: worktree.worktreeId,
        prNumber: 57,
      }, context),
    Error,
    "path is not the expected registered Git worktree",
  );

  const restored = await new Deno.Command("git", {
    cwd: worktree.path,
    args: ["branch", "-m", "feature/renamed-before-attachment"],
    stderr: "piped",
  }).output();
  assertEquals(restored.code, 0);
  await Deno.rename(worktree.path, `${worktree.path}-moved`);
  await Deno.mkdir(worktree.path);
  const initialized = await new Deno.Command("git", {
    cwd: worktree.path,
    args: ["init"],
    stderr: "piped",
  }).output();
  assertEquals(initialized.code, 0);

  await assertRejects(
    () =>
      model.methods.attach_worktree.execute({
        worktreeId: worktree.worktreeId,
        prNumber: 57,
      }, context),
    Error,
    "path is not the expected registered Git worktree",
  );

  await Deno.remove(worktree.path, { recursive: true });
  await Deno.symlink(`${worktree.path}-moved`, worktree.path);
  await assertRejects(
    () =>
      model.methods.attach_worktree.execute({
        worktreeId: worktree.worktreeId,
        prNumber: 57,
      }, context),
    Error,
    "path is not the expected registered Git worktree",
  );
});

Deno.test("refresh retains closed unmerged lineages without materializing", async () => {
  const { root, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    48,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/48`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/prs/48/current.json`,
    JSON.stringify({
      number: 48,
      state: "closed",
      merged: false,
      headSha,
      observedAt: "2026-07-23T00:00:00.000Z",
    }),
  );
  const worktree = await model.methods.prepare_worktree.execute({
    prNumber: 48,
  }, context);

  const result = await model.methods.refresh_pr_worktrees.execute({}, context);

  assertEquals(result.complete, true);
  assertEquals(result.actions, [{
    action: "retained",
    worktreeId: worktree.worktreeId,
    prNumber: 48,
    reason: "pr-closed-unmerged",
  }]);
  assertEquals((await Deno.stat(worktree.path)).isDirectory, true);
});

Deno.test("refresh ignores inconsistent pull requests outside tracked scope", async () => {
  const { root, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    49,
  );
  for (const number of [49, 999]) {
    await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/${number}`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${context.globalArgs.artifactRoot}/prs/${number}/current.json`,
      JSON.stringify({
        number,
        state: "open",
        merged: false,
        headSha,
        observedAt: "2026-07-23T00:00:00.000Z",
      }),
    );
  }
  await model.methods.prepare_worktree.execute({ prNumber: 49 }, context);

  const result = await model.methods.refresh_pr_worktrees.execute({}, context);

  assertEquals(result.complete, true);
  assertEquals(
    result.actions.some((action) => action.prNumber === 999),
    false,
  );
});

Deno.test("refresh preserves ambiguity across open and closed PR matches", async () => {
  const { root, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    50,
  );
  const worktree = await model.methods.create_worktree.execute({
    branch: "feature/mixed-ambiguity",
    baseRef: "refs/remotes/pull/50/head",
  }, context);
  for (const [number, state] of [[50, "open"], [51, "closed"]] as const) {
    await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/${number}`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${context.globalArgs.artifactRoot}/prs/${number}/current.json`,
      JSON.stringify({
        number,
        state,
        merged: false,
        headSha,
        observedAt: "2026-07-23T00:00:00.000Z",
      }),
    );
  }

  const result = await model.methods.refresh_pr_worktrees.execute({}, context);

  assertEquals(result.actions, [{
    action: "skipped",
    worktreeId: worktree.worktreeId,
    reason: "ambiguous-pr-match",
  }]);
  const registry = JSON.parse(
    await Deno.readTextFile(
      `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    ),
  );
  assertEquals(registry[0].prLink, undefined);
});

Deno.test("refresh dry-run reports missing merged worktree reconciliation without mutation", async () => {
  const { root, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    44,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/44`, {
    recursive: true,
  });
  const prPath = `${context.globalArgs.artifactRoot}/prs/44/current.json`;
  await Deno.writeTextFile(
    prPath,
    JSON.stringify({
      number: 44,
      state: "open",
      merged: false,
      headSha,
      observedAt: "2026-07-23T00:00:00.000Z",
    }),
  );
  const worktree = await model.methods.prepare_worktree.execute({
    prNumber: 44,
  }, context);
  const removed = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "worktree",
      "remove",
      worktree.path,
    ],
    stderr: "piped",
  }).output();
  if (removed.code !== 0) {
    throw new Error(new TextDecoder().decode(removed.stderr));
  }
  await Deno.writeTextFile(
    prPath,
    JSON.stringify({
      number: 44,
      state: "closed",
      merged: true,
      headSha,
      observedAt: "2026-07-23T01:00:00.000Z",
    }),
  );
  const registryPath =
    `${context.globalArgs.artifactRoot}/worktrees/index.json`;

  const dryRun = await model.methods.refresh_pr_worktrees.execute({
    dryRun: true,
  }, context);

  assertEquals(dryRun.actions, [{
    action: "removed",
    worktreeId: JSON.parse(await Deno.readTextFile(registryPath))[0].id,
    prNumber: 44,
    reason: "worktree-already-missing",
  }]);
  assertEquals(
    JSON.parse(await Deno.readTextFile(registryPath))[0].filesystemState,
    "active",
  );

  await model.methods.refresh_pr_worktrees.execute({}, context);
  assertEquals(
    JSON.parse(await Deno.readTextFile(registryPath))[0].filesystemState,
    "removed",
  );
});

Deno.test("refresh does not report a locked merged worktree as removed", async () => {
  const { root, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    58,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/58`, {
    recursive: true,
  });
  const prPath = `${context.globalArgs.artifactRoot}/prs/58/current.json`;
  await Deno.writeTextFile(
    prPath,
    JSON.stringify({
      number: 58,
      state: "open",
      merged: false,
      headSha,
      observedAt: "2026-07-23T00:00:00.000Z",
    }),
  );
  const worktree = await model.methods.prepare_worktree.execute({
    prNumber: 58,
  }, context);
  const locked = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "worktree",
      "lock",
      worktree.path,
    ],
    stderr: "piped",
  }).output();
  assertEquals(locked.code, 0);
  await Deno.writeTextFile(
    prPath,
    JSON.stringify({
      number: 58,
      state: "closed",
      merged: true,
      headSha,
      observedAt: "2026-07-23T01:00:00.000Z",
    }),
  );

  const result = await model.methods.refresh_pr_worktrees.execute({}, context);

  assertEquals(result.complete, false);
  assertEquals(result.actions.map((action) => action.action), ["failed"]);
  assertEquals((await Deno.stat(worktree.path)).isDirectory, true);
  assertEquals(
    JSON.parse(
      await Deno.readTextFile(
        `${context.globalArgs.artifactRoot}/worktrees/index.json`,
      ),
    )[0].filesystemState,
    "active",
  );
});

Deno.test("refresh does not remove a replacement checkout", async () => {
  const { root, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    64,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/64`, {
    recursive: true,
  });
  const prPath = `${context.globalArgs.artifactRoot}/prs/64/current.json`;
  await Deno.writeTextFile(
    prPath,
    JSON.stringify({
      number: 64,
      state: "open",
      merged: false,
      headSha,
      observedAt: "2026-07-23T00:00:00.000Z",
    }),
  );
  const original = await model.methods.prepare_worktree.execute({
    prNumber: 64,
  }, context);
  const removeOriginal = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "worktree",
      "remove",
      original.path,
    ],
    stderr: "piped",
  }).output();
  assertEquals(removeOriginal.code, 0);
  const branch = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "branch",
      "replacement",
      headSha,
    ],
  }).output();
  assertEquals(branch.code, 0);
  const addReplacement = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "worktree",
      "add",
      original.path,
      "replacement",
    ],
    stderr: "piped",
  }).output();
  assertEquals(addReplacement.code, 0);
  const detachReplacement = await new Deno.Command("git", {
    cwd: original.path,
    args: ["checkout", "--detach", headSha],
    stderr: "piped",
  }).output();
  assertEquals(detachReplacement.code, 0);
  await Deno.writeTextFile(
    prPath,
    JSON.stringify({
      number: 64,
      state: "closed",
      merged: true,
      headSha,
      observedAt: "2026-07-23T01:00:00.000Z",
    }),
  );

  const result = await model.methods.refresh_pr_worktrees.execute({}, context);

  assertEquals(result.complete, false);
  assertEquals(result.actions.map((action) => action.action), ["failed"]);
  assertEquals((await Deno.stat(original.path)).isDirectory, true);
  const replacementHead = await new Deno.Command("git", {
    cwd: original.path,
    args: ["rev-parse", "HEAD"],
    stdout: "piped",
  }).output();
  assertEquals(
    new TextDecoder().decode(replacementHead.stdout).trim(),
    headSha,
  );
});

Deno.test("refresh retries materialization after worktree creation fails", async () => {
  const { root, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    62,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/62`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/prs/62/current.json`,
    JSON.stringify({
      number: 62,
      state: "open",
      merged: false,
      headSha,
      observedAt: "2026-07-23T00:00:00.000Z",
    }),
  );
  const worktree = await model.methods.prepare_worktree.execute({
    prNumber: 62,
  }, context);
  const removed = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "worktree",
      "remove",
      worktree.path,
    ],
    stderr: "piped",
  }).output();
  assertEquals(removed.code, 0);
  await Deno.chmod(context.globalArgs.workspaceRoot, 0o500);
  let failed;
  try {
    failed = await model.methods.refresh_pr_worktrees.execute({}, context);
  } finally {
    await Deno.chmod(context.globalArgs.workspaceRoot, 0o700);
  }
  assertEquals(failed.complete, false);
  assertEquals(failed.actions.at(-1)?.reason, "materialization-failed");
  let registry = JSON.parse(
    await Deno.readTextFile(
      `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    ),
  );
  assertEquals(registry[0].filesystemState, "removed");
  assertEquals(registry[0].materializationPending, true);

  const retried = await model.methods.refresh_pr_worktrees.execute({}, context);

  assertEquals(retried.complete, true);
  assertEquals(
    retried.actions.some((action) => action.action === "materialized"),
    true,
  );
  registry = JSON.parse(
    await Deno.readTextFile(
      `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    ),
  );
  assertEquals(
    registry.filter((record: { filesystemState: string }) =>
      record.filesystemState === "active"
    ).length,
    1,
  );
  assertEquals(
    registry.some((record: { materializationPending?: boolean }) =>
      record.materializationPending === true
    ),
    false,
  );
});

Deno.test("refresh rematerializes an unchanged current PR after its worktree vanishes", async () => {
  const { root, writes, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    45,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/45`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/prs/45/current.json`,
    JSON.stringify({
      number: 45,
      state: "open",
      merged: false,
      headSha,
      observedAt: "2026-07-23T00:00:00.000Z",
    }),
  );
  const original = await model.methods.prepare_worktree.execute({
    prNumber: 45,
  }, context);
  const removed = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "worktree",
      "remove",
      original.path,
    ],
    stderr: "piped",
  }).output();
  if (removed.code !== 0) {
    throw new Error(new TextDecoder().decode(removed.stderr));
  }
  writes.length = 0;

  const result = await model.methods.refresh_pr_worktrees.execute({}, context);

  assertEquals(result.actions.map((action) => action.action), [
    "removed",
    "materialized",
  ]);
  const registry = JSON.parse(
    await Deno.readTextFile(
      `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    ),
  );
  assertEquals(registry.length, 1);
  assertEquals(registry[0].filesystemState, "active");
  assertEquals(registry[0].prLink.headShaAtAttachment, headSha);
  assertEquals((await Deno.stat(registry[0].path)).isDirectory, true);
  const snapshots = writes.filter((write) =>
    write.specName === "worktreeSnapshot" && write.name === registry[0].id
  );
  assertEquals(snapshots.at(-1)?.data.filesystemState, "active");
});

Deno.test("refresh does not recreate explicitly removed open PR worktrees", async () => {
  const { root, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    53,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/53`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/prs/53/current.json`,
    JSON.stringify({
      number: 53,
      state: "open",
      merged: false,
      headSha,
      observedAt: "2026-07-23T00:00:00.000Z",
    }),
  );
  const worktree = await model.methods.prepare_worktree.execute({
    prNumber: 53,
  }, context);
  await model.methods.remove_worktree.execute({
    worktreeId: worktree.worktreeId,
  }, context);

  const result = await model.methods.refresh_pr_worktrees.execute({}, context);

  assertEquals(
    result.actions.some((action) => action.action === "materialized"),
    false,
  );
  const registry = JSON.parse(
    await Deno.readTextFile(
      `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    ),
  );
  assertEquals(registry.length, 1);
  assertEquals(registry[0].filesystemState, "removed");
});

Deno.test("refresh preserves partial materialization for snapshot retry", async () => {
  const { root, writes, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    54,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/54`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/prs/54/current.json`,
    JSON.stringify({
      number: 54,
      state: "open",
      merged: false,
      headSha,
      observedAt: "2026-07-23T00:00:00.000Z",
    }),
  );
  const original = await model.methods.prepare_worktree.execute({
    prNumber: 54,
  }, context);
  const removed = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "worktree",
      "remove",
      original.path,
    ],
    stderr: "piped",
  }).output();
  assertEquals(removed.code, 0);
  const originalWriteResource = context.writeResource;
  let rejectActiveSnapshot = true;
  context.writeResource = (specName, name, data) => {
    if (
      specName === "worktreeSnapshot" && data.filesystemState === "active" &&
      rejectActiveSnapshot
    ) {
      rejectActiveSnapshot = false;
      return Promise.reject(new Error("active snapshot unavailable"));
    }
    return originalWriteResource(specName, name, data);
  };

  const failed = await model.methods.refresh_pr_worktrees.execute({}, context);

  assertEquals(failed.complete, false);
  assertEquals(failed.actions.at(-1)?.reason, "materialization-failed");
  const registryPath =
    `${context.globalArgs.artifactRoot}/worktrees/index.json`;
  let registry = JSON.parse(await Deno.readTextFile(registryPath));
  assertEquals(registry.length, 1);
  assertEquals(registry[0].filesystemState, "active");
  assertEquals(registry[0].snapshotPending, true);
  assertEquals((await Deno.stat(registry[0].path)).isDirectory, true);

  context.writeResource = originalWriteResource;
  writes.length = 0;
  const retried = await model.methods.refresh_pr_worktrees.execute({}, context);

  assertEquals(retried.complete, true);
  assertEquals(
    retried.actions.some((action) => action.action === "materialized"),
    false,
  );
  registry = JSON.parse(await Deno.readTextFile(registryPath));
  assertEquals(registry[0].snapshotPending, false);
  assertEquals(
    writes.filter((write) => write.specName === "worktreeSnapshot").at(-1)?.data
      .filesystemState,
    "active",
  );
});

Deno.test("refresh isolates malformed PR artifacts", async () => {
  const { root, writes, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    63,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/63`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/prs/63/current.json`,
    JSON.stringify({
      number: 63,
      state: "open",
      merged: false,
      headSha,
      observedAt: "2026-07-23T00:00:00.000Z",
    }),
  );
  await model.methods.prepare_worktree.execute({ prNumber: 63 }, context);
  const development = await model.methods.create_worktree.execute({
    branch: "feature/malformed-artifact",
    baseRef: "refs/remotes/pull/63/head",
  }, context);
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/999`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/prs/999/current.json`,
    JSON.stringify({
      number: 999,
      headSha: 42,
      observedAt: "2026-07-23T00:00:00.000Z",
    }),
  );

  const refreshed = await model.methods.refresh_pr_worktrees.execute(
    {},
    context,
  );

  assertEquals(refreshed.complete, false);
  assertEquals(
    refreshed.actions.some((action) =>
      action.reason === "pr-artifact-unreadable" && action.prNumber === 999
    ),
    true,
  );
  assertEquals(
    refreshed.actions.some((action) =>
      action.worktreeId === development.worktreeId &&
      action.reason === "pr-candidate-set-incomplete"
    ),
    true,
  );
  const registry = JSON.parse(
    await Deno.readTextFile(
      `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    ),
  );
  assertEquals(
    registry.find((record: { id: string }) =>
      record.id === development.worktreeId
    ).prLink,
    undefined,
  );

  writes.length = 0;
  await model.methods.analyze_worktrees.execute({}, context);
  const analysis = writes.find((write) =>
    write.specName === "worktreeAnalysis" &&
    write.name === development.worktreeId
  );
  assertEquals(analysis?.data.analysisComplete, false);
  assertStringIncludes(
    (analysis?.data.errors as string[]).join("\n"),
    "PR 999 artifact unreadable",
  );
});

Deno.test("refresh rejects metadata and local ref PR head divergence", async () => {
  for (const divergence of ["metadata-ahead", "ref-ahead"] as const) {
    const { root, context } = await tempContext();
    const oldHead = await createMirroredPrRef(
      root,
      context.globalArgs.gitObjectPath,
      46,
    );
    await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/46`, {
      recursive: true,
    });
    const prPath = `${context.globalArgs.artifactRoot}/prs/46/current.json`;
    await Deno.writeTextFile(
      prPath,
      JSON.stringify({
        number: 46,
        state: "open",
        merged: false,
        headSha: oldHead,
        observedAt: "2026-07-23T00:00:00.000Z",
      }),
    );
    await model.methods.prepare_worktree.execute({ prNumber: 46 }, context);
    const source = `${root}/source-46`;
    await Deno.writeTextFile(`${source}/README.md`, `${divergence}\n`);
    const commit = await new Deno.Command("git", {
      cwd: source,
      args: ["commit", "-am", divergence],
      stderr: "piped",
    }).output();
    if (commit.code !== 0) {
      throw new Error(new TextDecoder().decode(commit.stderr));
    }
    const head = await new Deno.Command("git", {
      cwd: source,
      args: ["rev-parse", "HEAD"],
      stdout: "piped",
    }).output();
    const newHead = new TextDecoder().decode(head.stdout).trim();
    const fetch = await new Deno.Command("git", {
      args: [
        "--git-dir",
        context.globalArgs.gitObjectPath,
        "fetch",
        source,
        "HEAD",
      ],
    }).output();
    assertEquals(fetch.code, 0);
    if (divergence === "metadata-ahead") {
      await Deno.writeTextFile(
        prPath,
        JSON.stringify({
          number: 46,
          state: "open",
          merged: false,
          headSha: newHead,
          observedAt: "2026-07-23T01:00:00.000Z",
        }),
      );
    } else {
      const update = await new Deno.Command("git", {
        args: [
          "--git-dir",
          context.globalArgs.gitObjectPath,
          "update-ref",
          "refs/remotes/pull/46/head",
          newHead,
        ],
      }).output();
      assertEquals(update.code, 0);
    }
    const registryPath =
      `${context.globalArgs.artifactRoot}/worktrees/index.json`;
    const before = await Deno.readTextFile(registryPath);

    const result = await model.methods.refresh_pr_worktrees.execute(
      {},
      context,
    );

    assertEquals(result.complete, false);
    assertEquals(result.actions[0].reason, "pr-head-inconsistent");
    assertStringIncludes(result.actions[0].error ?? "", "does not match");
    assertEquals(await Deno.readTextFile(registryPath), before);
    assertEquals(
      result.actions.some((action) => action.action === "materialized"),
      false,
    );
  }
});

Deno.test("refresh publishes auto-attachment and merged removal snapshots", async () => {
  const { root, writes, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    47,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/47`, {
    recursive: true,
  });
  const prPath = `${context.globalArgs.artifactRoot}/prs/47/current.json`;
  await Deno.writeTextFile(
    prPath,
    JSON.stringify({
      number: 47,
      state: "open",
      merged: false,
      headSha,
      observedAt: "2026-07-23T00:00:00.000Z",
    }),
  );
  await model.methods.prepare_worktree.execute({ prNumber: 47 }, context);
  await model.methods.create_worktree.execute({
    branch: "feature/merged-autoattach",
    baseRef: "refs/remotes/pull/47/head",
  }, context);
  const registryPath =
    `${context.globalArgs.artifactRoot}/worktrees/index.json`;
  const developmentId = JSON.parse(await Deno.readTextFile(registryPath)).find(
    (record: { branch: string }) =>
      record.branch === "feature/merged-autoattach",
  ).id;
  await Deno.writeTextFile(
    prPath,
    JSON.stringify({
      number: 47,
      state: "closed",
      merged: true,
      headSha,
      observedAt: "2026-07-23T01:00:00.000Z",
    }),
  );
  writes.length = 0;

  const result = await model.methods.refresh_pr_worktrees.execute({}, context);

  assertEquals(result.complete, true);
  const developmentSnapshots = writes.filter((write) =>
    write.specName === "worktreeSnapshot" && write.name === developmentId
  );
  assertEquals(developmentSnapshots.length, 2);
  assertEquals(
    (developmentSnapshots[0].data.prLink as Record<string, unknown>).mode,
    "automatic",
  );
  assertEquals(developmentSnapshots[0].data.filesystemState, "active");
  assertEquals(developmentSnapshots[1].data.filesystemState, "removed");
});

Deno.test("refresh_pr_worktrees supersedes and materializes one current revision", async () => {
  const { root, context } = await tempContext();
  const oldHead = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    9,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/9`, {
    recursive: true,
  });
  const prPath = `${context.globalArgs.artifactRoot}/prs/9/current.json`;
  await Deno.writeTextFile(
    prPath,
    JSON.stringify({
      number: 9,
      state: "open",
      merged: false,
      headSha: oldHead,
      observedAt: "2026-07-23T00:00:00.000Z",
    }),
  );
  await model.methods.prepare_worktree.execute({ prNumber: 9 }, context);
  const source = `${root}/source-9`;
  await Deno.writeTextFile(`${source}/README.md`, "new revision\n");
  const commit = await new Deno.Command("git", {
    cwd: source,
    args: ["commit", "-am", "new revision"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (commit.code !== 0) {
    throw new Error(new TextDecoder().decode(commit.stderr));
  }
  const headOutput = await new Deno.Command("git", {
    cwd: source,
    args: ["rev-parse", "HEAD"],
    stdout: "piped",
  }).output();
  const newHead = new TextDecoder().decode(headOutput.stdout).trim();
  const fetch = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "fetch",
      source,
      "HEAD",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(fetch.code, 0);
  const update = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "update-ref",
      "refs/remotes/pull/9/head",
      newHead,
    ],
  }).output();
  assertEquals(update.code, 0);
  await Deno.writeTextFile(
    prPath,
    JSON.stringify({
      number: 9,
      state: "open",
      merged: false,
      headSha: newHead,
      observedAt: "2026-07-23T01:00:00.000Z",
    }),
  );

  const first = await model.methods.refresh_pr_worktrees.execute({}, context);
  const second = await model.methods.refresh_pr_worktrees.execute({}, context);

  assertEquals(
    first.actions.some((action) => action.action === "materialized"),
    true,
  );
  assertEquals(
    second.actions.some((action) => action.action === "materialized"),
    false,
  );
  let registry = JSON.parse(
    await Deno.readTextFile(
      `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    ),
  );
  assertEquals(
    registry.filter((record: { revisionState?: string }) =>
      record.revisionState === "current"
    ).length,
    1,
  );
  assertEquals(
    registry.filter((record: { revisionState?: string }) =>
      record.revisionState === "superseded"
    ).length,
    1,
  );

  const revertRef = await new Deno.Command("git", {
    args: [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "update-ref",
      "refs/remotes/pull/9/head",
      oldHead,
    ],
  }).output();
  assertEquals(revertRef.code, 0);
  await Deno.writeTextFile(
    prPath,
    JSON.stringify({
      number: 9,
      state: "open",
      merged: false,
      headSha: oldHead,
      observedAt: "2026-07-23T02:00:00.000Z",
    }),
  );

  const reverted = await model.methods.refresh_pr_worktrees.execute(
    {},
    context,
  );

  assertEquals(
    reverted.actions.some((action) => action.action === "current"),
    true,
  );
  registry = JSON.parse(
    await Deno.readTextFile(
      `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    ),
  );
  assertEquals(
    registry.find((record: { prLink?: { headShaAtAttachment?: string } }) =>
      record.prLink?.headShaAtAttachment === oldHead
    ).revisionState,
    "current",
  );
});

Deno.test("close_merged_worktrees continues after dirty worktrees and retains branches", async () => {
  const { root, writes, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    42,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/42`, {
    recursive: true,
  });
  const prRecordPath = `${context.globalArgs.artifactRoot}/prs/42/current.json`;
  await Deno.writeTextFile(
    prRecordPath,
    JSON.stringify({
      number: 42,
      state: "open",
      merged: false,
      headSha,
      observedAt: "2026-07-22T00:00:00.000Z",
    }),
  );
  const dirty = await model.methods.prepare_worktree.execute({
    prNumber: 42,
    identity: "dirty",
  }, context);
  const clean = await model.methods.prepare_worktree.execute({
    prNumber: 42,
    identity: "clean",
  }, context);
  await Deno.writeTextFile(`${dirty.path}/untracked.txt`, "keep me\n");
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
  await run(clean.path, ["config", "user.email", "test@example.com"]);
  await run(clean.path, ["config", "user.name", "Test"]);
  await run(clean.path, ["config", "commit.gpgsign", "false"]);
  await Deno.writeTextFile(`${clean.path}/README.md`, "local commit\n");
  await run(clean.path, ["add", "README.md"]);
  await run(clean.path, ["commit", "-m", "local review commit"]);
  const localCommit = await run(clean.path, ["rev-parse", "HEAD"]);
  await Deno.writeTextFile(
    prRecordPath,
    JSON.stringify({
      number: 42,
      state: "closed",
      merged: true,
      headSha,
      observedAt: "2026-07-22T01:00:00.000Z",
    }),
  );
  writes.length = 0;

  const result = await model.methods.close_merged_worktrees.execute(
    {},
    context,
  );

  assertEquals(result.complete, false);
  assertEquals(result.candidateCount, 2);
  assertEquals(result.removedCount, 1);
  assertEquals(result.failedCount, 1);
  assertEquals(result.results[0].outcome, "failed");
  assertEquals(result.results[1].outcome, "removed");
  assertEquals(result.results[1].stateRecorded, true);
  assertEquals((await Deno.stat(dirty.path)).isDirectory, true);
  await assertRejects(() => Deno.stat(clean.path), Deno.errors.NotFound);
  assertEquals(
    await run(root, [
      "--git-dir",
      context.globalArgs.gitObjectPath,
      "rev-parse",
      clean.branch,
    ]),
    localCommit,
  );
  const registry = JSON.parse(
    await Deno.readTextFile(
      `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    ),
  );
  assertEquals(registry[0].status, "active");
  assertEquals(registry[1].status, "removed");
  assertEquals(writes.at(-1)?.specName, "worktreeCleanupRun");

  writes.length = 0;
  await model.methods.analyze_worktrees.execute({}, context);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].data.worktreeId, registry[0].id);
});

Deno.test("close_merged_worktrees skips pull requests that were not merged", async () => {
  const { root, writes, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    42,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/42`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/prs/42/current.json`,
    JSON.stringify({
      number: 42,
      state: "closed",
      merged: false,
      headSha,
      observedAt: "2026-07-22T00:00:00.000Z",
    }),
  );
  const worktree = await model.methods.prepare_worktree.execute({
    prNumber: 42,
  }, context);
  writes.length = 0;

  const result = await model.methods.close_merged_worktrees.execute(
    {},
    context,
  );

  assertEquals(result.complete, true);
  assertEquals(result.candidateCount, 0);
  assertEquals(result.skippedCount, 1);
  assertEquals(result.results[0].reason, "pr-not-merged");
  assertEquals((await Deno.stat(worktree.path)).isDirectory, true);
});

Deno.test("close_merged_worktrees preserves ignored files", async () => {
  const { root, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    42,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/42`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/prs/42/current.json`,
    JSON.stringify({
      number: 42,
      state: "closed",
      merged: true,
      headSha,
      observedAt: "2026-07-22T00:00:00.000Z",
    }),
  );
  const worktree = await model.methods.prepare_worktree.execute({
    prNumber: 42,
  }, context);
  await Deno.writeTextFile(
    `${context.globalArgs.gitObjectPath}/info/exclude`,
    "ignored.local\n",
  );
  await Deno.writeTextFile(`${worktree.path}/ignored.local`, "keep me\n");

  const result = await model.methods.close_merged_worktrees.execute(
    {},
    context,
  );

  assertEquals(result.complete, false);
  assertEquals(result.removedCount, 0);
  assertEquals(result.failedCount, 1);
  assertStringIncludes(result.results[0].error ?? "", "ignored.local");
  assertEquals(
    (await Deno.stat(`${worktree.path}/ignored.local`)).isFile,
    true,
  );
});

Deno.test("close_merged_worktrees preserves unreferenced detached commits", async () => {
  const { root, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    42,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/42`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/prs/42/current.json`,
    JSON.stringify({
      number: 42,
      state: "closed",
      merged: true,
      headSha,
      observedAt: "2026-07-22T00:00:00.000Z",
    }),
  );
  const worktree = await model.methods.prepare_worktree.execute({
    prNumber: 42,
  }, context);
  const run = async (args: string[]) => {
    const out = await new Deno.Command("git", {
      cwd: worktree.path,
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (out.code !== 0) throw new Error(new TextDecoder().decode(out.stderr));
  };
  await run(["config", "user.email", "test@example.com"]);
  await run(["config", "user.name", "Test"]);
  await run(["config", "commit.gpgsign", "false"]);
  await run(["checkout", "--detach"]);
  await Deno.writeTextFile(`${worktree.path}/README.md`, "detached commit\n");
  await run(["add", "README.md"]);
  await run(["commit", "-m", "detached review commit"]);

  const result = await model.methods.close_merged_worktrees.execute(
    {},
    context,
  );

  assertEquals(result.complete, false);
  assertEquals(result.removedCount, 0);
  assertStringIncludes(
    result.results[0].error ?? "",
    "detached HEAD contains commits",
  );
  assertEquals((await Deno.stat(worktree.path)).isDirectory, true);
});

Deno.test("close_merged_worktrees recovers when snapshot recording fails", async () => {
  const { root, context } = await tempContext();
  const headSha = await createMirroredPrRef(
    root,
    context.globalArgs.gitObjectPath,
    42,
  );
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/prs/42`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/prs/42/current.json`,
    JSON.stringify({
      number: 42,
      state: "closed",
      merged: true,
      headSha,
      observedAt: "2026-07-22T00:00:00.000Z",
    }),
  );
  const worktree = await model.methods.prepare_worktree.execute({
    prNumber: 42,
  }, context);
  const writeResource = context.writeResource;
  let rejectSnapshot = true;
  context.writeResource = (specName, name, data) => {
    if (specName === "worktreeSnapshot" && rejectSnapshot) {
      rejectSnapshot = false;
      return Promise.reject(new Error("snapshot store unavailable"));
    }
    return writeResource(specName, name, data);
  };

  const interrupted = await model.methods.close_merged_worktrees.execute(
    {},
    context,
  );

  assertEquals(interrupted.complete, false);
  assertEquals(interrupted.results[0].outcome, "removed");
  assertEquals(interrupted.results[0].stateRecorded, false);
  await assertRejects(() => Deno.stat(worktree.path), Deno.errors.NotFound);
  let registry = JSON.parse(
    await Deno.readTextFile(
      `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    ),
  );
  assertEquals(registry[0].status, "active");

  const recovered = await model.methods.close_merged_worktrees.execute(
    {},
    context,
  );

  assertEquals(recovered.complete, true);
  assertEquals(recovered.results[0].reason, "worktree-already-missing");
  assertEquals(recovered.results[0].stateRecorded, true);
  registry = JSON.parse(
    await Deno.readTextFile(
      `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    ),
  );
  assertEquals(registry[0].status, "removed");
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
  assertEquals(parsed.reviewerHandles, []);
  assertEquals(parsed.reviewFocusStaleDays, 14);
  assertEquals(parsed.needsClarificationLabels, [
    "needs-info",
    "needs-information",
    "needs-clarification",
  ]);
  assertEquals(
    model.globalArguments.safeParse({ ...parsed, maxApiPages: 0 }).success,
    false,
  );
  assertEquals(
    model.globalArguments.safeParse({ ...parsed, gitRemote: "pull" }).success,
    true,
  );
  assertEquals(
    model.globalArguments.safeParse({ ...parsed, gitRemote: "pull/custom" })
      .success,
    true,
  );
  assertEquals(
    model.globalArguments.safeParse({ ...parsed, reviewFocusStaleDays: 0 })
      .success,
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

  assertEquals(prResult.dataHandles.length, 1);
  assertEquals(prResult.subject.headSha, headSha);
  assertEquals(issueResult.dataHandles.length, 1);
  assertEquals(issueResult.subject.number, 8);
  assertEquals(writes.map((write) => write.specName), [
    "reviewSelection",
    "reviewSelection",
  ]);
  assertEquals(writes.at(-1)?.data.subjectType, "issue");
  assertEquals(writes.at(-1)?.data.subjectNumber, 8);
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

Deno.test("sync writes unique collection statuses when its budget expires", async () => {
  const { root, writes, context } = await tempContext();
  const upstream = `${root}/upstream.git`;
  const headSha = await createMirroredPrRef(root, upstream, 1);
  const init = await new Deno.Command("git", {
    args: ["init", "--bare", context.globalArgs.gitObjectPath],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (init.code !== 0) {
    throw new Error(new TextDecoder().decode(init.stderr));
  }
  Object.assign(context.globalArgs, { gitRemoteUrl: upstream });

  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  let fakeNow = originalDateNow();
  Date.now = () => fakeNow;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url,
    );
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/repos/owner/repo") {
      return json({ default_branch: "main" });
    }
    if (url.pathname === "/repos/owner/repo/pulls") {
      return json([{ number: 1, updated_at: "2099-07-20T00:00:00Z" }]);
    }
    if (url.pathname === "/repos/owner/repo/pulls/1") {
      fakeNow += 2_000;
      return json({
        number: 1,
        title: "Budget expiry",
        state: "open",
        draft: false,
        user: { login: "contributor" },
        labels: [],
        base: { ref: "main", sha: headSha },
        head: { ref: "feature", sha: headSha },
        created_at: "2026-07-19T00:00:00Z",
        updated_at: "2099-07-20T00:00:00Z",
      });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    const result = await model.methods.sync.execute(
      { budgetSeconds: 1 },
      context,
    );
    assertEquals(result.complete, false);

    const collectionStatuses = writes.filter((write) =>
      write.specName === "collectionStatus"
    );
    const names = collectionStatuses.map((write) => write.name);
    assertEquals(names.length, new Set(names).size);

    const repoPrStatus = collectionStatuses.filter((write) =>
      write.name === "collection-repo-prsnapshot"
    );
    assertEquals(repoPrStatus.length, 1);
    assertEquals(repoPrStatus[0].data.complete, false);
    assertStringIncludes(
      String(repoPrStatus[0].data.error),
      "budget exhausted",
    );
    fakeNow = originalDateNow();
    await assertRejects(
      () =>
        model.methods.sync.execute(
          { budgetSeconds: 1, requireComplete: true },
          context,
        ),
      Error,
      "sync did not complete",
    );
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
  }
});

Deno.test("sync budget expires while waiting for the git lock", async () => {
  const { context } = await tempContext();
  const init = await new Deno.Command("git", {
    args: ["init", "--bare", context.globalArgs.gitObjectPath],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (init.code !== 0) {
    throw new Error(new TextDecoder().decode(init.stderr));
  }
  const lockFile = await Deno.open(
    `${context.globalArgs.gitObjectPath}/swamp-sync.lock`,
    { create: true, read: true, write: true },
  );
  await lockFile.lock(true);
  const startedAt = performance.now();
  try {
    await assertRejects(
      () => model.methods.sync.execute({ budgetSeconds: 1 }, context),
      Error,
      "sync budget exhausted while waiting for git lock",
    );
    assertEquals(performance.now() - startedAt < 2_000, true);
  } finally {
    await lockFile.unlock();
    lockFile.close();
  }
});

Deno.test("sync budget expires while waiting for the worktree registry lock", async () => {
  const { context } = await tempContext();
  const lockDirectory = `${context.globalArgs.artifactRoot}/worktrees`;
  await Deno.mkdir(lockDirectory, { recursive: true });
  const lockFile = await Deno.open(`${lockDirectory}/registry.lock`, {
    create: true,
    read: true,
    write: true,
  });
  await lockFile.lock(true);
  const startedAt = performance.now();
  try {
    await assertRejects(
      () => model.methods.sync.execute({ budgetSeconds: 1 }, context),
      Error,
      "sync budget exhausted while waiting for worktree registry lock",
    );
    assertEquals(performance.now() - startedAt < 2_000, true);
  } finally {
    await lockFile.unlock();
    lockFile.close();
  }
});

Deno.test("sync writes one issue collection status when its budget expires", async () => {
  const { root, writes, context } = await tempContext();
  const upstream = `${root}/upstream.git`;
  for (const path of [upstream, context.globalArgs.gitObjectPath]) {
    const init = await new Deno.Command("git", {
      args: ["init", "--bare", path],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (init.code !== 0) {
      throw new Error(new TextDecoder().decode(init.stderr));
    }
  }
  Object.assign(context.globalArgs, { gitRemoteUrl: upstream });

  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  let fakeNow = originalDateNow();
  Date.now = () => fakeNow;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url,
    );
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/repos/owner/repo") {
      return json({ default_branch: "main" });
    }
    if (url.pathname === "/repos/owner/repo/pulls") return json([]);
    if (url.pathname === "/repos/owner/repo/issues") {
      return json([{
        number: 1,
        title: "Budget expiry",
        state: "open",
        user: { login: "contributor" },
        labels: [],
        created_at: "2026-07-19T00:00:00Z",
        updated_at: "2099-07-20T00:00:00Z",
      }]);
    }
    if (url.pathname === "/repos/owner/repo/issues/1/comments") {
      fakeNow += 2_000;
      return json([]);
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    const result = await model.methods.sync.execute(
      { budgetSeconds: 1 },
      context,
    );
    assertEquals(result.complete, false);

    const collectionStatuses = writes.filter((write) =>
      write.specName === "collectionStatus"
    );
    const names = collectionStatuses.map((write) => write.name);
    assertEquals(names.length, new Set(names).size);

    const repoIssueStatus = collectionStatuses.filter((write) =>
      write.name === "collection-repo-activityevent"
    );
    assertEquals(repoIssueStatus.length, 1);
    assertEquals(repoIssueStatus[0].data.complete, false);
    assertStringIncludes(
      String(repoIssueStatus[0].data.error),
      "budget exhausted",
    );
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
  }
});

Deno.test("sync retries incomplete PR files for an unchanged head", async () => {
  const { root, writes, context } = await tempContext();
  const upstream = `${root}/upstream.git`;
  const headSha = await createMirroredPrRef(root, upstream, 1);
  const init = await new Deno.Command("git", {
    args: ["init", "--bare", context.globalArgs.gitObjectPath],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (init.code !== 0) {
    throw new Error(new TextDecoder().decode(init.stderr));
  }
  Object.assign(context.globalArgs, { gitRemoteUrl: upstream });

  const originalFetch = globalThis.fetch;
  let filesFirstPageRequests = 0;
  let prListRequests = 0;
  let prListPageTwoRequests = 0;
  let dismissReview = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url,
    );
    const json = (value: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
        ...init,
      });
    if (url.pathname === "/repos/owner/repo") {
      return json({ default_branch: "main" });
    }
    if (url.pathname === "/repos/owner/repo/pulls") {
      if (url.searchParams.get("page") === "2") {
        prListPageTwoRequests++;
        return json([]);
      }
      prListRequests++;
      const headers = new Headers({ "content-type": "application/json" });
      if (prListRequests >= 3) {
        headers.set(
          "link",
          '<https://api.github.com/repos/owner/repo/pulls?page=2>; rel="next"',
        );
      }
      const items: Record<string, unknown>[] = [{
        number: 1,
        updated_at: "2099-07-20T00:00:00Z",
      }];
      if (prListRequests >= 3) {
        items.push({ number: 999, updated_at: "2000-01-01T00:00:00Z" });
      }
      return json(items, { headers });
    }
    if (url.pathname === "/repos/owner/repo/pulls/1") {
      return json({
        number: 1,
        title: "Retry files",
        state: "open",
        draft: false,
        user: { login: "contributor" },
        labels: [],
        base: { ref: "main", sha: headSha },
        head: { ref: "feature", sha: headSha },
        created_at: "2026-07-19T00:00:00Z",
        updated_at: "2099-07-20T00:00:00Z",
      });
    }
    if (url.pathname === "/repos/owner/repo/pulls/1/files") {
      if (url.searchParams.get("page") === "2") {
        return new Response("transient", { status: 502 });
      }
      filesFirstPageRequests++;
      const headers = new Headers({ "content-type": "application/json" });
      if (filesFirstPageRequests === 1 || filesFirstPageRequests === 3) {
        headers.set(
          "link",
          '<https://api.github.com/repos/owner/repo/pulls/1/files?page=2>; rel="next"',
        );
      }
      return json([{
        filename: "src/main.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        changes: 3,
        sha: headSha,
      }], { headers });
    }
    if (url.pathname === "/repos/owner/repo/pulls/1/reviews") {
      const reviews = [{
        id: 1,
        user: { login: "reviewer" },
        state: "CHANGES_REQUESTED",
        submitted_at: "2026-07-20T00:00:00Z",
      }, {
        id: 2,
        user: { login: "reviewer" },
        state: dismissReview ? "DISMISSED" : "COMMENTED",
        submitted_at: "2026-07-20T01:00:00Z",
      }];
      return json(reviews);
    }
    if (
      url.pathname === "/repos/owner/repo/pulls/1/comments" ||
      url.pathname === "/repos/owner/repo/issues/1/comments" ||
      url.pathname === "/repos/owner/repo/issues/1/timeline"
    ) {
      return json([]);
    }
    if (url.pathname === `/repos/owner/repo/commits/${headSha}/check-runs`) {
      return json({ check_runs: [] });
    }
    if (url.pathname === "/repos/owner/repo/pulls/1/commits") {
      return json([{
        sha: headSha,
        parents: [],
        commit: { message: "initial", author: {}, committer: {} },
      }]);
    }
    if (url.pathname === "/repos/owner/repo/issues") return json([]);
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    const revisionRoot =
      `${context.globalArgs.artifactRoot}/prs/1/revisions/${headSha}`;
    const first = await model.methods.sync.execute({}, context);
    assertEquals(first.complete, false);
    await assertRejects(
      () =>
        Deno.stat(
          `${context.globalArgs.artifactRoot}/prs/1/revisions/${headSha}/files.complete.json`,
        ),
      Deno.errors.NotFound,
    );
    await assertRejects(
      () => Deno.stat(`${revisionRoot}/files.json`),
      Deno.errors.NotFound,
    );

    const second = await model.methods.sync.execute({}, context);
    assertEquals(second.complete, true);
    assertEquals(filesFirstPageRequests, 2);
    assertEquals(
      (await Deno.stat(
        `${context.globalArgs.artifactRoot}/prs/1/revisions/${headSha}/files.complete.json`,
      )).isFile,
      true,
    );
    const completeFiles = await Deno.readTextFile(`${revisionRoot}/files.json`);

    await Deno.remove(`${context.globalArgs.artifactRoot}/prs/1/current.json`);
    const forcedRefresh = await model.methods.sync.execute({}, context);
    assertEquals(forcedRefresh.complete, false);
    await assertRejects(
      () =>
        Deno.stat(
          `${context.globalArgs.artifactRoot}/prs/1/revisions/${headSha}/files.complete.json`,
        ),
      Deno.errors.NotFound,
    );
    assertEquals(
      await Deno.readTextFile(`${revisionRoot}/files.json`),
      completeFiles,
    );

    const forcedRetry = await model.methods.sync.execute({}, context);
    assertEquals(forcedRetry.complete, true);
    assertEquals(filesFirstPageRequests, 4);
    assertEquals(prListPageTwoRequests, 0);
    const fileStatuses = writes.filter((write) =>
      write.specName === "collectionStatus" &&
      write.data.component === "prSnapshot" &&
      write.data.subjectNumber === 1
    );
    assertEquals(fileStatuses.map((write) => write.data.complete), [
      false,
      true,
      false,
      true,
    ]);
    const latestPr = writes.filter((write) => write.specName === "prSnapshot")
      .at(-1);
    assertEquals(latestPr?.data.reviewDecision, "CHANGES_REQUESTED");
    const latestCommit = writes.filter((write) => write.specName === "prCommit")
      .at(-1);
    assertEquals(latestCommit?.data.headSha, headSha);

    dismissReview = true;
    const afterDismissal = await model.methods.sync.execute({}, context);
    assertEquals(afterDismissal.complete, true);
    const dismissedPr = writes.filter((write) =>
      write.specName === "prSnapshot"
    )
      .at(-1);
    assertEquals(dismissedPr?.data.reviewDecision, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("sync reconciles canonical branches and HEAD while preserving review branches", async () => {
  const { root, context } = await tempContext();
  const source = `${root}/source`;
  const upstream = `${root}/upstream.git`;
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
  await run(source, ["init", "--initial-branch=main"]);
  await run(source, ["config", "user.email", "test@example.com"]);
  await run(source, ["config", "user.name", "Test"]);
  await run(source, ["config", "commit.gpgsign", "false"]);
  await Deno.writeTextFile(`${source}/README.md`, "stale\n");
  await run(source, ["add", "README.md"]);
  await run(source, ["commit", "-m", "stale"]);
  const staleSha = await run(source, ["rev-parse", "HEAD"]);
  await run(source, ["branch", "obsolete"]);
  await run(source, ["branch", "feature/x"]);
  await run(source, ["branch", "1/head"]);
  await run(root, [
    "clone",
    "--bare",
    source,
    context.globalArgs.gitObjectPath,
  ]);
  await run(root, [
    "--git-dir",
    context.globalArgs.gitObjectPath,
    "update-ref",
    `refs/heads/review/pr-1-patchhead-${staleSha.slice(0, 12)}`,
    staleSha,
  ]);
  await run(root, [
    "--git-dir",
    context.globalArgs.gitObjectPath,
    "update-ref",
    "refs/heads/review/manual-local",
    staleSha,
  ]);
  await run(source, ["branch", "-D", "obsolete"]);
  await run(source, ["branch", "-D", "feature/x"]);
  await run(source, ["branch", "feature"]);
  await run(source, ["branch", "-m", "trunk"]);
  await run(source, ["branch", "review"]);
  await Deno.writeTextFile(`${source}/README.md`, "current\n");
  await run(source, ["commit", "-am", "current"]);
  const currentSha = await run(source, ["rev-parse", "HEAD"]);
  await run(root, ["clone", "--bare", source, upstream]);
  Object.assign(context.globalArgs, {
    gitRemote: "pull",
    gitRemoteUrl: upstream,
  });
  await Deno.mkdir(`${context.globalArgs.artifactRoot}/worktrees`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${context.globalArgs.artifactRoot}/worktrees/index.json`,
    JSON.stringify([{
      id: "worktree-protected-development",
      repo: "owner/repo",
      path: `${context.globalArgs.workspaceRoot}/obsolete`,
      branch: "obsolete",
      createdReason: "development",
      creationBaseSha: staleSha,
      creationBaseRef: "HEAD",
      createdAt: "2026-07-27T00:00:00.000Z",
      filesystemState: "active",
    }]),
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url,
    );
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/repos/owner/repo") {
      return json({ default_branch: "main" });
    }
    if (
      url.pathname === "/repos/owner/repo/pulls" ||
      url.pathname === "/repos/owner/repo/issues"
    ) {
      return json([]);
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    const result = await model.methods.sync.execute({}, context);

    assertEquals(result.complete, true);
    assertEquals(
      await run(root, [
        "--git-dir",
        context.globalArgs.gitObjectPath,
        "rev-parse",
        "refs/heads/trunk",
      ]),
      currentSha,
    );
    assertEquals(
      await run(root, [
        "--git-dir",
        context.globalArgs.gitObjectPath,
        "symbolic-ref",
        "HEAD",
      ]),
      "refs/heads/trunk",
    );
    assertEquals(
      await run(root, [
        "--git-dir",
        context.globalArgs.gitObjectPath,
        "rev-parse",
        "HEAD",
      ]),
      currentSha,
    );
    await assertRejects(
      () =>
        run(root, [
          "--git-dir",
          context.globalArgs.gitObjectPath,
          "show-ref",
          "--verify",
          "refs/heads/main",
        ]),
      Error,
    );
    assertEquals(
      await run(root, [
        "--git-dir",
        context.globalArgs.gitObjectPath,
        "rev-parse",
        "refs/heads/obsolete",
      ]),
      staleSha,
    );
    assertEquals(
      await run(root, [
        "--git-dir",
        context.globalArgs.gitObjectPath,
        "rev-parse",
        "refs/heads/feature",
      ]),
      staleSha,
    );
    const defaultWorktree = await model.methods.create_worktree.execute({
      branch: "local-default-base",
    }, context);
    assertEquals(defaultWorktree.baseHeadSha, currentSha);
    const worktrees = JSON.parse(
      await Deno.readTextFile(
        `${context.globalArgs.artifactRoot}/worktrees/index.json`,
      ),
    );
    assertEquals(
      worktrees.find((record: { id: string }) =>
        record.id === defaultWorktree.worktreeId
      ).creationBaseRef,
      "HEAD",
    );
    await assertRejects(
      () => model.methods.create_worktree.execute({ branch: "trunk" }, context),
      Error,
      "conflicts with mirrored branch",
    );
    await assertRejects(
      () =>
        run(root, [
          "--git-dir",
          context.globalArgs.gitObjectPath,
          "show-ref",
          "--verify",
          "refs/heads/feature/x",
        ]),
      Error,
    );
    await assertRejects(
      () =>
        run(root, [
          "--git-dir",
          context.globalArgs.gitObjectPath,
          "show-ref",
          "--verify",
          "refs/heads/review",
        ]),
      Error,
    );
    assertEquals(
      await run(root, [
        "--git-dir",
        context.globalArgs.gitObjectPath,
        "rev-parse",
        `refs/heads/review/pr-1-patchhead-${staleSha.slice(0, 12)}`,
      ]),
      staleSha,
    );
    assertEquals(
      await run(root, [
        "--git-dir",
        context.globalArgs.gitObjectPath,
        "rev-parse",
        "refs/heads/review/manual-local",
      ]),
      staleSha,
    );
    await assertRejects(
      () =>
        run(root, [
          "--git-dir",
          context.globalArgs.gitObjectPath,
          "show-ref",
          "--verify",
          "refs/remotes/pull/1/head",
        ]),
      Error,
    );
    assertEquals(
      await run(root, [
        "--git-dir",
        context.globalArgs.gitObjectPath,
        "rev-parse",
        "refs/swamp/remotes/pull/1/head",
      ]),
      staleSha,
    );
    assertEquals(
      await run(root, [
        "--git-dir",
        context.globalArgs.gitObjectPath,
        "remote",
        "get-url",
        "pull",
      ]),
      upstream,
    );
    const renamedWorktree = await model.methods.create_worktree.execute({
      branch: "future/topic",
    }, context);
    await run(renamedWorktree.path, ["switch", "--detach"]);
    await run(renamedWorktree.path, [
      "branch",
      "-m",
      "future/topic",
      "future/renamed",
    ]);
    await assertRejects(
      () => model.methods.sync.execute({}, context),
      Error,
      "registered development worktree is detached or branch inspection failed",
    );
    assertEquals(
      await run(root, [
        "--git-dir",
        context.globalArgs.gitObjectPath,
        "rev-parse",
        "refs/heads/future/renamed",
      ]),
      currentSha,
    );
    await run(renamedWorktree.path, ["switch", "future/renamed"]);
    await run(renamedWorktree.path, ["branch", "-m", "future/topic"]);
    await run(source, ["branch", "future"]);
    await run(source, ["remote", "add", "test-upstream", upstream]);
    await run(source, ["push", "test-upstream", "future"]);

    await assertRejects(
      () => model.methods.sync.execute({}, context),
      Error,
      "mirrored branches conflict with registered development branches: future",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
