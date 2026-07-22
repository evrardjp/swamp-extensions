import { assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./github_local_mirror_status.ts";

Deno.test("mirror status report summarizes stored data", async () => {
  const contents = new Map([
    [
      "mirror-status-current",
      {
        repo: "owner/repo",
        state: {
          cursor: { lastSuccessfulSyncAt: "2026-07-17T10:00:00.000Z" },
          syncInProgress: false,
        },
        gitObjectPath: "/mirrors/repo.git",
        artifactRoot: "/artifacts",
        workspaceRoot: "/worktrees",
      },
    ],
    [
      "sync-2026-07-17",
      {
        finishedAt: "2026-07-17T10:00:00.000Z",
        prCount: 2,
        issueCount: 3,
        eventCount: 4,
        checkRunCount: 5,
        complete: false,
        errors: [{ component: "activityEvent", error: "budget exhausted" }],
      },
    ],
  ]);
  const result = await report.execute({
    modelType: "@evrardjp/github-local-mirror",
    modelId: "mirror-id",
    definition: { name: "owner-repo-mirror" },
    dataRepository: {
      findAllForModel: () =>
        Promise.resolve([
          { name: "mirror-status-current", version: 1 },
          {
            name: "sync-2026-07-17",
            version: 1,
            tags: { specName: "syncRunSummary" },
          },
        ]),
      getContent: (_type, _id, name) => {
        const content = contents.get(name);
        return Promise.resolve(
          content ? new TextEncoder().encode(JSON.stringify(content)) : null,
        );
      },
    },
  });

  assertStringIncludes(result.markdown, "Repository: `owner/repo`");
  assertStringIncludes(result.markdown, "PRs synced in latest run: 2");
  assertStringIncludes(result.markdown, "Latest sync complete: false");
  assertStringIncludes(result.markdown, "budget exhausted");
  assertStringIncludes(result.markdown, "| syncRunSummary | 1 |");
});

Deno.test("mirror status report rejects unsupported model types", async () => {
  const result = await report.execute({ modelType: "@example/other" });

  assertStringIncludes(
    result.markdown,
    "This report only supports @evrardjp/github-local-mirror models.",
  );
});

Deno.test("mirror status reports merged cleanup candidates and latest failures", async () => {
  const entries = [
    {
      name: "worktree-42",
      version: 1,
      tags: { specName: "worktreeSnapshot" },
    },
    {
      name: "worktree-42",
      version: 1,
      tags: { specName: "worktreeAnalysis" },
    },
    {
      name: "worktree-43",
      version: 2,
      tags: { specName: "worktreeSnapshot" },
    },
    {
      name: "worktree-43",
      version: 1,
      tags: { specName: "worktreeAnalysis" },
    },
    {
      name: "worktree-42",
      version: 2,
      tags: { specName: "worktreeAnalysis" },
    },
    { name: "pr-42", version: 1, tags: { specName: "prSnapshot" } },
    {
      name: "cleanup-2026-07-22T10:00:00.000Z",
      version: 1,
      tags: { specName: "worktreeCleanupRun" },
    },
  ];
  const contents = new Map<string, Record<string, unknown>>([
    [
      "worktree-42:1:worktreeSnapshot",
      {
        id: "worktree-42",
        prNumber: 42,
        status: "active",
        path: "/worktrees/pr-42",
      },
    ],
    [
      "worktree-42:1:worktreeAnalysis",
      {
        worktreeId: "worktree-42",
        prNumber: 42,
        isDirty: true,
        isPrHeadStale: false,
        aheadCommitCount: 0,
        missing: false,
        recommendedAction: "commit-or-stash-local-changes",
      },
    ],
    [
      "worktree-42:2:worktreeAnalysis",
      {
        worktreeId: "worktree-42",
        prNumber: 42,
        isDirty: false,
        isPrHeadStale: false,
        aheadCommitCount: 0,
        missing: false,
        recommendedAction: "none",
      },
    ],
    [
      "worktree-43:2:worktreeSnapshot",
      { id: "worktree-43", prNumber: 43, status: "removed" },
    ],
    [
      "worktree-43:1:worktreeAnalysis",
      {
        worktreeId: "worktree-43",
        prNumber: 43,
        isDirty: true,
        isPrHeadStale: false,
        aheadCommitCount: 0,
        missing: false,
        recommendedAction: "commit-or-stash-local-changes",
      },
    ],
    ["pr-42:1:prSnapshot", { number: 42, state: "closed", merged: true }],
    [
      "cleanup-2026-07-22T10:00:00.000Z:1:worktreeCleanupRun",
      {
        removedCount: 0,
        results: [{
          prNumber: 42,
          outcome: "failed",
          error: "worktree contains modified files",
        }],
      },
    ],
  ]);
  const result = await report.execute({
    modelType: "@evrardjp/github-local-mirror",
    modelId: "mirror-id",
    dataRepository: {
      findAllForModel: () => Promise.resolve(entries),
      getContent: (_type, _id, name, version) => {
        const specName = entries.find((entry) =>
          entry.name === name && entry.version === version
        )?.tags.specName;
        const content = contents.get(`${name}:${version}:${specName}`);
        return Promise.resolve(
          content ? new TextEncoder().encode(JSON.stringify(content)) : null,
        );
      },
    },
  });

  assertStringIncludes(result.markdown, "Active: 1");
  assertStringIncludes(result.markdown, "Merged cleanup candidates: 1");
  assertStringIncludes(result.markdown, "Latest cleanup failures: 1");
  assertStringIncludes(result.markdown, "worktree contains modified files");
  assertStringIncludes(result.markdown, "Dirty: 0");
  assertStringIncludes(result.markdown, "| worktreeAnalysis | 2 |");
});
