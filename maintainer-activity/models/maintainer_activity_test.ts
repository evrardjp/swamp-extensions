import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { model } from "./maintainer_activity.ts";

type WriteCall = {
  specName: string;
  name: string;
  data: Record<string, unknown>;
};

function recordingContext() {
  const writes: WriteCall[] = [];
  return {
    writes,
    context: {
      writeResource: async (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ specName, name, data });
        return { name };
      },
    },
  };
}

Deno.test("record_pi_session_finding writes lifecycle event and optional session log", async () => {
  const { writes, context } = recordingContext();

  const result = await model.methods.record_pi_session_finding.execute({
    finding: {
      sessionId: "session-123",
      repo: "owner/repo",
      itemType: "pr",
      number: 42,
      title: "Fix a thing",
      url: "https://github.com/owner/repo/pull/42",
      actor: "pi",
      eventType: "maintainer-finding",
      summary: "Found a maintainer follow-up",
      createdAt: "2026-06-24T10:00:00.000Z",
      tags: ["daily-briefing"],
      recordSessionLog: true,
      sessionSummary: "Full session summary",
    },
  }, context);

  assertEquals(result.dataHandles.length, 2);
  assertEquals(writes.map((w) => w.specName), ["lifecycleEvent", "sessionLog"]);
  assertEquals(
    writes[0].name,
    "pi-session-event-owner-repo-pr-42-session-123-2026-06-24t10-00-00.000z",
  );
  assertEquals(writes[0].data.source, "pi-agent-session");
  assertEquals(writes[0].data.relatedSessionId, "session-123");
  assertEquals(writes[0].data.tags, ["pi-session-telemetry", "daily-briefing"]);
  assertEquals(writes[1].data.summary, "Full session summary");
  assertEquals(writes[1].data.relatedItems, [{
    repo: "owner/repo",
    itemType: "pr",
    number: 42,
    title: "Fix a thing",
    url: "https://github.com/owner/repo/pull/42",
  }]);
});

