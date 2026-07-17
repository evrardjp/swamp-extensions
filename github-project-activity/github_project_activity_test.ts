import { assertEquals } from "jsr:@std/assert@1";
import { model } from "./github_project_activity.ts";
import { report as prReviewReport } from "./github_pr_review.ts";

type WriteCall = {
  specName: string;
  name: string;
  data: Record<string, unknown>;
  overrides?: Record<string, unknown>;
};

function recordingContext() {
  const writes: WriteCall[] = [];
  const files: Array<{ specName: string; name: string; content: string }> = [];
  return {
    writes,
    files,
    context: {
      globalArgs: {
        owner: "owner",
        repo: "repo",
        includePrivateEvents: true,
        knownForks: [],
        defaultBackfillWindowDays: 90,
        staleInactivityDays: 15,
        personalGithubHandles: [],
        githubToken: undefined as string | undefined,
      },
      definition: { name: "activity" },
      writeResource: async (
        specName: string,
        name: string,
        data: Record<string, unknown>,
        overrides?: Record<string, unknown>,
      ) => {
        writes.push({ specName, name, data, overrides });
        return { name, specName, kind: "resource", version: 1 };
      },
      createFileWriter: (specName: string, name: string) => ({
        writeText: async (content: string) => {
          files.push({ specName, name, content });
          return { name, specName, kind: "file", version: 1 };
        },
      }),
    },
  };
}

Deno.test("record_activity writes activityEvent only", async () => {
  const { writes, context } = recordingContext();

  const result = await model.methods.record_activity.execute({
    event: {
      subjectType: "pr",
      subjectNumber: 42,
      eventType: "agent_session_recorded",
      source: "pi-agent",
      visibility: "private",
      actor: "pi",
      summary: "Deep review completed",
      body: "Short summary",
      createdAt: "2026-07-01T12:00:00.000Z",
      artifactRefs: ["artifact-pr-42-session"],
      tags: ["review"],
    },
  }, context);

  assertEquals(result.dataHandles.length, 1);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "activityEvent");
  assertEquals(writes[0].data.repo, "owner/repo");
  assertEquals(writes[0].data.subjectType, "pr");
  assertEquals(writes[0].data.visibility, "private");
  assertEquals(writes[0].data.artifactRefs, ["artifact-pr-42-session"]);
});

Deno.test("record_artifact writes artifact file and index", async () => {
  const { writes, files, context } = recordingContext();

  const result = await model.methods.record_artifact.execute({
    name: "artifact-pr-42-session",
    contentType: "text/markdown",
    content: "# Review log",
    subjectType: "pr",
    subjectNumber: 42,
    description: "Review transcript",
  }, context);

  assertEquals(result.dataHandles.length, 2);
  assertEquals(files, [{
    specName: "artifact",
    name: "artifact-pr-42-session",
    content: "# Review log",
  }]);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "artifactIndex");
  assertEquals(writes[0].data.name, "artifact-pr-42-session");
  assertEquals(writes[0].data.repo, "owner/repo");
  assertEquals(writes[0].data.contentType, "text/markdown");
});

