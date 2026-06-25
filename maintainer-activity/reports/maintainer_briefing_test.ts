import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
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

Deno.test("maintainer briefing aggregates latest records and hides smoke-test data", async () => {
  const entries: Entry[] = [
    {
      name: "classification-pr-1",
      version: 1,
      tags: { specName: "classification" },
      value: {
        id: "classification-old",
        repo: "owner/repo",
        itemType: "pr",
        number: 1,
        title: "Old title",
        analyzedAt: "2026-06-23T09:00:00.000Z",
        blockerStatus: "unknown",
        securityRelevant: false,
        inactive: false,
        inactiveDays: 0,
        difficulty: "unknown",
        reviewEffort: "unknown",
        priorityScore: 1,
      },
    },
    {
      name: "classification-pr-1",
      version: 2,
      metadata: { tags: { specName: "classification" } },
      value: {
        id: "classification-new",
        repo: "owner/repo",
        itemType: "pr",
        number: 1,
        title: "Review me",
        url: "https://github.com/owner/repo/pull/1",
        analyzedAt: "2026-06-24T09:00:00.000Z",
        blockerStatus: "maintainer_input_needed",
        blockerReason: "Maintainer review is pending",
        securityRelevant: false,
        inactive: false,
        inactiveDays: 0,
        difficulty: "S",
        reviewEffort: "quick",
        priorityScore: 80,
        recommendedAction: "Review this PR",
        state: "OPEN",
        author: "contributor",
        checksState: "success",
        changedFiles: 2,
        additions: 20,
        deletions: 4,
        readyForMaintainerReview: true,
        tags: ["github-pr-feed"],
      },
    },
    {
      name: "event-pr-1",
      version: 1,
      tags: { specName: "lifecycleEvent" },
      value: {
        id: "event-1",
        repo: "owner/repo",
        itemType: "pr",
        number: 1,
        source: "github",
        actor: "contributor",
        eventType: "review_requested",
        summary: "Review requested",
        createdAt: "2026-06-24T08:00:00.000Z",
      },
    },
    {
      name: "ci-pr-1",
      version: 1,
      tags: { specName: "ciAttention" },
      value: {
        id: "ci-1",
        repo: "owner/repo",
        prNumber: 1,
        workflow: "test",
        conclusion: "failure",
        logUrl: "https://github.com/owner/repo/actions/runs/1/job/2",
        reason: "unit tests failed",
        requiresMaintainerAttention: true,
        observedAt: "2026-06-24T07:00:00.000Z",
      },
    },
    {
      name: "smoke-event",
      version: 1,
      tags: { specName: "lifecycleEvent" },
      value: {
        id: "smoke",
        repo: "owner/repo",
        itemType: "pr",
        number: 99,
        source: "manual",
        actor: "tester",
        eventType: "smoke",
        summary: "Hidden smoke test event",
        createdAt: "2026-06-24T06:00:00.000Z",
        tags: ["smoke-test"],
      },
    },
  ];

  const result = await report.execute({
    modelType: { normalized: "@evrardjp/maintainer-activity" },
    modelId: "model-1",
    definition: { name: "maintainer-activity" },
    dataRepository: repository(entries),
  });

  assertStringIncludes(
    result.markdown,
    "# Maintainer Briefing — maintainer-activity",
  );
  assertStringIncludes(
    result.markdown,
    "Items: **1** · Events: **1** · Classifications: **1** · CI attention: **1**",
  );
  assertStringIncludes(
    result.markdown,
    "maintainer_input_needed, ci attention",
  );
  const ciSection = section(result.markdown, "## CI Attention");
  assertStringIncludes(
    ciSection,
    "### https://github.com/owner/repo/pull/1 @ 2026-06-24T07:00:00.000Z",
  );
  assertStringIncludes(
    ciSection,
    "Workflow name: test\n\nFailing job: https://github.com/owner/repo/actions/runs/1/job/2\n\nError message: unit tests failed",
  );
  assert(!ciSection.includes("| Content |"));
  const json = result.json as Record<string, any>;
  assertEquals(json.counts.items, 1);
  assertEquals(json.needsMyLongerReview[0].key, "owner/repo#pr-1");
  assertEquals(json.needsMyLongerReview[0].reasons, [
    "maintainer_input_needed",
    "ci attention",
  ]);
});

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  assert(start >= 0, `missing heading: ${heading}`);
  const next = markdown.indexOf("\n## ", start + heading.length);
  return next >= 0 ? markdown.slice(start, next) : markdown.slice(start);
}

