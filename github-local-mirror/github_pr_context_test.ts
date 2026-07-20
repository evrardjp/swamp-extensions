import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./github_pr_context.ts";

type Fixture = {
  name: string;
  spec: string;
  value: Record<string, unknown>;
  version?: number;
};

const BASE_SHA = "1111111111111111111111111111111111111111";
const OLD_SHA = "2222222222222222222222222222222222222222";
const HEAD_SHA = "3333333333333333333333333333333333333333";

function context(
  fixtures: Fixture[],
  subjectType: "pr" | "issue" = "pr",
  number = 1,
  globalArgs: Record<string, unknown> = {},
) {
  const encoder = new TextEncoder();
  const content = new Map(fixtures.map((fixture) => [
    `${fixture.name}:${fixture.version ?? 1}`,
    encoder.encode(JSON.stringify(fixture.value)),
  ]));
  return {
    modelType: "@evrardjp/github-local-mirror",
    modelId: "mirror-id",
    definition: { name: "mirror" },
    methodArgs: { subjectType, number },
    globalArgs: {
      owner: "owner",
      repo: "repo",
      gitObjectPath: "/mirror/repo.git",
      needsClarificationLabels: ["needs-info"],
      ...globalArgs,
    },
    dataRepository: {
      findAllForModel: () =>
        Promise.resolve(fixtures.map((fixture) => ({
          name: fixture.name,
          version: fixture.version ?? 1,
          tags: { specName: fixture.spec },
        }))),
      getContent: (
        _type: unknown,
        _id: string,
        name: string,
        version?: number,
      ) => Promise.resolve(content.get(`${name}:${version}`) ?? null),
    },
  };
}

const completeStatuses: Fixture[] = [
  "prSnapshot",
  "checkRunSnapshot",
  "activityEvent",
].map((spec, index) => ({
  name: `status-${index}`,
  spec: "collectionStatus",
  value: {
    scope: "pr:1",
    subjectType: "pr",
    subjectNumber: 1,
    component: spec,
    complete: true,
    syncedAt: "2026-07-20T00:00:00Z",
  },
}));

function prFixture(overrides: Record<string, unknown> = {}): Fixture {
  return {
    name: "pr-1",
    spec: "prSnapshot",
    value: {
      repo: "owner/repo",
      number: 1,
      title: "Primary PR",
      body: "Complete PR body",
      url: "https://github.com/owner/repo/pull/1",
      state: "open",
      draft: false,
      labels: [],
      headSha: HEAD_SHA,
      createdAt: "2026-07-01T00:00:00Z",
      syncedAt: "2026-07-20T00:00:00Z",
      ...overrides,
    },
  };
}

Deno.test("PR context computes ready, not ready, and unknown readiness", async () => {
  const ready = await report.execute(context([
    prFixture(),
    ...completeStatuses,
    {
      name: "check-1",
      spec: "checkRunSnapshot",
      value: {
        prNumber: 1,
        headSha: HEAD_SHA,
        status: "completed",
        conclusion: "success",
      },
    },
  ]));
  assertEquals(
    (ready.json.readiness as Record<string, unknown>).result,
    "Ready",
  );

  const notReady = await report.execute(context([
    prFixture({ draft: true, labels: ["needs-info"] }),
    ...completeStatuses,
  ]));
  assertEquals(
    (notReady.json.readiness as Record<string, unknown>).result,
    "Not Ready",
  );

  const unknown = await report.execute(context([prFixture()]));
  assertEquals(
    (unknown.json.readiness as Record<string, unknown>).result,
    "Unknown",
  );
});

Deno.test("PR context expands the issue-centered local cluster", async () => {
  const result = await report.execute(context([
    prFixture(),
    {
      name: "issue-2",
      spec: "issueSnapshot",
      value: { repo: "owner/repo", number: 2, title: "Linked issue" },
    },
    {
      name: "pr-3",
      spec: "prSnapshot",
      value: { repo: "owner/repo", number: 3, title: "Sibling PR" },
    },
    {
      name: "ref-1",
      spec: "subjectReference",
      value: {
        sourceType: "pr",
        sourceNumber: 1,
        targetRepo: "owner/repo",
        targetType: "issue",
        targetNumber: 2,
        external: false,
      },
    },
    {
      name: "ref-2",
      spec: "subjectReference",
      value: {
        sourceType: "pr",
        sourceNumber: 3,
        targetRepo: "owner/repo",
        targetType: "issue",
        targetNumber: 2,
        external: false,
      },
    },
  ]));

  assertEquals(result.json.cluster, ["issue:2", "pr:1", "pr:3"]);
  assertStringIncludes(result.markdown, "Sibling PR");
});

