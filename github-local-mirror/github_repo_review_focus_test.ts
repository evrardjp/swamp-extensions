import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./github_repo_review_focus.ts";

type Fixture = {
  name: string;
  spec: string;
  value: Record<string, unknown>;
  version?: number;
  legacyTags?: boolean;
  missing?: boolean;
};

const HEAD = "1111111111111111111111111111111111111111";
const OLD_HEAD = "2222222222222222222222222222222222222222";
const RECENT = "2999-01-01T00:00:00Z";
const OLD = "2000-01-01T00:00:00Z";

function context(
  fixtures: Fixture[],
  globalArgs: Record<string, unknown> = {},
) {
  const allFixtures =
    fixtures.some((fixture) =>
        fixture.spec === "collectionStatus" &&
        fixture.value.subjectType === "repo"
      )
      ? fixtures
      : [...fixtures, repoStatus(true)];
  const encoder = new TextEncoder();
  const contents = new Map(
    allFixtures.filter((fixture) => !fixture.missing).map((fixture) => [
      `${fixture.name}:${fixture.version ?? 1}`,
      encoder.encode(JSON.stringify(fixture.value)),
    ]),
  );
  return {
    modelType: "@evrardjp/github-local-mirror",
    modelId: "mirror-id",
    definition: { name: "owner-repo-mirror" },
    globalArgs: {
      owner: "owner",
      repo: "repo",
      reviewerHandles: ["Maintainer", "second-id"],
      reviewFocusStaleDays: 14,
      ...globalArgs,
    },
    dataRepository: {
      findAllForModel: () =>
        Promise.resolve(allFixtures.map((fixture) => ({
          name: fixture.name,
          version: fixture.version ?? 1,
          ...(fixture.legacyTags
            ? { metadata: { tags: { specName: fixture.spec } } }
            : { tags: { specName: fixture.spec } }),
        }))),
      getContent: (
        _type: unknown,
        _id: string,
        name: string,
        version?: number,
      ) => Promise.resolve(contents.get(`${name}:${version}`) ?? null),
    },
  };
}

function repoStatus(complete: boolean): Fixture {
  return {
    name: "status-repo-prs",
    spec: "collectionStatus",
    value: {
      subjectType: "repo",
      component: "prSnapshot",
      complete,
      itemCount: 1,
      syncedAt: RECENT,
    },
  };
}

function pr(number: number, overrides: Record<string, unknown> = {}): Fixture {
  return {
    name: `pr-${number}`,
    spec: "prSnapshot",
    value: {
      repo: "owner/repo",
      number,
      title: `PR ${number}`,
      state: "open",
      draft: false,
      author: `author-${number}`,
      labels: [],
      requestedReviewers: [],
      headSha: HEAD,
      createdAt: RECENT,
      syncedAt: RECENT,
      ...overrides,
    },
  };
}

function head(number: number): Fixture {
  return {
    name: `head-${number}`,
    spec: "prHeadState",
    value: { prNumber: number, headSha: HEAD, fetchedAt: RECENT },
  };
}

function statuses(number: number, complete = true): Fixture[] {
  return ["prSnapshot", "checkRunSnapshot", "activityEvent"].map((
    component,
  ) => ({
    name: `status-${number}-${component}`,
    spec: "collectionStatus",
    value: {
      subjectType: "pr",
      subjectNumber: number,
      component,
      complete,
      itemCount: 1,
      syncedAt: RECENT,
    },
  }));
}

function check(
  number: number,
  conclusion = "success",
  headSha = HEAD,
): Fixture {
  return {
    name: `check-${number}-${headSha}-${conclusion}`,
    spec: "checkRunSnapshot",
    value: {
      prNumber: number,
      headSha,
      name: "test",
      status: "completed",
      conclusion,
      completedAt: RECENT,
      syncedAt: RECENT,
    },
  };
}

function event(
  number: number,
  actor: string,
  state: string,
  createdAt = RECENT,
  commitSha = HEAD,
): Fixture {
  return {
    name: `event-${number}-${actor}-${state}`,
    spec: "activityEvent",
    value: {
      subjectType: "pr",
      subjectNumber: number,
      eventType: "review_submitted",
      actor,
      state,
      commitSha,
      createdAt,
      syncedAt: RECENT,
    },
  };
}

