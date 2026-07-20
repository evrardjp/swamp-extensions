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