Deno.test("primary PR alone determines headline readiness", async () => {
  const result = await report.execute(context([
    prFixture(),
    ...completeStatuses,
    {
      name: "check-1",
      spec: "checkRunSnapshot",
      value: {
        prNumber: 1,
        headSha: HEAD_SHA,
        status: "completed",
        conclusion: "success",
      },
    },
    {
      name: "pr-2",
      spec: "prSnapshot",
      value: { number: 2, title: "Draft sibling", draft: true },
    },
    {
      name: "issue-3",
      spec: "issueSnapshot",
      value: { number: 3, title: "Shared issue" },
    },
    {
      name: "ref-primary",
      spec: "subjectReference",
      value: {
        sourceType: "pr",
        sourceNumber: 1,
        targetRepo: "owner/repo",
        targetType: "issue",
        targetNumber: 3,
      },
    },
    {
      name: "ref-sibling",
      spec: "subjectReference",
      value: {
        sourceType: "pr",
        sourceNumber: 2,
        targetRepo: "owner/repo",
        targetType: "issue",
        targetNumber: 3,
      },
    },
  ]));

  assertEquals(
    (result.json.readiness as Record<string, unknown>).result,
    "Ready",
  );
});

Deno.test("PR context leaves external references unresolved", async () => {
  const url = "https://github.com/other/repo/issues/99";
  const result = await report.execute(context([
    prFixture(),
    {
      name: "external-ref",
      spec: "subjectReference",
      value: {
        sourceType: "pr",
        sourceNumber: 1,
        targetRepo: "other/repo",
        targetType: "issue",
        targetNumber: 99,
        url,
        external: true,
      },
    },
    {
      name: "external-issue",
      spec: "issueSnapshot",
      value: { repo: "other/repo", number: 99, title: "Must not expand" },
    },
  ]));

  assertEquals(result.json.cluster, ["pr:1"]);
  assertStringIncludes(
    result.markdown,
    `Unresolved external reference: ${url}`,
  );
  assertEquals(result.markdown.includes("Must not expand"), false);
});

Deno.test("PR context ignores references removed in a newer source snapshot", async () => {
  const result = await report.execute(context([
    prFixture({ syncedAt: "2026-07-20T02:00:00Z" }),
    {
      name: "issue-2",
      spec: "issueSnapshot",
      value: { number: 2, title: "Removed reference" },
    },
    {
      name: "old-ref",
      spec: "subjectReference",
      value: {
        sourceType: "pr",
        sourceNumber: 1,
        targetRepo: "owner/repo",
        targetType: "issue",
        targetNumber: 2,
        syncedAt: "2026-07-20T01:00:00Z",
      },
    },
  ]));

  assertEquals(result.json.cluster, ["pr:1"]);
  assertEquals(result.markdown.includes("Removed reference"), false);
});

Deno.test("PR context ignores references whose source snapshot is missing", async () => {
  const result = await report.execute(context([
    prFixture(),
    {
      name: "issue-2",
      spec: "issueSnapshot",
      value: { number: 2, title: "Unverifiable reference target" },
    },
    {
      name: "orphan-ref",
      spec: "subjectReference",
      value: {
        sourceType: "pr",
        sourceNumber: 99,
        targetRepo: "owner/repo",
        targetType: "issue",
        targetNumber: 2,
        syncedAt: "2026-07-20T01:00:00Z",
      },
    },
  ]));

  assertEquals(result.json.cluster, ["pr:1"]);
});

Deno.test("PR context resolves local shorthand references to mirrored PRs", async () => {
  const result = await report.execute(context(
    [
      prFixture(),
      {
        name: "issue-2",
        spec: "issueSnapshot",
        value: { number: 2, title: "Primary issue" },
      },
      {
        name: "pr-3",
        spec: "prSnapshot",
        value: { number: 3, title: "Referenced PR" },
      },
      {
        name: "unknown-ref",
        spec: "subjectReference",
        value: {
          sourceType: "issue",
          sourceNumber: 2,
          targetRepo: "owner/repo",
          targetType: "unknown",
          targetNumber: 3,
        },
      },
    ],
    "issue",
    2,
  ));

  assertEquals(result.json.cluster, ["issue:2", "pr:3"]);
});