function bucket(
  result: Awaited<ReturnType<typeof report.execute>>,
  number: number,
) {
  const prs = result.json.openPullRequests as Array<Record<string, unknown>>;
  return prs.find((pr) => pr.number === number)?.primaryBucket;
}

Deno.test("review focus classifies every open PR exactly once", async () => {
  const fixtures: Fixture[] = [];
  for (let number = 1; number <= 9; number++) {
    fixtures.push(pr(number), head(number), ...statuses(number), check(number));
  }
  fixtures.push(
    event(1, "MAINTAINER", "COMMENTED", OLD, OLD_HEAD),
    {
      name: "revision-1",
      spec: "prRevision",
      value: {
        prNumber: 1,
        headSha: HEAD,
        previousHeadSha: OLD_HEAD,
        observedAt: RECENT,
      },
    },
    event(2, "someone", "COMMENTED"),
    event(3, "reviewer", "CHANGES_REQUESTED"),
    check(4, "failure", OLD_HEAD),
  );
  Object.assign(fixtures.find((item) => item.name === "pr-2")!.value, {
    requestedReviewers: ["second-id"],
  });
  Object.assign(fixtures.find((item) => item.name === "pr-3")!.value, {
    reviewDecision: "CHANGES_REQUESTED",
  });
  Object.assign(fixtures.find((item) => item.name === "pr-4")!.value, {
    reviewDecision: "APPROVED",
  });
  fixtures.find((item) => item.name === `check-5-${HEAD}-success`)!.value
    .conclusion = "failure";
  Object.assign(fixtures.find((item) => item.name === "pr-6")!.value, {
    draft: true,
  });
  Object.assign(fixtures.find((item) => item.name === "pr-7")!.value, {
    createdAt: OLD,
  });
  fixtures.push({
    name: "bot-7",
    spec: "activityEvent",
    value: {
      subjectType: "pr",
      subjectNumber: 7,
      eventType: "comment",
      actor: "automation[bot]",
      createdAt: RECENT,
    },
  });
  fixtures.splice(
    fixtures.findIndex((item) => item.name === "status-9-activityEvent"),
    1,
  );

  const result = await report.execute(context(fixtures));
  assertEquals(bucket(result, 1), "Re-review Now");
  assertEquals(bucket(result, 2), "Requested From You");
  assertEquals(bucket(result, 3), "Waiting On Author");
  assertEquals(bucket(result, 4), "Merge/Final-Check Candidates");
  assertEquals(bucket(result, 5), "CI Blocked");
  assertEquals(bucket(result, 6), "Drafts");
  assertEquals(bucket(result, 7), "Stale/Defer");
  assertEquals(bucket(result, 8), "Unassigned Review Candidates");
  assertEquals(bucket(result, 9), "Data Incomplete");
  const buckets = result.json.buckets as Record<string, unknown[]>;
  assertEquals(
    Object.values(buckets).reduce((sum, values) => sum + values.length, 0),
    9,
  );
  assertStringIncludes(result.markdown, "If you want to see PR #1, run:");
  assertStringIncludes(
    result.markdown,
    "prepare_review_context --input subjectType=pr --input number=1",
  );
});

Deno.test("review focus ignores stale-head failures and bot activity", async () => {
  const result = await report.execute(context([
    pr(10, { reviewDecision: "APPROVED", createdAt: OLD }),
    head(10),
    ...statuses(10),
    check(10, "failure", OLD_HEAD),
    check(10),
    {
      name: "bot-10",
      spec: "activityEvent",
      value: {
        subjectType: "pr",
        subjectNumber: 10,
        eventType: "comment",
        actor: "dependabot[bot]",
        createdAt: RECENT,
      },
    },
    {
      name: "actorless-10",
      spec: "activityEvent",
      value: {
        subjectType: "pr",
        subjectNumber: 10,
        eventType: "synchronized",
        createdAt: RECENT,
      },
    },
    {
      name: "revision-10",
      spec: "prRevision",
      value: {
        prNumber: 10,
        headSha: HEAD,
        previousHeadSha: OLD_HEAD,
        observedAt: RECENT,
      },
    },
  ]));
  assertEquals(bucket(result, 10), "Stale/Defer");
  const view =
    (result.json.openPullRequests as Array<Record<string, unknown>>)[0];
  assertEquals(view.ciState, "passing");
});

