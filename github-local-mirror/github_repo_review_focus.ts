type DataEntry = {
  name: string;
  version?: number;
  tags?: Record<string, string>;
  metadata?: { tags?: Record<string, string> };
};

type ReportContext = {
  modelType?: { normalized?: string } | string;
  modelId?: string;
  definition?: { id?: string; name?: string };
  globalArgs?: Record<string, unknown>;
  dataRepository?: {
    findAllForModel(modelType: unknown, modelId: string): Promise<DataEntry[]>;
    getContent(
      modelType: unknown,
      modelId: string,
      dataName: string,
      version?: number,
    ): Promise<Uint8Array | null>;
  };
};

type Value = Record<string, unknown>;
type StoredValue = Value & { _dataName: string; _dataVersion: number };
type CiState = "passing" | "failing" | "pending" | "unknown";
type Bucket = typeof BUCKETS[number];

type PrView = {
  number: number;
  title: string;
  author: string;
  url: string;
  labels: string[];
  areaLabels: string[];
  requestedReviewers: string[];
  requestedConfiguredReviewers: string[];
  latestConfiguredReview: Review | null;
  latestReview: Review | null;
  latestChangesRequestedReview: Review | null;
  latestAuthorUpdateAt: string | null;
  authorUpdatedAfterReview: boolean;
  authorUpdatedAfterChangesRequest: boolean;
  currentHead: string | null;
  snapshotHead: string | null;
  ciState: CiState;
  reviewDecision: string | null;
  draft: boolean | null;
  mergeable: boolean | null;
  mergeableState: string | null;
  latestHumanActivityAt: string | null;
  inactivityDays: number | null;
  reviewerWaitDays: number | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  changedPaths: string[];
  collections: Record<string, boolean | null>;
  dataComplete: boolean;
  dataErrors: string[];
  primaryBucket: Bucket;
  classificationReason: string;
  secondaryWarnings: string[];
};

type Review = {
  actor: string;
  state: string;
  createdAt: string;
  commitSha: string | null;
  dataName: string;
  dataVersion: number;
};

const BUCKETS = [
  "Re-review Now",
  "Requested From You",
  "Unassigned Review Candidates",
  "Merge/Final-Check Candidates",
  "Waiting On Author",
  "CI Blocked",
  "Data Incomplete",
  "Stale/Defer",
  "Drafts",
] as const;

const CLASSIFICATION_PRECEDENCE: Bucket[] = [
  "Re-review Now",
  "Requested From You",
  "Drafts",
  "Data Incomplete",
  "Waiting On Author",
  "CI Blocked",
  "Stale/Defer",
  "Merge/Final-Check Candidates",
  "Unassigned Review Candidates",
];

const EXPECTED_SPECS = new Set([
  "prSnapshot",
  "prHeadState",
  "checkRunSnapshot",
  "activityEvent",
  "prRevision",
  "prFileSnapshot",
  "collectionStatus",
  "syncRunSummary",
  "mirrorState",
]);

const REQUIRED_COLLECTIONS = [
  "prSnapshot",
  "checkRunSnapshot",
  "activityEvent",
] as const;

const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const FAILING_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale",
]);

function normalizedType(value: ReportContext["modelType"]): string {
  return typeof value === "string" ? value : value?.normalized ?? "";
}

function tagsOf(entry: DataEntry): Record<string, string> {
  return entry.tags ?? entry.metadata?.tags ?? {};
}

function stringField(value: Value, field: string): string {
  return typeof value[field] === "string" ? value[field] as string : "";
}

function nullableString(value: Value, field: string): string | null {
  return stringField(value, field) || null;
}