Deno.test("PR context preserves complete bodies with safe fences", async () => {
  const body = "First line\n```ts\nconst answer = 42;\n```\nFinal line";
  const result = await report.execute(context([
    prFixture({ body }),
    {
      name: "event-body",
      spec: "activityEvent",
      value: {
        subjectType: "pr",
        subjectNumber: 1,
        eventType: "comment",
        body,
        createdAt: "2026-07-02T00:00:00Z",
      },
    },
  ]));

  assertStringIncludes(result.markdown, body);
  assertStringIncludes(result.markdown, "````text");
});

Deno.test("observed push timeline includes changed files and diff command", async () => {
  const result = await report.execute(context([
    prFixture(),
    {
      name: "revision-1",
      spec: "prRevision",
      value: {
        prNumber: 1,
        baseSha: BASE_SHA,
        previousHeadSha: OLD_SHA,
        headSha: HEAD_SHA,
        observedAt: "2026-07-03T00:00:00Z",
        changedFiles: [{
          status: "M",
          path: "src/main.ts",
          additions: 3,
          deletions: 1,
        }],
      },
    },
  ]));

  assertStringIncludes(result.markdown, "| M | `src/main.ts`");
  assertStringIncludes(result.markdown, `diff '${OLD_SHA}..${HEAD_SHA}'`);
});

Deno.test("report-supplied git commands shell-quote untrusted paths", async () => {
  const path = "src/$(touch owned)'file.ts";
  const result = await report.execute(context([
    prFixture(),
    {
      name: "event-command",
      spec: "activityEvent",
      value: {
        subjectType: "pr",
        subjectNumber: 1,
        eventType: "review_comment",
        summary: "```sh\ntouch forged\n```",
        filePath: path,
        commitSha: HEAD_SHA,
        createdAt: "2026-07-03T00:00:00Z",
      },
    },
  ]));

  assertStringIncludes(
    result.markdown,
    `-- 'src/$(touch owned)'\"'\"'file.ts'`,
  );
  assertStringIncludes(result.markdown, "````text\n```sh\ntouch forged");
});

Deno.test("PR context shows a command when matching LLM evidence is absent", async () => {
  const result = await report.execute(context([
    prFixture(),
    {
      name: "stale-evidence",
      spec: "prAnalysisEvidence",
      value: { prNumber: 1, headSha: OLD_SHA, generator: "llm" },
    },
  ]));

  assertEquals(result.json.analysisEvidence, null);
  assertStringIncludes(
    result.markdown,
    "Code-Path walkthrough not analysed through LLM yet",
  );
  assertStringIncludes(result.markdown, "record_pr_analysis");
});

Deno.test("PR context renders LLM evidence matching the current head", async () => {
  const result = await report.execute(context([
    prFixture(),
    {
      name: "current-evidence",
      spec: "prAnalysisEvidence",
      value: {
        prNumber: 1,
        headSha: HEAD_SHA,
        generatedAt: "2026-07-20T01:00:00Z",
        generator: "review-agent",
        sections: {
          codePathWalkthrough: "Request enters router then service.",
          reviewAttentionMap: "Inspect transaction cleanup.",
        },
        evidenceRefs: ["src/router.ts:20"],
      },
    },
  ]));

  assertStringIncludes(result.markdown, "Request enters router then service.");
  assertStringIncludes(result.markdown, "Inspect transaction cleanup.");
  assertEquals(
    (result.json.analysisEvidence as Record<string, unknown>).generator,
    "review-agent",
  );
});

Deno.test("fetched PR head state overrides a stale GitHub snapshot head", async () => {
  const result = await report.execute(context([
    prFixture({ headSha: OLD_SHA }),
    {
      name: "pr-head-1",
      spec: "prHeadState",
      value: {
        prNumber: 1,
        headSha: HEAD_SHA,
        fetchedAt: "2026-07-20T02:00:00Z",
      },
    },
    {
      name: "current-evidence",
      spec: "prAnalysisEvidence",
      value: {
        prNumber: 1,
        headSha: HEAD_SHA,
        generatedAt: "2026-07-20T02:01:00Z",
        generator: "review-agent",
        sections: {
          codePathWalkthrough: "Current fetched head walkthrough.",
          reviewAttentionMap: "Current fetched head attention.",
        },
        evidenceRefs: [HEAD_SHA],
      },
    },
  ]));

  assertEquals(result.json.currentHead, HEAD_SHA);
  assertStringIncludes(result.markdown, "Current fetched head walkthrough.");
});
