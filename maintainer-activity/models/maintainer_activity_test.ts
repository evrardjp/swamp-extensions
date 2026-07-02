import { assertEquals } from "jsr:@std/assert@1";
import { model } from "./maintainer_activity.ts";

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
        personalGithubHandles: [],
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
    modelType: "@evrardjp/maintainer-activity",
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
  assertEquals(markdown.includes("# PR #42 — Add feature"), true);
  assertEquals(markdown.includes("Review comment"), true);
  assertEquals(markdown.includes("Please update this."), true);
});
