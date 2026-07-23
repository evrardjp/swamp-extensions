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
  await run(source, ["branch", "-D", "obsolete"]);
  await run(source, ["branch", "-D", "feature/x"]);
  await run(source, ["branch", "feature"]);
  await run(source, ["branch", "-m", "trunk"]);
  await run(source, ["branch", "review/upstream"]);
  await Deno.writeTextFile(`${source}/README.md`, "current\n");
  await run(source, ["commit", "-am", "current"]);
  const currentSha = await run(source, ["rev-parse", "HEAD"]);
  await run(root, ["clone", "--bare", source, upstream]);
  Object.assign(context.globalArgs, {
    gitRemote: "pull",
    gitRemoteUrl: upstream,
  });

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
    await assertRejects(
      () =>
        run(root, [
          "--git-dir",
          context.globalArgs.gitObjectPath,
          "show-ref",
          "--verify",
          "refs/heads/obsolete",
        ]),
      Error,
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
    assertEquals(
      await run(root, [
        "--git-dir",
        context.globalArgs.gitObjectPath,
        "rev-parse",
        "refs/heads/review/upstream",
      ]),
      staleSha,
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
        "remote",
        "get-url",
        "pull",
      ]),
      upstream,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