Deno.test("review focus preserves older shapes and no-reviewer configuration", async () => {
  const oldShape = pr(11, {
    requestedReviewers: undefined,
    labels: undefined,
    additions: undefined,
  });
  oldShape.legacyTags = true;
  const result = await report.execute(context([
    oldShape,
    head(11),
    ...statuses(11),
    check(11),
  ], { reviewerHandles: [] }));
  assertEquals(bucket(result, 11), "Unassigned Review Candidates");
  assertEquals(result.json.configuredReviewerHandles, []);
});

Deno.test("review focus sorting uses label priority and PR number tie-breaker", async () => {
  const fixtures = [
    pr(20, { labels: ["feature"] }),
    pr(19, { labels: ["bug"] }),
    pr(18, { labels: ["bug"] }),
  ].flatMap((snapshot) => {
    const number = snapshot.value.number as number;
    return [snapshot, head(number), ...statuses(number), check(number)];
  });
  const result = await report.execute(context(fixtures));
  const candidates =
    (result.json.buckets as Record<string, Array<Record<string, unknown>>>)[
      "Unassigned Review Candidates"
    ];
  assertEquals(candidates.map((candidate) => candidate.number), [18, 19, 20]);
});

Deno.test("approved PRs require passing current-head checks for merge candidacy", async () => {
  const unknown = await report.execute(context([
    pr(30, { reviewDecision: "APPROVED" }),
    head(30),
    ...statuses(30),
  ]));
  assertEquals(bucket(unknown, 30), "Data Incomplete");

  const pendingCheck = check(31);
  pendingCheck.value.status = "in_progress";
  pendingCheck.value.conclusion = null;
  const pending = await report.execute(context([
    pr(31, { reviewDecision: "APPROVED" }),
    head(31),
    ...statuses(31),
    pendingCheck,
  ]));
  assertEquals(bucket(pending, 31), "Data Incomplete");
  assertEquals(
    (pending.json.openPullRequests as Array<Record<string, unknown>>)[0]
      .ciState,
    "pending",
  );
});

Deno.test("author response is compared with the active changes request", async () => {
  const result = await report.execute(context([
    pr(32, { reviewDecision: "CHANGES_REQUESTED" }),
    head(32),
    ...statuses(32),
    check(32),
    event(32, "reviewer-a", "CHANGES_REQUESTED", OLD, OLD_HEAD),
    event(32, "reviewer-b", "COMMENTED", RECENT, HEAD),
    {
      name: "revision-32",
      spec: "prRevision",
      value: {
        prNumber: 32,
        headSha: HEAD,
        previousHeadSha: OLD_HEAD,
        observedAt: RECENT,
      },
    },
  ]));
  assertEquals(bucket(result, 32), "Unassigned Review Candidates");
  const view =
    (result.json.openPullRequests as Array<Record<string, unknown>>)[0];
  assertEquals(view.authorUpdatedAfterChangesRequest, true);
});

Deno.test("a later comment does not clear the same reviewer's change request", async () => {
  const changeRequest = event(
    35,
    "reviewer-a",
    "CHANGES_REQUESTED",
    OLD,
    HEAD,
  );
  changeRequest.name = "a-change-request";
  const comment = event(35, "reviewer-a", "COMMENTED", RECENT, HEAD);
  comment.name = "z-comment";
  const result = await report.execute(context([
    pr(35, { reviewDecision: "CHANGES_REQUESTED" }),
    head(35),
    ...statuses(35),
    check(35),
    changeRequest,
    comment,
  ]));
  assertEquals(bucket(result, 35), "Waiting On Author");
});