Deno.test("sync_github_pr_by_number fetches exactly one PR directly", async () => {
  const { writes, context } = recordingContext();
  context.globalArgs.githubToken = "gh-token";
  const requestedUrls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes("/repos/owner/repo/pulls/42/files")) {
      return new Response(
        JSON.stringify([{
          filename: "src/a.ts",
          status: "modified",
          additions: 10,
          deletions: 2,
          changes: 12,
          blob_url: "https://github.com/owner/repo/blob/src/a.ts",
          raw_url: "https://raw.githubusercontent.com/owner/repo/src/a.ts",
        }]),
        { status: 200 },
      );
    }
    if (url.includes("/repos/owner/repo/pulls/42")) {
      return new Response(
        JSON.stringify({
          number: 42,
          title: "Add feature",
          state: "closed",
          merged: true,
          merged_at: "2026-07-01T12:00:00.000Z",
          draft: false,
          user: { login: "alice" },
          base: { ref: "main" },
          head: {
            ref: "feature",
            sha: "abc123",
            repo: {
              full_name: "alice/repo",
              pushed_at: "2026-07-01T11:30:00.000Z",
            },
          },
          labels: [{ name: "kind/feature" }],
          assignees: [],
          requested_reviewers: [],
          mergeable: true,
          additions: 10,
          deletions: 2,
          changed_files: 1,
          created_at: "2026-07-01T10:00:00.000Z",
          updated_at: "2026-07-01T11:00:00.000Z",
          closed_at: "2026-07-01T12:00:00.000Z",
          html_url: "https://github.com/owner/repo/pull/42",
          node_id: "PR_kw42",
        }),
        { status: 200 },
      );
    }
    return new Response("unexpected URL", { status: 500 });
  };
  try {
    const result = await model.methods.sync_github_pr_by_number.execute({
      prNumber: 42,
      includePatchArtifacts: false,
      includeReviews: false,
      includeReviewComments: false,
      includeIssueComments: false,
      includeChecks: false,
      includeTimeline: false,
    }, context);

    assertEquals(requestedUrls.length, 2);
    assertEquals(requestedUrls[0].includes("/repos/owner/repo/pulls/42"), true);
    assertEquals(requestedUrls[0].includes("state="), false);
    assertEquals(
      requestedUrls[1].includes("/repos/owner/repo/pulls/42/files"),
      true,
    );
    assertEquals(result.dataHandles.length, 3);
    assertEquals(writes.some((w) => w.specName === "prSnapshot"), true);
    assertEquals(
      writes.find((w) => w.specName === "prSnapshot")?.data.state,
      "closed",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("classify_stale_candidates writes classification events for stale snapshots", async () => {
  const encoder = new TextEncoder();
  const entries = [
    {
      name: "pr-owner-repo-1-snapshot",
      version: 1,
      tags: { specName: "prSnapshot" },
      value: {
        repo: "owner/repo",
        number: 1,
        title: "Needs attention",
        state: "open",
        labels: ["kind/bug"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-10T00:00:00.000Z",
        lastConversationAt: "2026-01-10T00:00:00.000Z",
        lastCodeChangeAt: "2026-01-10T00:00:00.000Z",
        syncedAt: "2026-04-20T00:00:00.000Z",
        url: "https://github.com/owner/repo/pull/1",
      },
    },
    {
      name: "issue-owner-repo-2-snapshot",
      version: 1,
      tags: { specName: "issueSnapshot" },
      value: {
        repo: "owner/repo",
        number: 2,
        title: "Already stale",
        state: "open",
        labels: ["Stale"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-10T00:00:00.000Z",
        lastConversationAt: "2026-01-10T00:00:00.000Z",
        syncedAt: "2026-04-20T00:00:00.000Z",
      },
    },
    {
      name: "issue-owner-repo-3-snapshot",
      version: 1,
      tags: { specName: "issueSnapshot" },
      value: {
        repo: "owner/repo",
        number: 3,
        title: "Too new",
        state: "open",
        labels: [],
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z",
        lastConversationAt: "2026-04-15T00:00:00.000Z",
        syncedAt: "2026-04-20T00:00:00.000Z",
      },
    },
  ];
  const contentByName = new Map(
    entries.map((entry) => [
      `${entry.name}:${entry.version}`,
      encoder.encode(JSON.stringify(entry.value)),
    ]),
  );
  const { writes, context } = recordingContext();
  const classifyContext = {
    ...context,
    modelType: "@evrardjp/github-project-activity",
    modelId: "model-id",
    dataRepository: {
      findAllForModel: async () =>
        entries.map(({ name, version, tags }) => ({ name, version, tags })),
      getContent: async (
        _modelType: unknown,
        _modelId: string,
        dataName: string,
        version?: number,
      ) => contentByName.get(`${dataName}:${version}`) ?? null,
    },
  };

  const result = await model.methods.classify_stale_candidates.execute({
    asOf: "2026-04-20T00:00:00.000Z",
  }, classifyContext);

  assertEquals(result.dataHandles.length, 1);
  assertEquals(result.summary.candidateCount, 1);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "activityEvent");
  assertEquals(writes[0].data.eventType, "classification_stale_candidate");
  assertEquals(writes[0].data.subjectType, "pr");
  assertEquals(writes[0].data.subjectNumber, 1);
  assertEquals(writes[0].data.label, "Stale");
});

Deno.test("clear_stale_candidates writes clear events for active stale snapshots", async () => {
  const encoder = new TextEncoder();
  const entries = [
    {
      name: "issue-owner-repo-4-snapshot",
      version: 1,
      tags: { specName: "issueSnapshot" },
      value: {
        repo: "owner/repo",
        number: 4,
        title: "Active again",
        state: "open",
        labels: ["Stale"],
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-18T00:00:00.000Z",
        lastConversationAt: "2026-04-18T00:00:00.000Z",
        syncedAt: "2026-04-20T00:00:00.000Z",
        url: "https://github.com/owner/repo/issues/4",
      },
    },
    {
      name: "event-owner-repo-issue-4-stale",
      version: 1,
      tags: { specName: "activityEvent" },
      value: {
        id: "stale-4",
        repo: "owner/repo",
        subjectType: "issue",
        subjectNumber: 4,
        eventType: "classification_stale_candidate",
        source: "test",
        visibility: "private",
        actor: "swamp",
        summary: "classified stale",
        createdAt: "2026-04-01T00:00:00.000Z",
        state: "stale:2026-03-01T00:00:00.000Z:15",
        label: "Stale",
        artifactRefs: [],
        tags: ["classification", "stale"],
      },
    },
  ];
  const contentByName = new Map(
    entries.map((entry) => [
      `${entry.name}:${entry.version}`,
      encoder.encode(JSON.stringify(entry.value)),
    ]),
  );
  const { writes, context } = recordingContext();
  const clearContext = {
    ...context,
    modelType: "@evrardjp/github-project-activity",
    modelId: "model-id",
    dataRepository: {
      findAllForModel: async () =>
        entries.map(({ name, version, tags }) => ({ name, version, tags })),
      getContent: async (
        _modelType: unknown,
        _modelId: string,
        dataName: string,
        version?: number,
      ) => contentByName.get(`${dataName}:${version}`) ?? null,
    },
  };

  const result = await model.methods.clear_stale_candidates.execute({
    asOf: "2026-04-20T00:00:00.000Z",
  }, clearContext);

  assertEquals(result.dataHandles.length, 1);
  assertEquals(result.summary.clearedCount, 1);
  assertEquals(writes.length, 1);
  assertEquals(
    writes[0].data.eventType,
    "classification_stale_candidate_cleared",
  );
  assertEquals(writes[0].data.subjectType, "issue");
  assertEquals(writes[0].data.subjectNumber, 4);
});

Deno.test("render_pr_report reads new activity database resources", async () => {
  const encoder = new TextEncoder();
  const entries = [
    {
      name: "pr-owner-repo-42-snapshot",
      version: 1,
      tags: { specName: "prSnapshot" },
      value: {
        repo: "owner/repo",
        number: 42,
        title: "Add feature",
        state: "open",
        author: "alice",
        labels: ["kind/feature"],
        reviewersRequestingChanges: ["bob"],
        mergeConflict: false,
        checksState: "failure",
        additions: 10,
        deletions: 2,
        changedFiles: 1,
        createdAt: "2026-07-01T10:00:00.000Z",
        updatedAt: "2026-07-01T11:00:00.000Z",
        syncedAt: "2026-07-01T11:00:00.000Z",
      },
    },
    {
      name: "event-owner-repo-pr-42-review-comment-1",
      version: 1,
      tags: { specName: "activityEvent" },
      value: {
        id: "review-comment-1",
        repo: "owner/repo",
        subjectType: "pr",
        subjectNumber: 42,
        eventType: "review_comment_added",
        source: "github",
        visibility: "public",
        actor: "bob",
        summary: "Review comment",
        body: "Please update this.",
        createdAt: "2026-07-01T10:30:00.000Z",
        artifactRefs: [],
        tags: ["review"],
      },
    },
  ];
  const contentByName = new Map(
    entries.map((entry) => [
      `${entry.name}:${entry.version}`,
      encoder.encode(JSON.stringify(entry.value)),
    ]),
  );
  const { writes, context } = recordingContext();
  const reportContext = {
    ...context,
    modelType: "@evrardjp/github-project-activity",
    modelId: "model-id",
    dataRepository: {
      findAllForModel: async () =>
        entries.map(({ name, version, tags }) => ({ name, version, tags })),
      getContent: async (
        _modelType: unknown,
        _modelId: string,
        dataName: string,
        version?: number,
      ) => contentByName.get(`${dataName}:${version}`) ?? null,
    },
  };

  const result = await model.methods.render_pr_report.execute({
    prNumber: 42,
    includePrivate: true,
  }, reportContext);

  assertEquals(result.dataHandles.length, 1);
  assertEquals(writes[0].specName, "prReport");
  const markdown = String(writes[0].data.markdown);
  assertEquals(
    markdown.includes("# PR Review Report: owner/repo#42 — Add feature"),
    true,
  );
  assertEquals(markdown.includes("Review comment"), true);
  assertEquals(markdown.includes("Please update this."), true);
});

Deno.test("pr-review report generates prReport-shaped output when prReport is missing", async () => {
  const encoder = new TextEncoder();
  const entries = [
    {
      name: "pr-owner-repo-42-snapshot",
      version: 1,
      tags: { specName: "prSnapshot" },
      value: {
        repo: "owner/repo",
        number: 42,
        title: "Add feature",
        state: "open",
        author: "alice",
        labels: ["kind/feature"],
        reviewersRequestingChanges: [],
        mergeConflict: false,
        checksState: "success",
        additions: 10,
        deletions: 2,
        changedFiles: 1,
        createdAt: "2026-07-01T10:00:00.000Z",
        updatedAt: "2026-07-01T11:00:00.000Z",
        syncedAt: "2026-07-01T11:00:00.000Z",
      },
    },
  ];
  const contentByName = new Map(
    entries.map((entry) => [
      `${entry.name}:${entry.version}`,
      encoder.encode(JSON.stringify(entry.value)),
    ]),
  );
  const { writes, context } = recordingContext();
  const reportContext = {
    ...context,
    modelType: "@evrardjp/github-project-activity",
    modelId: "model-id",
    methodArgs: { prNumber: 42 },
    dataRepository: {
      findAllForModel: async () =>
        entries.map(({ name, version, tags }) => ({ name, version, tags })),
      getContent: async (
        _modelType: unknown,
        _modelId: string,
        dataName: string,
        version?: number,
      ) => contentByName.get(`${dataName}:${version}`) ?? null,
    },
  };

  const result = await prReviewReport.execute(reportContext);

  assertEquals(
    result.markdown.includes("# PR Review Report: owner/repo#42 — Add feature"),
    true,
  );
  assertEquals(result.json.source, "generated-prReport");
  assertEquals(writes[0].specName, "prReport");
});