function numberField(value: Value, field: string): number | undefined {
  const number = Number(value[field]);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function nullableNumber(value: Value, field: string): number | null {
  return typeof value[field] === "number" && Number.isFinite(value[field])
    ? value[field] as number
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeHandle(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  return [
    ...new Map(values.map((value) => [value.toLowerCase(), value])).values(),
  ];
}

function dateMs(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function latestDate(values: Array<unknown>): string | null {
  let latest: string | null = null;
  let latestMs = -Infinity;
  for (const value of values) {
    const milliseconds = dateMs(value);
    if (milliseconds !== null && milliseconds > latestMs) {
      latest = value as string;
      latestMs = milliseconds;
    }
  }
  return latest;
}

function daysBetween(earlier: string | null, nowMs: number): number | null {
  const earlierMs = dateMs(earlier);
  return earlierMs === null
    ? null
    : Math.max(0, Math.floor((nowMs - earlierMs) / 86_400_000));
}

function isBot(actor: string): boolean {
  const normalized = normalizeHandle(actor);
  return normalized.endsWith("[bot]") ||
    ["dependabot", "renovate", "github-actions"].includes(normalized);
}

function collectionState(
  statuses: StoredValue[],
  prNumber: number,
  component: string,
): boolean | null {
  const matching = statuses.filter((status) =>
    status.subjectType === "pr" &&
    numberField(status, "subjectNumber") === prNumber &&
    stringField(status, "component").toLowerCase() === component.toLowerCase()
  );
  if (!matching.length) return null;
  return matching.every((status) => status.complete === true);
}

function latestReviews(events: StoredValue[]): Review[] {
  const reviews: Review[] = [];
  for (const event of events) {
    if (stringField(event, "eventType") !== "review_submitted") continue;
    const actor = stringField(event, "actor");
    const createdAt = stringField(event, "createdAt");
    const state = stringField(event, "state").toUpperCase();
    if (!actor || !createdAt || !state) continue;
    const review = {
      actor,
      state,
      createdAt,
      commitSha: nullableString(event, "commitSha"),
      dataName: event._dataName,
      dataVersion: event._dataVersion,
    };
    reviews.push(review);
  }
  return reviews.sort((left, right) =>
    (dateMs(right.createdAt) ?? 0) - (dateMs(left.createdAt) ?? 0) ||
    right.dataVersion - left.dataVersion ||
    right.dataName.localeCompare(left.dataName) ||
    right.actor.localeCompare(left.actor)
  );
}

function activeChangesRequestedReview(reviews: Review[]): Review | null {
  const resolvedActors = new Set<string>();
  for (const review of reviews) {
    const actor = normalizeHandle(review.actor);
    if (resolvedActors.has(actor) || review.state === "COMMENTED") continue;
    resolvedActors.add(actor);
    if (review.state === "CHANGES_REQUESTED") return review;
  }
  return null;
}

function authorUpdatedAfter(
  review: Review | null,
  latestAuthorUpdateAt: string | null,
): boolean {
  if (!review) return false;
  return (dateMs(latestAuthorUpdateAt) ?? -Infinity) >
    (dateMs(review.createdAt) ?? Infinity);
}

function reviewRequestDate(
  events: StoredValue[],
  requestedReviewers: string[],
): string | null {
  const requested = new Set(requestedReviewers.map(normalizeHandle));
  if (!requested.size) return null;
  return latestDate(
    events.filter((event) => {
      if (stringField(event, "eventType") !== "github_review_requested") {
        return false;
      }
      const payload = event.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return false;
      }
      const reviewer = (payload as Value).requested_reviewer;
      return reviewer && typeof reviewer === "object" &&
        !Array.isArray(reviewer) &&
        requested.has(normalizeHandle(stringField(reviewer as Value, "login")));
    }).map((event) => event.createdAt),
  );
}

function ciState(checks: StoredValue[], complete: boolean | null): CiState {
  if (complete !== true || !checks.length) return "unknown";
  let pending = false;
  let unknown = false;
  for (const check of checks) {
    const status = stringField(check, "status").toLowerCase();
    const conclusion = stringField(check, "conclusion").toLowerCase();
    if (FAILING_CONCLUSIONS.has(conclusion)) return "failing";
    if (status !== "completed" || !conclusion) pending = true;
    else if (!PASSING_CONCLUSIONS.has(conclusion)) unknown = true;
  }
  return pending ? "pending" : unknown ? "unknown" : "passing";
}

function labelPriority(labels: string[]): number {
  const normalized = labels.map((label) => label.toLowerCase());
  if (
    normalized.some((label) => /(^|[/: -])(security|bug)([/: -]|$)/.test(label))
  ) {
    return 0;
  }
  if (
    normalized.some((label) =>
      /(^|[/: -])(feature|enhancement)([/: -]|$)/.test(label)
    )
  ) {
    return 1;
  }
  if (
    normalized.some((label) =>
      /(^|[/: -])(chore|dependencies)([/: -]|$)/.test(label)
    )
  ) {
    return 2;
  }
  return 3;
}

function classify(
  view: PrView,
  staleDays: number,
): Pick<PrView, "primaryBucket" | "classificationReason"> {
  if (
    view.latestConfiguredReview && view.authorUpdatedAfterReview &&
    view.latestConfiguredReview.state !== "DISMISSED"
  ) {
    return {
      primaryBucket: "Re-review Now",
      classificationReason:
        "The author updated the PR after your latest review.",
    };
  }
  if (view.requestedConfiguredReviewers.length) {
    return {
      primaryBucket: "Requested From You",
      classificationReason: "A configured reviewer is currently requested.",
    };
  }
  if (view.draft !== false) {
    return view.draft === true
      ? { primaryBucket: "Drafts", classificationReason: "The PR is a draft." }
      : {
        primaryBucket: "Data Incomplete",
        classificationReason: "Draft state is unknown.",
      };
  }
  if (!view.dataComplete) {
    return {
      primaryBucket: "Data Incomplete",
      classificationReason:
        "Required collections or current HEAD data are incomplete.",
    };
  }
  if (
    view.reviewDecision === "CHANGES_REQUESTED" &&
    view.latestChangesRequestedReview &&
    !view.authorUpdatedAfterChangesRequest
  ) {
    return {
      primaryBucket: "Waiting On Author",
      classificationReason:
        "Changes were requested and no later author update was observed.",
    };
  }
  if (view.ciState === "failing") {
    return {
      primaryBucket: "CI Blocked",
      classificationReason: "A current-HEAD check is failing.",
    };
  }
  if (view.inactivityDays !== null && view.inactivityDays >= staleDays) {
    return {
      primaryBucket: "Stale/Defer",
      classificationReason:
        `No recognized human activity for at least ${staleDays} days.`,
    };
  }
  if (view.reviewDecision === "APPROVED" && view.ciState === "passing") {
    return {
      primaryBucket: "Merge/Final-Check Candidates",
      classificationReason: "The PR is approved and current-HEAD checks pass.",
    };
  }
  if (view.reviewDecision === "APPROVED" && view.ciState === "unknown") {
    return {
      primaryBucket: "Data Incomplete",
      classificationReason:
        "The PR is approved, but current-HEAD check readiness is unknown.",
    };
  }
  if (view.reviewDecision === "APPROVED" && view.ciState === "pending") {
    return {
      primaryBucket: "Data Incomplete",
      classificationReason:
        "The PR is approved, but current-HEAD checks are still pending.",
    };
  }
  return {
    primaryBucket: "Unassigned Review Candidates",
    classificationReason:
      "The complete, non-draft PR has no stronger action signal.",
  };
}

function warnings(view: PrView): string[] {
  const result: string[] = [];
  if (view.ciState === "failing") result.push("CI failing");
  if (view.ciState === "pending") result.push("CI pending");
  if (view.ciState === "unknown") result.push("CI unknown");
  if (!view.dataComplete) result.push("Data incomplete");
  if (view.mergeable === false) result.push("Not mergeable");
  else if (!view.mergeableState) result.push("Mergeability unknown");
  return result;
}

function md(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function shellQuote(value: unknown): string {
  return `'${String(value ?? "").replace(/'/g, `'"'"'`)}'`;
}

function renderTable(views: PrView[]): string[] {
  const lines = [
    "| PR | Author | Labels | Reviewers | Decision | CI | Wait/inactive | Size | Warnings |",
    "| --- | --- | --- | --- | --- | --- | ---: | ---: | --- |",
  ];
  for (const view of views) {
    const pr = view.url
      ? `[#${view.number}](${view.url}) ${md(view.title)}`
      : `#${view.number} ${md(view.title)}`;
    const size = `${view.additions ?? "?"}/-${view.deletions ?? "?"}, ${
      view.changedFiles ?? "?"
    } files`;
    lines.push(
      `| ${pr} | ${md(view.author || "unknown")} | ${
        md(view.labels.join(", ") || "none")
      } | ${md(view.requestedReviewers.join(", ") || "none")} | ${
        md(view.reviewDecision ?? "unknown")
      } | ${view.ciState} | ${
        view.reviewerWaitDays ?? view.inactivityDays ?? "?"
      }d | ${size} | ${md(view.secondaryWarnings.join(", ") || "none")} |`,
    );
  }
  return [...lines, ""];
}

/** Model-scope report that deterministically prioritizes all mirrored open PRs. */
export const report = {
  name: "@evrardjp/github-repo-review-focus",
  description:
    "Build a deterministic repository-wide reviewer action queue from stored local-mirror data.",
  scope: "model" as const,
  execute: async (context: ReportContext) => {
    if (normalizedType(context.modelType) !== "@evrardjp/github-local-mirror") {
      return { markdown: "", json: {} };
    }
    const modelId = context.modelId ?? context.definition?.id;
    if (!modelId || !context.dataRepository) {
      return {
        markdown:
          "# GitHub Repository Review Focus\n\nNo Swamp data repository is available.\n",
        json: { error: "missing-data-repository" },
      };
    }

    const generatedAt = new Date().toISOString();
    const nowMs = Date.parse(generatedAt);
    const configuredHandles = uniqueStrings(
      stringArray(context.globalArgs?.reviewerHandles).map((handle) =>
        handle.trim()
      )
        .filter(Boolean),
    );
    const configuredSet = new Set(configuredHandles.map(normalizeHandle));
    const configuredStaleDays = Number(
      context.globalArgs?.reviewFocusStaleDays,
    );
    const staleDays =
      Number.isInteger(configuredStaleDays) && configuredStaleDays > 0
        ? configuredStaleDays
        : 14;
    const owner = String(context.globalArgs?.owner ?? "").trim();
    const repoName = String(context.globalArgs?.repo ?? "").trim();
    const configuredRepo = owner && repoName ? `${owner}/${repoName}` : "";

    const entries = await context.dataRepository.findAllForModel(
      context.modelType,
      modelId,
    );
    const latestEntries = new Map<string, DataEntry>();
    for (const entry of entries) {
      const spec = tagsOf(entry).specName ?? "unknown";
      const key = `${spec}:${entry.name}`;
      const current = latestEntries.get(key);
      if (!current || (entry.version ?? 0) > (current.version ?? 0)) {
        latestEntries.set(key, entry);
      }
    }
    const bySpec = new Map<string, StoredValue[]>();
    const loadErrors: Value[] = [];
    for (const entry of latestEntries.values()) {
      const spec = tagsOf(entry).specName;
      if (!spec || !EXPECTED_SPECS.has(spec)) continue;
      try {
        const content = await context.dataRepository.getContent(
          context.modelType,
          modelId,
          entry.name,
          entry.version,
        );
        if (!content) throw new Error("content is missing");
        const value = JSON.parse(new TextDecoder().decode(content));
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("content is not an object");
        }
        bySpec.set(spec, [...(bySpec.get(spec) ?? []), {
          ...value as Value,
          _dataName: entry.name,
          _dataVersion: entry.version ?? 0,
        }]);
      } catch (error) {
        loadErrors.push({
          specName: spec,
          dataName: entry.name,
          version: entry.version,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const values = (spec: string) => bySpec.get(spec) ?? [];
    const readinessLoadErrors = loadErrors.filter((error) =>
      !["mirrorState", "syncRunSummary"].includes(String(error.specName))
    );
    const statuses = values("collectionStatus");
    const repoPrStatuses = statuses.filter((status) =>
      status.subjectType === "repo" &&
      stringField(status, "component") === "prSnapshot"
    );
    const repoPrCollectionComplete = repoPrStatuses.length
      ? repoPrStatuses.every((status) => status.complete === true)
      : null;
    const headByPr = new Map<number, StoredValue>();
    for (const head of values("prHeadState")) {
      const number = numberField(head, "prNumber");
      if (number) headByPr.set(number, head);
    }
    const repo = configuredRepo ||
      stringField(values("mirrorState")[0] ?? {}, "repo") ||
      stringField(values("prSnapshot")[0] ?? {}, "repo");
    const views: PrView[] = [];

    for (const pr of values("prSnapshot")) {
      if (stringField(pr, "state").toLowerCase() !== "open") continue;
      const number = numberField(pr, "number");
      if (!number) continue;
      const snapshotHead = nullableString(pr, "headSha");
      const currentHead = nullableString(headByPr.get(number) ?? {}, "headSha");
      const prStatuses = Object.fromEntries(
        REQUIRED_COLLECTIONS.map((component) => [
          component,
          collectionState(statuses, number, component),
        ]),
      );
      const dataErrors = statuses.filter((status) =>
        status.subjectType === "pr" &&
        numberField(status, "subjectNumber") === number &&
        status.complete !== true
      ).map((status) =>
        stringField(status, "error") ||
        `${stringField(status, "component")} incomplete`
      );
      if (readinessLoadErrors.length) {
        dataErrors.push(
          `${readinessLoadErrors.length} stored readiness resource(s) could not be loaded`,
        );
      }
      if (repoPrCollectionComplete !== true) {
        dataErrors.push(
          "Repository PR collection completeness is unknown or incomplete",
        );
      }
      if (!currentHead) {
        dataErrors.push("Authoritative current HEAD is unavailable");
      }
      if (currentHead && snapshotHead && currentHead !== snapshotHead) {
        dataErrors.push("Snapshot HEAD differs from the fetched local PR HEAD");
      }
      const dataComplete = REQUIRED_COLLECTIONS.every((component) =>
        prStatuses[component] === true
      ) && repoPrCollectionComplete === true &&
        readinessLoadErrors.length === 0 && Boolean(currentHead) &&
        (!snapshotHead || snapshotHead === currentHead);
      const events = values("activityEvent").filter((event) =>
        event.subjectType === "pr" &&
        numberField(event, "subjectNumber") === number
      );
      const reviews = latestReviews(events);
      const latestConfiguredReview = reviews.find((review) =>
        configuredSet.has(normalizeHandle(review.actor))
      ) ?? null;
      const latestReview = reviews[0] ?? null;
      const latestChangesRequestedReview = activeChangesRequestedReview(
        reviews,
      );
      const author = stringField(pr, "author");
      const authorEventDates = author
        ? events.filter((event) =>
          normalizeHandle(stringField(event, "actor")) ===
            normalizeHandle(author)
        ).map((event) =>
          event.createdAt
        )
        : [];
      const currentRevisions = values("prRevision").filter((revision) =>
        numberField(revision, "prNumber") === number && currentHead &&
        stringField(revision, "headSha") === currentHead &&
        Boolean(stringField(revision, "previousHeadSha"))
      );
      const latestAuthorUpdateAt = latestDate([
        ...authorEventDates,
        ...currentRevisions.map((revision) => revision.observedAt),
      ]);
      const authorUpdatedAfterReview = authorUpdatedAfter(
        latestConfiguredReview,
        latestAuthorUpdateAt,
      );
      const authorUpdatedAfterChangesRequest = authorUpdatedAfter(
        latestChangesRequestedReview,
        latestAuthorUpdateAt,
      );
      const currentChecks = values("checkRunSnapshot").filter((check) =>
        numberField(check, "prNumber") === number && currentHead &&
        stringField(check, "headSha") === currentHead
      );
      const currentFiles = values("prFileSnapshot").filter((file) =>
        numberField(file, "prNumber") === number && currentHead &&
        stringField(file, "headSha") === currentHead
      );
      const labels = stringArray(pr.labels);
      const requestedReviewers = stringArray(pr.requestedReviewers);
      const requestedConfiguredReviewers = requestedReviewers.filter((
        reviewer,
      ) => configuredSet.has(normalizeHandle(reviewer)));
      const requestDate = reviewRequestDate(
        events,
        requestedConfiguredReviewers.length
          ? requestedConfiguredReviewers
          : requestedReviewers,
      );
      const latestHumanActivityAt = latestDate([
        pr.createdAt,
        ...events.filter((event) => {
          const actor = stringField(event, "actor");
          return Boolean(actor) && !isBot(actor);
        }).map((event) => event.createdAt),
      ]);
      const draft = typeof pr.draft === "boolean" ? pr.draft : null;
      const view: PrView = {
        number,
        title: stringField(pr, "title") || "Untitled PR",
        author,
        url: stringField(pr, "url"),
        labels,
        areaLabels: labels.filter((label) =>
          /^(area[/: -]|component[/: -])/i.test(label)
        ),
        requestedReviewers,
        requestedConfiguredReviewers,
        latestConfiguredReview,
        latestReview,
        latestChangesRequestedReview,
        latestAuthorUpdateAt,
        authorUpdatedAfterReview,
        authorUpdatedAfterChangesRequest,
        currentHead,
        snapshotHead,
        ciState: ciState(currentChecks, prStatuses.checkRunSnapshot),
        reviewDecision: nullableString(pr, "reviewDecision")?.toUpperCase() ??
          null,
        draft,
        mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : null,
        mergeableState: nullableString(pr, "mergeableState"),
        latestHumanActivityAt,
        inactivityDays: daysBetween(latestHumanActivityAt, nowMs),
        reviewerWaitDays: daysBetween(requestDate, nowMs),
        additions: nullableNumber(pr, "additions"),
        deletions: nullableNumber(pr, "deletions"),
        changedFiles: nullableNumber(pr, "changedFiles"),
        changedPaths: uniqueStrings(
          currentFiles.map((file) => stringField(file, "path")).filter(Boolean),
        ).sort(),
        collections: prStatuses,
        dataComplete,
        dataErrors: uniqueStrings(dataErrors.filter(Boolean)),
        primaryBucket: "Data Incomplete",
        classificationReason: "Classification pending.",
        secondaryWarnings: [],
      };
      Object.assign(view, classify(view, staleDays));
      view.secondaryWarnings = warnings(view);
      views.push(view);
    }

    views.sort((left, right) => {
      const personal = Number(right.requestedConfiguredReviewers.length > 0) -
        Number(left.requestedConfiguredReviewers.length > 0);
      return personal ||
        labelPriority(left.labels) - labelPriority(right.labels) ||
        (right.reviewerWaitDays ?? right.inactivityDays ?? -1) -
          (left.reviewerWaitDays ?? left.inactivityDays ?? -1) ||
        left.number - right.number;
    });
    const bucketContents = Object.fromEntries(BUCKETS.map((bucket) => [
      bucket,
      views.filter((view) => view.primaryBucket === bucket),
    ])) as Record<Bucket, PrView[]>;
    const bucketCounts = Object.fromEntries(BUCKETS.map((bucket) => [
      bucket,
      bucketContents[bucket].length,
    ]));
    const reviewerLoad = [
      ...views.flatMap((view) => view.requestedReviewers)
        .reduce((map, reviewer) => {
          const key = normalizeHandle(reviewer);
          const current = map.get(key) ?? { reviewer, count: 0 };
          current.count++;
          map.set(key, current);
          return map;
        }, new Map<string, { reviewer: string; count: number }>()).values(),
    ]
      .sort((left, right) =>
        right.count - left.count || left.reviewer.localeCompare(right.reviewer)
      );
    const concentrations = (items: string[]) =>
      [
        ...items.reduce((map, item) => {
          map.set(item, (map.get(item) ?? 0) + 1);
          return map;
        }, new Map<string, number>()).entries(),
      ].map(([name, count]) => ({ name, count }))
        .sort((left, right) =>
          right.count - left.count || left.name.localeCompare(right.name)
        );
    const labelConcentration = concentrations(
      views.flatMap((view) => view.labels),
    );
    const areaConcentration = concentrations(
      views.flatMap((view) => view.areaLabels),
    );
    const pathMap = new Map<string, number[]>();
    for (const view of views) {
      for (const path of view.changedPaths) {
        pathMap.set(path, [...(pathMap.get(path) ?? []), view.number]);
      }
    }
    const changedPathOverlap = [...pathMap.entries()].filter(([, prs]) =>
      prs.length > 1
    )
      .map(([path, prs]) => ({ path, prs: prs.sort((a, b) => a - b) }))
      .sort((left, right) =>
        right.prs.length - left.prs.length ||
        left.path.localeCompare(right.path)
      );
    const largeChanges = views.filter((view) =>
      (view.additions ?? 0) + (view.deletions ?? 0) >= 500 ||
      (view.changedFiles ?? 0) >= 25
    ).sort((left, right) =>
      ((right.additions ?? 0) + (right.deletions ?? 0)) -
        ((left.additions ?? 0) + (left.deletions ?? 0)) ||
      left.number - right.number
    );
    const mirrorState = values("mirrorState")[0];
    const syncSummary =
      values("syncRunSummary").sort((left, right) =>
        (dateMs(right.finishedAt) ?? 0) - (dateMs(left.finishedAt) ?? 0)
      )[0];
    const freshness = {
      mirrorUpdatedAt: nullableString(mirrorState ?? {}, "updatedAt"),
      lastSuccessfulSyncAt:
        mirrorState?.cursor && typeof mirrorState.cursor === "object"
          ? nullableString(mirrorState.cursor as Value, "lastSuccessfulSyncAt")
          : null,
      latestSyncFinishedAt: nullableString(syncSummary ?? {}, "finishedAt"),
      latestSyncComplete: typeof syncSummary?.complete === "boolean"
        ? syncSummary.complete
        : null,
      latestSyncErrors: Array.isArray(syncSummary?.errors)
        ? syncSummary.errors
        : [],
      repositoryPrCollectionComplete: repoPrCollectionComplete,
      loadErrors,
      incompletePrCount: views.filter((view) => !view.dataComplete).length,
    };

    const lines = [
      `# GitHub Repository Review Focus: ${repo || "unknown repository"}`,
      "",
      `Generated: ${generatedAt}`,
      `Scope: all open PRs stored by the model. This is repo-wide and does not use \`reviewSelection\`.`,
      `Configured reviewers: ${
        configuredHandles.length
          ? configuredHandles.map((handle) => `@${handle}`).join(", ")
          : "none"
      }`,
      `Stale threshold: ${staleDays} days`,
      `Latest successful sync: ${
        freshness.lastSuccessfulSyncAt ?? "unknown"
      }; incomplete PR data: ${freshness.incompletePrCount}; load errors: ${loadErrors.length}`,
      `Repository PR collection complete: ${
        freshness.repositoryPrCollectionComplete ?? "unknown"
      }.`,
      "",
      "Ordering is deterministic: personal obligations, security/bug labels, feature labels, chore labels, longest known wait, then PR number.",
      "Classification precedence is Re-review, Requested, Draft, Data Incomplete, Waiting On Author, CI Blocked, Stale, Merge/Final-Check, then Unassigned.",
      "",
      "## Your Queue",
      "",
      `Re-review now: ${bucketCounts["Re-review Now"]}; requested from you: ${
        bucketCounts["Requested From You"]
      }; total open: ${views.length}.`,
      "",
    ];
    for (const bucket of BUCKETS) {
      if (!bucketContents[bucket].length) continue;
      lines.push(
        `## ${bucket} (${bucketContents[bucket].length})`,
        "",
        ...renderTable(bucketContents[bucket]),
      );
    }
    lines.push("## Requested-Review Load", "");
    if (reviewerLoad.length) {
      lines.push(
        "| Reviewer | Open requests |",
        "| --- | ---: |",
        ...reviewerLoad.map((item) =>
          `| @${md(item.reviewer)} | ${item.count} |`
        ),
        "",
      );
    } else lines.push("_No requested reviewers are stored._", "");
    lines.push("## Label And Area Concentration", "");
    lines.push(
      `Labels: ${
        labelConcentration.map((item) => `${md(item.name)} (${item.count})`)
          .join(", ") || "none"
      }`,
    );
    lines.push(
      `Areas: ${
        areaConcentration.map((item) => `${md(item.name)} (${item.count})`)
          .join(", ") || "none"
      }`,
      "",
    );
    lines.push(
      "## Large-Change Review Candidates",
      "",
      "Large means at least 500 changed lines or 25 changed files.",
      "",
    );
    if (largeChanges.length) lines.push(...renderTable(largeChanges));
    else lines.push("_No large changes matched the documented threshold._", "");
    lines.push(
      "## Overlapping Changed Paths",
      "",
      "This is factual overlap only; frequent paths are not inherently risky.",
      "",
    );
    if (changedPathOverlap.length) {
      lines.push(
        "| Path | Open PRs |",
        "| --- | --- |",
        ...changedPathOverlap.map((item) =>
          `| ${md(item.path)} | ${
            item.prs.map((number) => `#${number}`).join(", ")
          } |`
        ),
        "",
      );
    } else lines.push("_No current-HEAD path overlap was found._", "");
    lines.push("## Stale Backlog", "");
    if (bucketContents["Stale/Defer"].length) {
      lines.push(...renderTable(bucketContents["Stale/Defer"]));
    } else lines.push("_No PRs meet the stale threshold._", "");
    lines.push(
      "## Complete Classification Appendix",
      "",
      "| PR | Primary bucket | Reason |",
      "| ---: | --- | --- |",
      ...views.slice().sort((a, b) => a.number - b.number).map((view) =>
        `| #${view.number} | ${view.primaryBucket} | ${
          md(view.classificationReason)
        } |`
      ),
      "",
    );
    const firstPr = BUCKETS.flatMap((bucket) => bucketContents[bucket])[0];
    if (firstPr) {
      const modelName = context.definition?.name ?? modelId;
      const command = `swamp model method run ${
        shellQuote(modelName)
      } prepare_review_context --input subjectType=pr --input number=${firstPr.number} && swamp report get @evrardjp/github-pr-context --model ${
        shellQuote(modelName)
      } --markdown`;
      lines.push(
        `If you want to see PR #${firstPr.number}, run:`,
        "",
        "```sh",
        command,
        "```",
        "",
      );
    }

    return {
      markdown: lines.join("\n"),
      json: {
        repository: repo || null,
        generatedAt,
        configuredReviewerHandles: configuredHandles,
        staleThresholdDays: staleDays,
        freshness,
        classificationPrecedence: CLASSIFICATION_PRECEDENCE,
        orderingRules: [
          "personal review obligations",
          "security and bug labels",
          "feature labels",
          "chore labels",
          "longest known reviewer wait",
          "PR number",
        ],
        bucketCounts,
        buckets: bucketContents,
        openPullRequests: views.slice().sort((a, b) => a.number - b.number),
        reviewerLoad,
        labelConcentration,
        areaConcentration,
        largeChanges,
        changedPathOverlap,
      },
    };
  },
};
