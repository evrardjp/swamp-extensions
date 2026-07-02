import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./maintainer_briefing.ts";

type Entry = {
  name: string;
  version: number;
  tags?: Record<string, string>;
  metadata?: { tags?: Record<string, string> };
  value: unknown;
};

function repository(entries: Entry[]) {
  const encoder = new TextEncoder();
  const contentByName = new Map(
    entries.map((entry) => [
      `${entry.name}:${entry.version}`,
      encoder.encode(JSON.stringify(entry.value)),
    ]),
  );
  return {
    findAllForModel: async () =>
      entries.map(({ name, version, tags, metadata }) => ({
        name,
        version,
        tags,
        metadata,
      })),
    getContent: async (
      _modelType: unknown,
      _modelId: string,
      dataName: string,
      version?: number,
    ) => contentByName.get(`${dataName}:${version}`) ?? null,
  };
}

Deno.test("maintainer briefing aggregates new activity database resources", async () => {
  const entries: Entry[] = [
    {
      name: "pr-1",
      version: 1,
      tags: { specName: "prSnapshot" },
      value: {
        repo: "owner/repo",
        number: 1,
        title: "Fix failing provider",
        state: "open",
        author: "alice",
        reviewersRequestingChanges: ["bob"],
        reviewDecision: "CHANGES_REQUESTED",
        mergeConflict: true,
        checksState: "failure",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastConversationAt: "2026-01-01T00:00:00.000Z",
        syncedAt: "2026-07-01T00:00:00.000Z",
        url: "https://github.com/owner/repo/pull/1",
      },
    },
    {
      name: "issue-2",
      version: 1,
      tags: { specName: "issueSnapshot" },
      value: {
        repo: "owner/repo",
        number: 2,
        title: "Old issue",
        state: "open",
        author: "carol",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastConversationAt: "2026-01-01T00:00:00.000Z",
        syncedAt: "2026-07-01T00:00:00.000Z",
        url: "https://github.com/owner/repo/issues/2",
      },
    },
    {
      name: "ci-1",
      version: 1,
      tags: { specName: "ciStatusSnapshot" },
      value: {
        repo: "owner/repo",
        prNumber: 1,
        name: "e2e",
        status: "completed",
        conclusion: "failure",
        syncedAt: "2026-07-01T00:00:00.000Z",
      },
    },
    {
      name: "event-1",
      version: 1,
      tags: { specName: "activityEvent" },
      value: {
        id: "event-1",
        repo: "owner/repo",
        subjectType: "pr",
        subjectNumber: 1,
        eventType: "review_comment_added",
        source: "github",
        visibility: "public",
        actor: "bob",
        summary: "Requested a fix",
        createdAt: "2026-07-01T12:00:00.000Z",
      },
    },
  ];

  const result = await report.execute({
    modelType: "@evrardjp/maintainer-activity",
    modelId: "model-id",
    definition: { name: "activity" },
    globalArgs: { includePrivateEvents: true },
    dataRepository: repository(entries),
  });

  assertStringIncludes(result.markdown, "# Maintainer Briefing — activity");
  assertStringIncludes(result.markdown, "Open PRs with failing CI");
  assertStringIncludes(result.markdown, "Fix failing provider");
  assertStringIncludes(result.markdown, "Open PRs with requested changes");
  assertStringIncludes(result.markdown, "Open PRs with merge conflicts");
  assertStringIncludes(result.markdown, "Stale open issues");
  assertStringIncludes(result.markdown, "Requested a fix");
  const counts = result.json.counts as Record<string, number>;
  assertEquals(counts.prs, 1);
  assertEquals(counts.issues, 1);
  assertEquals(counts.events, 1);
});

Deno.test("maintainer briefing hides private events when configured", async () => {
  const entries: Entry[] = [
    {
      name: "private-event",
      version: 1,
      tags: { specName: "activityEvent" },
      value: {
        id: "private-event",
        repo: "owner/repo",
        subjectType: "project",
        eventType: "manual_note",
        source: "manual",
        visibility: "private",
        actor: "maintainer",
        summary: "Private note",
        createdAt: "2026-07-01T12:00:00.000Z",
      },
    },
  ];

  const result = await report.execute({
    modelType: "@evrardjp/maintainer-activity",
    modelId: "model-id",
    globalArgs: { includePrivateEvents: false },
    dataRepository: repository(entries),
  });

  const counts = result.json.counts as Record<string, number>;
  assertEquals(counts.events, 0);
  assertEquals(result.markdown.includes("Private note"), false);
});

Deno.test("maintainer briefing ignores unrelated model types", async () => {
  const result = await report.execute({
    modelType: "other/model",
    modelId: "model-id",
    dataRepository: repository([]),
  });

  assertEquals(result.markdown, "");
  assertEquals(result.json, {});
});