Deno.test("ingest_github_pr_feed classifies actionable PR snapshots", async () => {
  const encoder = new TextEncoder();
  const feedType = "@mgreten/github-pr-feed";
  const feedModelId = "feed-model";
  const entries = [
    {
      name: "review-event",
      version: 1,
      tags: { specName: "feedbackEvent" },
      value: {
        eventId: "event-review-1",
        prNumber: 7,
        prTitle: "fix: small bug",
        prUrl: "https://github.com/owner/repo/pull/7",
        type: "review",
        author: "evrardjp",
        authorType: "User",
        occurredAt: "2026-06-24T12:00:00.000Z",
        detectedAt: "2026-06-24T12:05:00.000Z",
      },
    },
    {
      name: "snapshot-pr-7",
      version: 2,
      metadata: { tags: { specName: "prSnapshot" } },
      value: {
        prNumber: 7,
        prTitle: "fix: small bug",
        prUrl: "https://github.com/owner/repo/pull/7",
        headSha: "abc123",
        state: "OPEN",
        merged: false,
        author: "contributor",
        isDraft: false,
        labels: ["bug"],
        lastCodeChangeAt: "2026-06-24T11:00:00.000Z",
        lastConversationAt: "2026-06-24T12:00:00.000Z",
        discussionCount: 2,
        additions: 10,
        deletions: 5,
        changedFiles: 1,
        reviewState: "review_required",
        checksState: "success",
        mergeable: "MERGEABLE",
        lastPollAt: "2026-06-24T13:00:00.000Z",
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
  const ingestContext = {
    ...context,
    dataRepository: {
      findAllForModel: async (modelType: unknown, modelId: string) => {
        assertEquals(modelType, feedType);
        assertEquals(modelId, feedModelId);
        return entries.map(({ name, version, tags, metadata }) => ({
          name,
          version,
          tags,
          metadata,
        }));
      },
      getContent: async (
        modelType: unknown,
        modelId: string,
        dataName: string,
        version?: number,
      ) => {
        assertEquals(modelType, feedType);
        assertEquals(modelId, feedModelId);
        return contentByName.get(`${dataName}:${version}`) ?? null;
      },
    },
  };

  const result = await model.methods.ingest_github_pr_feed.execute({
    feedModelId,
    repo: "owner/repo",
    limit: 200,
    includeBots: true,
    personalGithubHandles: ["evrardjp"],
  }, ingestContext);

  assertEquals(result.dataHandles.length, 2);
  const classification = writes.find((w) => w.specName === "classification");
  assertExists(classification);
  assertEquals(classification.name, "github-snapshot-owner-repo-7-abc123");
  assertEquals(classification.data.readyForMaintainerReview, false);
  assertEquals(classification.data.reviewedByMeSinceLastCodeChange, true);
  assertEquals(classification.data.mergeable, "MERGEABLE");
  assertEquals(classification.data.quickWin, true);
  assertEquals(classification.data.inactive, true);
  assertEquals(classification.data.inactiveDays, 0);
  assertEquals(classification.data.priorityScore, 70);
  assertEquals(classification.data.tags, ["github-pr-feed", "quick-win"]);
});

Deno.test("ingest_github_pr_feed marks old open PR snapshots stale from relevant activity", async () => {
  const encoder = new TextEncoder();
  const feedType = "@mgreten/github-pr-feed";
  const feedModelId = "feed-model";
  const entries = [
    {
      name: "bot-comment",
      version: 1,
      tags: { specName: "feedbackEvent" },
      value: {
        eventId: "event-comment-bot",
        prNumber: 99,
        prTitle: "feat: old provider",
        prUrl: "https://github.com/owner/repo/pull/99",
        type: "issue_comment",
        author: "coderabbitai[bot]",
        authorType: "bot",
        occurredAt: "2026-06-23T12:00:00.000Z",
        detectedAt: "2026-06-23T12:05:00.000Z",
      },
    },
    {
      name: "snapshot-pr-99",
      version: 1,
      tags: { specName: "prSnapshot" },
      value: {
        prNumber: 99,
        prTitle: "feat: old provider",
        prUrl: "https://github.com/owner/repo/pull/99",
        headSha: "oldsha",
        state: "OPEN",
        merged: false,
        author: "contributor",
        isDraft: false,
        labels: ["kind/feature"],
        lastCodeChangeAt: "2026-05-01T00:00:00.000Z",
        lastConversationAt: "2026-06-23T12:00:00.000Z",
        discussionCount: 1,
        additions: 100,
        deletions: 10,
        changedFiles: 3,
        reviewState: "review_required",
        checksState: "success",
        mergeable: "MERGEABLE",
        lastPollAt: "2026-06-24T00:00:00.000Z",
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
  const ingestContext = {
    ...context,
    dataRepository: {
      findAllForModel: async (modelType: unknown, modelId: string) => {
        assertEquals(modelType, feedType);
        assertEquals(modelId, feedModelId);
        return entries.map(({ name, version, tags }) => ({
          name,
          version,
          tags,
        }));
      },
      getContent: async (
        modelType: unknown,
        modelId: string,
        dataName: string,
        version?: number,
      ) => {
        assertEquals(modelType, feedType);
        assertEquals(modelId, feedModelId);
        return contentByName.get(`${dataName}:${version}`) ?? null;
      },
    },
  };

  await model.methods.ingest_github_pr_feed.execute({
    feedModelId,
    repo: "owner/repo",
    limit: 200,
    includeBots: true,
    personalGithubHandles: ["evrardjp"],
  }, ingestContext);

  const classification = writes.find((w) => w.specName === "classification");
  assertExists(classification);
  assertEquals(classification.data.inactive, true);
  assertEquals(classification.data.inactiveDays, 54);
});