Deno.test("maintainer briefing renders requested section layout", async () => {
  const entries: Entry[] = [
    {
      name: "classification-security",
      version: 1,
      tags: { specName: "classification" },
      value: {
        id: "security",
        repo: "owner/repo",
        itemType: "issue",
        number: 2,
        title: "Security concern",
        analyzedAt: "2026-06-24T10:00:00.000Z",
        blockerStatus: "unknown",
        securityRelevant: true,
        inactive: false,
        inactiveDays: 0,
        difficulty: "unknown",
        reviewEffort: "unknown",
        priorityScore: 90,
        recommendedAction: "Triage security issue",
      },
    },
    {
      name: "classification-long-review",
      version: 1,
      tags: { specName: "classification" },
      value: {
        id: "long-review",
        repo: "owner/repo",
        itemType: "pr",
        number: 3,
        title: "Needs long review",
        analyzedAt: "2026-06-24T09:00:00.000Z",
        blockerStatus: "maintainer_input_needed",
        securityRelevant: false,
        inactive: false,
        inactiveDays: 0,
        difficulty: "unknown",
        reviewEffort: "deep",
        priorityScore: 80,
        recommendedAction: "Review this PR; you have never reviewed it",
        state: "OPEN",
        author: "contributor",
        checksState: "success",
        changedFiles: 20,
        additions: 1000,
        deletions: 100,
        readyForMaintainerReview: true,
      },
    },
    {
      name: "classification-quick",
      version: 1,
      tags: { specName: "classification" },
      value: {
        id: "quick",
        repo: "owner/repo",
        itemType: "pr",
        number: 4,
        title: "Quick fix",
        analyzedAt: "2026-06-24T08:00:00.000Z",
        blockerStatus: "unknown",
        securityRelevant: false,
        inactive: false,
        inactiveDays: 0,
        difficulty: "S",
        reviewEffort: "quick",
        priorityScore: 70,
        recommendedAction:
          "Review this PR; code has changed since your last review",
        state: "OPEN",
        author: "contributor",
        checksState: "success",
        changedFiles: 1,
        additions: 5,
        deletions: 1,
        readyForMaintainerReview: true,
        quickWin: true,
      },
    },
  ];

  const result = await report.execute({
    modelType: "@evrardjp/maintainer-activity",
    modelId: "model-1",
    definition: { name: "maintainer-activity" },
    dataRepository: repository(entries),
  });

  const markdown = result.markdown;
  assertStringIncludes(markdown, "## Needs my code fixes");
  assertStringIncludes(markdown, "## Security relevant");
  assertStringIncludes(markdown, "## Quick review wins");
  assertStringIncludes(markdown, "## Needs my (longer) review");
  assertStringIncludes(markdown, "## Active in the two days");
  assertStringIncludes(markdown, "## Active this week");
  assertStringIncludes(markdown, "## Active last week");
  assertStringIncludes(markdown, "## Active last month");
  assertStringIncludes(markdown, "## Stale");
  assertStringIncludes(markdown, "## Noteworthy");
  assert(!markdown.includes("## Ready for maintainer review"));
  assert(!markdown.includes("## Needs maintainer decision"));
  assert(!markdown.includes("## Recommend changes/bumps to other authors"));
  assert(!markdown.includes("## Urgent / Noteworthy"));
  assert(!markdown.includes("## Blocked / Needs Input"));
  assert(!markdown.includes("## Low priority / other blocked"));
  assert(
    markdown.indexOf("## Needs my code fixes") <
      markdown.indexOf("## Security relevant"),
  );
  assert(
    markdown.indexOf("## Security relevant") <
      markdown.indexOf("## Quick review wins"),
  );
  assert(
    markdown.indexOf("## Quick review wins") <
      markdown.indexOf("## Needs my (longer) review"),
  );
  assert(
    markdown.indexOf("## Needs my (longer) review") <
      markdown.indexOf("## Active in the two days"),
  );
  assert(
    markdown.indexOf("## Stale") < markdown.indexOf("## Noteworthy"),
  );
  assert(
    !section(markdown, "## Needs my (longer) review").includes(
      "Recommended action",
    ),
  );
  assert(!section(markdown, "## Noteworthy").includes("Recommended action"));

  const json = result.json as Record<string, any>;
  assertEquals(json.security[0].key, "owner/repo#issue-2");
  assertEquals(json.needsMyLongerReview[0].key, "owner/repo#pr-3");
  assertEquals(json.quickWins[0].key, "owner/repo#pr-4");
});

Deno.test("maintainer briefing derives inactive recommended actions", async () => {
  const base = {
    repo: "owner/repo",
    itemType: "pr",
    analyzedAt: "2026-06-24T09:00:00.000Z",
    blockerStatus: "unknown",
    securityRelevant: false,
    inactive: true,
    inactiveDays: 14,
    difficulty: "unknown",
    reviewEffort: "unknown",
    priorityScore: 10,
    state: "OPEN",
    author: "contributor",
  };
  const entries: Entry[] = [
    {
      name: "classification-ci-broken",
      version: 1,
      tags: { specName: "classification" },
      value: {
        ...base,
        id: "ci-broken",
        number: 5,
        title: "CI broken",
        checksState: "failure",
        mergeable: "CONFLICTING",
      },
    },
    {
      name: "classification-changes-requested",
      version: 1,
      tags: { specName: "classification" },
      value: {
        ...base,
        id: "changes-requested",
        number: 6,
        title: "Changes requested",
        checksState: "success",
        reviewState: "changes_requested",
      },
    },
    {
      name: "classification-needs-review",
      version: 1,
      tags: { specName: "classification" },
      value: {
        ...base,
        id: "needs-review",
        number: 7,
        title: "Needs review",
        checksState: "success",
        reviewState: "review_required",
      },
    },
  ];

  const result = await report.execute({
    modelType: "@evrardjp/maintainer-activity",
    modelId: "model-1",
    definition: { name: "maintainer-activity" },
    dataRepository: repository(entries),
  });

  const inactiveSection = section(result.markdown, "## Active last month");
  assertStringIncludes(inactiveSection, "Request the user to fix CI");
  assertStringIncludes(inactiveSection, "Needs code change by author");
  assertStringIncludes(inactiveSection, "Needs another review");
  assertStringIncludes(inactiveSection, "CI is red, has merge conflicts");
  assertStringIncludes(inactiveSection, "has requested changes");
  const json = result.json as Record<string, any>;
  assertEquals(json.inactive.length, 3);
  assertEquals(json.inactiveActiveLastMonth.length, 3);
});

Deno.test("maintainer briefing ignores unrelated model types", async () => {
  const result = await report.execute({
    modelType: "@example/other",
    modelId: "model-1",
    dataRepository: repository([]),
  });

  assertEquals(result, { markdown: "", json: {} });
});
