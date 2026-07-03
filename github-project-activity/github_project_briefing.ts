/**
 * Maintainer briefing report for @evrardjp/github-project-activity.
 *
 * Renders a model-scope briefing from the project activity database resources:
 * snapshots, CI statuses, and chronological activity events.
 *
 * @module
 */

type DataEntry = {
  name: string;
  version: number;
  tags?: Record<string, string>;
  metadata?: { tags?: Record<string, string> };
};

type ReportCtx = {
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

type ActivityEvent = {
  id: string;
  repo: string;
  subjectType: "repo" | "issue" | "pr" | "fork" | "project";
  subjectNumber?: number;
  eventType: string;
  source: string;
  visibility: "public" | "private";
  actor: string;
  summary: string;
  body?: string;
  createdAt: string;
  url?: string;
  filePath?: string;
  state?: string;
  artifactRefs?: string[];
  tags?: string[];
};

type PrSnapshot = {
  repo: string;
  number: number;
  title: string;
  state: string;
  merged?: boolean;
  draft?: boolean;
  author?: string;
  labels?: string[];
  requestedReviewers?: string[];
  reviewDecision?: string;
  reviewersRequestingChanges?: string[];
  mergeConflict?: boolean | "unknown";
  checksState?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  createdAt?: string;
  updatedAt?: string;
  lastCodeChangeAt?: string | null;
  lastConversationAt?: string | null;
  url?: string;
  syncedAt: string;
};

type IssueSnapshot = {
  repo: string;
  number: number;
  title: string;
  state: string;
  author?: string;
  labels?: string[];
  updatedAt?: string;
  lastConversationAt?: string | null;
  url?: string;
  syncedAt: string;
};

type CiStatusSnapshot = {
  repo: string;
  prNumber: number;
  name: string;
  status?: string;
  conclusion?: string | null;
  url?: string;
  detailsUrl?: string;
  artifact?: string;
  completedAt?: string | null;
  syncedAt: string;
};

function normalizedType(
  modelType: { normalized?: string } | string | undefined,
): string {
  if (!modelType) return "";
  if (typeof modelType === "string") return modelType;
  return modelType.normalized ?? "";
}

function tagsOf(entry: DataEntry): Record<string, string> {
  return entry.tags ?? entry.metadata?.tags ?? {};
}

function esc(value: unknown): string {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderTable(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return ["_None._"];
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
}

async function loadLatestBySpec<T>(
  context: ReportCtx,
  entries: DataEntry[],
  spec: string,
): Promise<T[]> {
  const latest = new Map<string, DataEntry>();
  for (const entry of entries.filter((e) => tagsOf(e).specName === spec)) {
    const current = latest.get(entry.name);
    if (!current || entry.version > current.version) {
      latest.set(entry.name, entry);
    }
  }

  const out: T[] = [];
  for (const entry of latest.values()) {
    const bytes = await context.dataRepository?.getContent(
      context.modelType,
      context.modelId!,
      entry.name,
      entry.version,
    );
    if (!bytes) continue;
    out.push(JSON.parse(new TextDecoder().decode(bytes)) as T);
  }
  return out;
}

function daysSince(iso?: string | null): number {
  if (!iso) return 9999;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 9999;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

function isFailing(ci: CiStatusSnapshot): boolean {
  return ["failure", "cancelled", "timed_out", "action_required"].includes(
    String(ci.conclusion ?? "").toLowerCase(),
  );
}

function prKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

/** Model-scope report that renders an actionable maintainer briefing from activity database resources. */
export const report = {
  name: "@evrardjp/github-project-briefing",
  description:
    "Daily maintainer briefing from Swamp project activity snapshots and events",
  scope: "model" as const,
  labels: ["maintainer", "briefing", "github", "activity", "project"],

  execute: async (context: ReportCtx) => {
    if (
      normalizedType(context.modelType) !== "@evrardjp/github-project-activity"
    ) {
      return { markdown: "", json: {} };
    }

    const entries = await context.dataRepository?.findAllForModel(
      context.modelType,
      context.modelId!,
    ) ?? [];

    const includePrivate = context.globalArgs?.includePrivateEvents !== false;
    const prs = await loadLatestBySpec<PrSnapshot>(
      context,
      entries,
      "prSnapshot",
    );
    const issues = await loadLatestBySpec<IssueSnapshot>(
      context,
      entries,
      "issueSnapshot",
    );
    const ciStatuses = await loadLatestBySpec<CiStatusSnapshot>(
      context,
      entries,
      "ciStatusSnapshot",
    );
    const events = (await loadLatestBySpec<ActivityEvent>(
      context,
      entries,
      "activityEvent",
    )).filter((e) => includePrivate || e.visibility !== "private")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const openPrs = prs.filter((pr) =>
      pr.state === "open" || pr.state === "OPEN"
    );
    const ciByPr = new Map<string, CiStatusSnapshot[]>();
    for (const ci of ciStatuses) {
      const key = prKey(ci.repo, ci.prNumber);
      const list = ciByPr.get(key) ?? [];
      list.push(ci);
      ciByPr.set(key, list);
    }

    const failingPrs = openPrs.filter((pr) =>
      pr.checksState === "failure" ||
      (ciByPr.get(prKey(pr.repo, pr.number)) ?? []).some(isFailing)
    );
    const changesRequested = openPrs.filter((pr) =>
      pr.reviewDecision === "CHANGES_REQUESTED" ||
      (pr.reviewersRequestingChanges?.length ?? 0) > 0
    );
    const conflicted = openPrs.filter((pr) => pr.mergeConflict === true);
    const stale = openPrs.filter((pr) =>
      daysSince(pr.lastConversationAt ?? pr.updatedAt) >= 14
    );
    const openIssues = issues.filter((issue) =>
      issue.state === "open" || issue.state === "OPEN"
    );
    const staleIssues = openIssues.filter((issue) =>
      daysSince(issue.lastConversationAt ?? issue.updatedAt) >= 30
    );

    const prRows = (items: PrSnapshot[]) =>
      items.map((pr) => [
        esc(pr.repo),
        esc(`#${pr.number}`),
        esc(pr.title),
        esc(pr.author ?? ""),
        esc(pr.checksState ?? ""),
        esc(pr.reviewDecision ?? ""),
        esc((pr.reviewersRequestingChanges ?? []).join(", ")),
        esc(daysSince(pr.lastConversationAt ?? pr.updatedAt)),
        esc(pr.url ?? ""),
      ]);

    const eventRows = events.slice(0, 30).map((event) => [
      esc(event.createdAt),
      esc(event.visibility),
      esc(event.source),
      esc(event.repo),
      esc(
        `${event.subjectType}${
          event.subjectNumber ? ` #${event.subjectNumber}` : ""
        }`,
      ),
      esc(event.actor),
      esc(event.summary),
    ]);

    const modelName = context.definition?.name ?? context.modelId ??
      "github-project-activity";
    const lines = [
      `# Maintainer Briefing — ${modelName}`,
      "",
      `PR snapshots: **${prs.length}** · Open PRs: **${openPrs.length}** · Issue snapshots: **${issues.length}** · Activity events: **${events.length}** · CI statuses: **${ciStatuses.length}**`,
      "",
      "## Open PRs with failing CI",
      ...renderTable([
        "Repo",
        "PR",
        "Title",
        "Author",
        "CI",
        "Review",
        "Changes requested by",
        "Idle days",
        "URL",
      ], prRows(failingPrs)),
      "",
      "## Open PRs with requested changes",
      ...renderTable([
        "Repo",
        "PR",
        "Title",
        "Author",
        "CI",
        "Review",
        "Changes requested by",
        "Idle days",
        "URL",
      ], prRows(changesRequested)),
      "",
      "## Open PRs with merge conflicts",
      ...renderTable([
        "Repo",
        "PR",
        "Title",
        "Author",
        "CI",
        "Review",
        "Changes requested by",
        "Idle days",
        "URL",
      ], prRows(conflicted)),
      "",
      "## Stale open PRs",
      ...renderTable([
        "Repo",
        "PR",
        "Title",
        "Author",
        "CI",
        "Review",
        "Changes requested by",
        "Idle days",
        "URL",
      ], prRows(stale)),
      "",
      "## Stale open issues",
      ...renderTable(
        ["Repo", "Issue", "Title", "Author", "Idle days", "URL"],
        staleIssues.map((issue) => [
          esc(issue.repo),
          esc(`#${issue.number}`),
          esc(issue.title),
          esc(issue.author ?? ""),
          esc(daysSince(issue.lastConversationAt ?? issue.updatedAt)),
          esc(issue.url ?? ""),
        ]),
      ),
      "",
      "## Recent activity events",
      ...renderTable(
        ["Time", "Visibility", "Source", "Repo", "Subject", "Actor", "Summary"],
        eventRows,
      ),
    ];

    return {
      markdown: `${lines.join("\n")}\n`,
      json: {
        generatedAt: new Date().toISOString(),
        counts: {
          prs: prs.length,
          openPrs: openPrs.length,
          issues: issues.length,
          openIssues: openIssues.length,
          events: events.length,
          ciStatuses: ciStatuses.length,
        },
        failingPrs,
        changesRequested,
        conflicted,
        stalePrs: stale,
        staleIssues,
        recentEvents: events.slice(0, 30),
      },
    };
  },
};