Deno.test("resource load failures downgrade readiness confidence", async () => {
  const missingCheck = check(33);
  missingCheck.missing = true;
  const result = await report.execute(context([
    pr(33),
    head(33),
    ...statuses(33),
    missingCheck,
    pr(39, { reviewDecision: "APPROVED" }),
    head(39),
    ...statuses(39),
    check(39),
  ]));
  assertEquals(bucket(result, 33), "Data Incomplete");
  assertEquals(bucket(result, 39), "Merge/Final-Check Candidates");
  assertEquals(
    (result.json.freshness as Record<string, unknown>).loadErrors instanceof
      Array,
    true,
  );
});

Deno.test("snapshot HEAD is required for readiness", async () => {
  const result = await report.execute(context([
    pr(42, { headSha: undefined, reviewDecision: "APPROVED" }),
    head(42),
    ...statuses(42),
    check(42),
  ]));
  assertEquals(bucket(result, 42), "Data Incomplete");
  const view =
    (result.json.openPullRequests as Array<Record<string, unknown>>)[0];
  assertEquals(view.snapshotHead, null);
});

Deno.test("drill-down recommendation follows classification precedence", async () => {
  const result = await report.execute(context([
    pr(43),
    head(43),
    ...statuses(43),
    check(43),
    pr(44, { reviewDecision: "APPROVED" }),
    head(44),
    ...statuses(44),
    check(44),
  ]));
  assertStringIncludes(result.markdown, "If you want to see PR #44, run:");
});

Deno.test("same-name current-head check failures remain blocking", async () => {
  const failing = check(34, "failure");
  failing.name = "a-check";
  const passing = check(34, "success");
  passing.name = "z-check";
  const common = [
    pr(34, { reviewDecision: "APPROVED" }),
    head(34),
    ...statuses(34),
  ];
  const forward = await report.execute(context([...common, failing, passing]));
  const reverse = await report.execute(context([...common, passing, failing]));
  assertEquals(bucket(forward, 34), "CI Blocked");
  assertEquals(bucket(reverse, 34), "CI Blocked");
});

Deno.test("author reply after a current-head review triggers re-review", async () => {
  const result = await report.execute(context([
    pr(38),
    head(38),
    ...statuses(38),
    check(38),
    event(38, "maintainer", "CHANGES_REQUESTED", OLD, HEAD),
    {
      name: "author-reply-38",
      spec: "activityEvent",
      value: {
        subjectType: "pr",
        subjectNumber: 38,
        eventType: "comment",
        actor: "author-38",
        createdAt: RECENT,
      },
    },
  ]));
  assertEquals(bucket(result, 38), "Re-review Now");
});

Deno.test("stale PRs sort by longest inactivity before PR number", async () => {
  const result = await report.execute(context([
    pr(40, { createdAt: "2001-01-01T00:00:00Z" }),
    head(40),
    ...statuses(40),
    check(40),
    pr(41, { createdAt: "2000-01-01T00:00:00Z" }),
    head(41),
    ...statuses(41),
    check(41),
  ]));
  const stale = (result.json.buckets as Record<
    string,
    Array<Record<string, unknown>>
  >)["Stale/Defer"];
  assertEquals(stale.map((candidate) => candidate.number), [41, 40]);
});

Deno.test("incomplete repository PR collection downgrades known PRs", async () => {
  const result = await report.execute(context([
    pr(36, { reviewDecision: "APPROVED" }),
    head(36),
    ...statuses(36),
    check(36),
    repoStatus(false),
  ]));
  assertEquals(bucket(result, 36), "Data Incomplete");
  assertStringIncludes(
    result.markdown,
    "Repository PR collection complete: false.",
  );
});

Deno.test("configured review ties are deterministic across repository order", async () => {
  const oldReview = event(37, "maintainer", "APPROVED", RECENT, OLD_HEAD);
  oldReview.name = "a-old-review";
  const currentReview = event(37, "second-id", "APPROVED", RECENT, HEAD);
  currentReview.name = "z-current-review";
  const common = [pr(37), head(37), ...statuses(37), check(37)];
  const forward = await report.execute(context([
    ...common,
    oldReview,
    currentReview,
  ]));
  const reverse = await report.execute(context([
    ...common,
    currentReview,
    oldReview,
  ]));
  assertEquals(bucket(forward, 37), "Unassigned Review Candidates");
  assertEquals(bucket(reverse, 37), "Unassigned Review Candidates");
});
