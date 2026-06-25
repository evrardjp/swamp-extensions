/**
 * Maintainer briefing report for @evrardjp/maintainer-activity.
 *
 * Produces a global briefing and machine-readable item summaries from recorded
 * lifecycle events, classifications, CI attention records, and agent session
 * logs.
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

type LifecycleEvent = {
  id: string;
  repo: string;
  itemType: "issue" | "pr" | "repo" | "project";
  number?: number;
  source: string;
  actor: string;
  eventType: string;
  summary: string;
  body?: string;
  createdAt: string;
  url?: string;
  relatedSessionId?: string;
  tags?: string[];
};

type Classification = {
  id: string;
  repo: string;
  itemType: "issue" | "pr";
  number: number;
  title?: string;
  url?: string;
  analyzedAt: string;
  blockerStatus: string;
  blockerActor?: string;
  blockerReason?: string;
  blockerConfidence?: number;
  securityRelevant: boolean;
  securitySignals?: string[];
  inactive: boolean;
  inactiveDays: number;
  difficulty: string;
  difficultyReason?: string;
  reviewEffort: string;
  reviewMinutes?: number;
  reviewEffortReason?: string;
  priorityScore: number;
  recommendedAction?: string;
  state?: string;
  merged?: boolean;
  author?: string;
  isOwnPr?: boolean;
  isDraft?: boolean;
  labels?: string[];
  checksState?: string;
  reviewState?: string;
  lastCodeChangeAt?: string;
  lastConversationAt?: string;
  discussionCount?: number;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  reviewedByMeSinceLastCodeChange?: boolean;
  needsMyCodeFix?: boolean;
  readyForMaintainerReview?: boolean;
  quickWin?: boolean;
  needsMaintainerDecision?: boolean;
  recommendAuthorAction?: boolean;
  tags?: string[];
};

type CiAttention = {
  id: string;
  repo: string;
  prNumber?: number;
  workflow: string;
  status?: string;
  conclusion?: string;
  url?: string;
  logUrl?: string;
  reason: string;
  requiresMaintainerAttention: boolean;
  observedAt: string;
  tags?: string[];
};

type SessionLog = {
  id: string;
  sessionId: string;
  startedAt?: string;
  endedAt: string;
  cwd?: string;
  summary: string;
  fullLog?: string;
  relatedItems?: Array<{ repo: string; itemType: string; number?: number }>;
  tags?: string[];
};

type ItemSummary = {
  key: string;
  repo: string;
  itemType: string;
  number?: number;
  title?: string;
  url?: string;
  latestClassification?: Classification;
  events: LifecycleEvent[];
  ci: CiAttention[];
  sessions: SessionLog[];
  priorityScore: number;
  reasons: string[];
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

function key(repo: string, itemType: string, number?: number): string {
  return `${repo}#${itemType}${number ? `-${number}` : ""}`;
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

function isSmokeTest(item: { tags?: string[] }): boolean {
  return item.tags?.includes("smoke-test") ?? false;
}

async function loadBySpec<T>(
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

function upsertItem(
  map: Map<string, ItemSummary>,
  repo: string,
  itemType: string,
  number?: number,
): ItemSummary {
  const itemKey = key(repo, itemType, number);
  let item = map.get(itemKey);
  if (!item) {
    item = {
      key: itemKey,
      repo,
      itemType,
      number,
      events: [],
      ci: [],
      sessions: [],
      priorityScore: 0,
      reasons: [],
    };
    map.set(itemKey, item);
  }
  return item;
}

function sortDescTime<T>(
  items: T[],
  getTime: (item: T) => string | undefined,
): T[] {
  return [...items].sort((a, b) =>
    String(getTime(b) ?? "").localeCompare(String(getTime(a) ?? ""))
  );
}

/** Global maintainer briefing report. */
export const report = {
  name: "@evrardjp/maintainer-briefing",
  description:
    "Daily maintainer briefing and PR/issue drill-down data from Swamp",
  scope: "model" as const,
  labels: ["maintainer", "briefing", "github", "pi", "agent"],

  execute: async (context: ReportCtx) => {
    if (normalizedType(context.modelType) !== "@evrardjp/maintainer-activity") {
      return { markdown: "", json: {} };
    }

    const entries = await context.dataRepository?.findAllForModel(
      context.modelType,
      context.modelId!,
    ) ?? [];

    const events = sortDescTime(
      await loadBySpec<LifecycleEvent>(context, entries, "lifecycleEvent"),
      (event) => event.createdAt,
    );
    const classifications = sortDescTime(
      await loadBySpec<Classification>(context, entries, "classification"),
      (classification) => classification.analyzedAt,
    );
    const ciAttention = sortDescTime(
      await loadBySpec<CiAttention>(context, entries, "ciAttention"),
      (ci) => ci.observedAt,
    );
    const sessionLogs = sortDescTime(
      await loadBySpec<SessionLog>(context, entries, "sessionLog"),
      (session) => session.endedAt,
    );

    const visibleEvents = events.filter((event) => !isSmokeTest(event));
    const visibleClassifications = classifications.filter((classification) =>
      !isSmokeTest(classification)
    );
    const visibleCiAttention = ciAttention.filter((ci) => !isSmokeTest(ci));
    const visibleSessionLogs = sessionLogs.filter((session) =>
      !isSmokeTest(session)
    );

    const itemMap = new Map<string, ItemSummary>();
    for (const classification of visibleClassifications) {
      const item = upsertItem(
        itemMap,
        classification.repo,
        classification.itemType,
        classification.number,
      );
      if (!item.latestClassification) {
        item.latestClassification = classification;
        item.title = classification.title;
        item.url = classification.url;
        item.priorityScore = classification.priorityScore;
      }
    }
    for (const event of visibleEvents) {
      upsertItem(itemMap, event.repo, event.itemType, event.number).events.push(
        event,
      );
    }
    for (const ci of visibleCiAttention) {
      upsertItem(itemMap, ci.repo, ci.prNumber ? "pr" : "repo", ci.prNumber).ci
        .push(ci);
    }
    for (const session of visibleSessionLogs) {
      for (const ref of session.relatedItems ?? []) {
        upsertItem(itemMap, ref.repo, ref.itemType, ref.number).sessions.push(
          session,
        );
      }
    }

    const summaries = [...itemMap.values()];
    for (const item of summaries) {
      const c = item.latestClassification;
      if (c?.securityRelevant) item.reasons.push("security-relevant");
      if (
        c?.blockerStatus &&
        !["not_blocked", "unknown"].includes(c.blockerStatus)
      ) item.reasons.push(c.blockerStatus);
      if (c?.inactive) item.reasons.push(`inactive ${c.inactiveDays}d`);
      if (item.ci.some((ci) => ci.requiresMaintainerAttention)) {
        item.reasons.push("ci attention");
      }
      if (item.sessions.length > 0) item.reasons.push("agent-session context");
      if (item.priorityScore === 0) {
        item.priorityScore = c?.priorityScore ??
          item.ci.length * 10 + item.events.length;
      }
    }

    summaries.sort((a, b) =>
      b.priorityScore - a.priorityScore || a.key.localeCompare(b.key)
    );

    const urgent = summaries.filter((item) => item.reasons.length > 0).slice(
      0,
      20,
    );
    const security = summaries.filter((item) =>
      item.latestClassification?.securityRelevant
    ).slice(0, 20);
    const blocked = summaries.filter((item) => {
      const status = item.latestClassification?.blockerStatus;
      return status && !["not_blocked", "unknown"].includes(status);
    }).slice(0, 20);
    const inactive = summaries.filter((item) =>
      item.latestClassification?.inactive
    ).slice(0, 20);
    const needsMyCodeFixes = summaries.filter((item) =>
      item.latestClassification?.needsMyCodeFix
    ).slice(0, 20);
    const readyForMaintainerReview = summaries.filter((item) =>
      item.latestClassification?.readyForMaintainerReview
    ).slice(0, 20);
    const quickWins = summaries.filter((item) =>
      item.latestClassification?.quickWin
    ).slice(0, 20);
    const needsMaintainerDecision = summaries.filter((item) =>
      item.latestClassification?.needsMaintainerDecision
    ).slice(0, 20);
    const recommendAuthorAction = summaries.filter((item) =>
      item.latestClassification?.recommendAuthorAction
    ).slice(0, 20);

    const itemRows = (items: ItemSummary[]) =>
      items.map((item) => [
        esc(item.repo),
        esc(`${item.itemType}${item.number ? ` #${item.number}` : ""}`),
        esc(item.title ?? item.latestClassification?.title ?? ""),
        String(item.priorityScore),
        esc(item.reasons.join(", ")),
        esc(item.latestClassification?.recommendedAction ?? ""),
      ]);
    const reviewRows = (items: ItemSummary[]) =>
      items.map((item) => {
        const c = item.latestClassification;
        return [
          esc(item.repo),
          esc(`${item.itemType}${item.number ? ` #${item.number}` : ""}`),
          esc(item.title ?? c?.title ?? ""),
          esc(c?.state ?? ""),
          esc(c?.author ?? ""),
          esc(c?.checksState ?? ""),
          esc(c?.lastCodeChangeAt ?? ""),
          esc(c?.reviewedByMeSinceLastCodeChange ?? ""),
          esc(c?.changedFiles ?? ""),
          esc(((c?.additions ?? 0) + (c?.deletions ?? 0)) || ""),
          esc(c?.recommendedAction ?? ""),
        ];
      });

    const modelName = context.definition?.name ?? context.modelId ??
      "maintainer-activity";
    const lines = [
      `# Maintainer Briefing — ${modelName}`,
      "",
      `Items: **${summaries.length}** · Events: **${visibleEvents.length}** · Classifications: **${visibleClassifications.length}** · CI attention: **${visibleCiAttention.length}** · Session logs: **${visibleSessionLogs.length}**`,
      "",
      "## Needs my code fixes",
      ...renderTable([
        "Repo",
        "Item",
        "Title",
        "State",
        "Author",
        "CI",
        "Last code change",
        "Reviewed by me since code change",
        "Files",
        "Lines",
        "Recommended action",
      ], reviewRows(needsMyCodeFixes)),
      "",
      "## Ready for maintainer review",
      ...renderTable([
        "Repo",
        "Item",
        "Title",
        "State",
        "Author",
        "CI",
        "Last code change",
        "Reviewed by me since code change",
        "Files",
        "Lines",
        "Recommended action",
      ], reviewRows(readyForMaintainerReview)),
      "",
      "## Quick review wins",
      ...renderTable([
        "Repo",
        "Item",
        "Title",
        "State",
        "Author",
        "CI",
        "Last code change",
        "Reviewed by me since code change",
        "Files",
        "Lines",
        "Recommended action",
      ], reviewRows(quickWins)),
      "",
      "## Needs maintainer decision",
      ...renderTable([
        "Repo",
        "Item",
        "Title",
        "State",
        "Author",
        "CI",
        "Last code change",
        "Reviewed by me since code change",
        "Files",
        "Lines",
        "Recommended action",
      ], reviewRows(needsMaintainerDecision)),
      "",
      "## Recommend changes/bumps to other authors",
      ...renderTable([
        "Repo",
        "Item",
        "Title",
        "State",
        "Author",
        "CI",
        "Last code change",
        "Reviewed by me since code change",
        "Files",
        "Lines",
        "Recommended action",
      ], reviewRows(recommendAuthorAction)),
      "",
      "## Urgent / Noteworthy",
      ...renderTable([
        "Repo",
        "Item",
        "Title",
        "Score",
        "Reasons",
        "Recommended action",
      ], itemRows(urgent)),
      "",
      "## Security-Relevant",
      ...renderTable([
        "Repo",
        "Item",
        "Title",
        "Score",
        "Reasons",
        "Recommended action",
      ], itemRows(security)),
      "",
      "## Blocked / Needs Input",
      ...renderTable([
        "Repo",
        "Item",
        "Title",
        "Score",
        "Reasons",
        "Recommended action",
      ], itemRows(blocked)),
      "",
      "## CI Attention",
      ...renderTable(
        ["Observed", "Repo", "PR", "Workflow", "Conclusion", "Reason"],
        visibleCiAttention.slice(0, 20).map((ci) => [
          esc(ci.observedAt),
          esc(ci.repo),
          esc(ci.prNumber ?? ""),
          esc(ci.workflow),
          esc(ci.conclusion ?? ci.status ?? ""),
          esc(ci.reason),
        ]),
      ),
      "",
      "## Inactive",
      ...renderTable([
        "Repo",
        "Item",
        "Title",
        "Score",
        "Reasons",
        "Recommended action",
      ], itemRows(inactive)),
      "",
      "## Recent Lifecycle / Agent Events",
      ...renderTable(
        ["Time", "Source", "Repo", "Item", "Actor", "Summary"],
        visibleEvents.slice(0, 30).map((event) => [
          esc(event.createdAt),
          esc(event.source),
          esc(event.repo),
          esc(`${event.itemType}${event.number ? ` #${event.number}` : ""}`),
          esc(event.actor),
          esc(event.summary),
        ]),
      ),
      "",
      "## Recent Session Logs",
      ...renderTable(
        ["Ended", "Session", "Related", "Summary"],
        visibleSessionLogs.slice(0, 20).map((session) => [
          esc(session.endedAt),
          esc(session.sessionId),
          esc(
            (session.relatedItems ?? []).map((i) =>
              `${i.repo} ${i.itemType}${i.number ? ` #${i.number}` : ""}`
            ).join(", "),
          ),
          esc(session.summary),
        ]),
      ),
    ];

    return {
      markdown: `${lines.join("\n")}\n`,
      json: {
        generatedAt: new Date().toISOString(),
        counts: {
          items: summaries.length,
          events: visibleEvents.length,
          classifications: visibleClassifications.length,
          ciAttention: visibleCiAttention.length,
          sessionLogs: visibleSessionLogs.length,
        },
        urgent,
        security,
        blocked,
        inactive,
        needsMyCodeFixes,
        readyForMaintainerReview,
        quickWins,
        needsMaintainerDecision,
        recommendAuthorAction,
        ciAttention: visibleCiAttention,
        recentEvents: visibleEvents.slice(0, 30),
        recentSessionLogs: visibleSessionLogs.slice(0, 20),
        items: summaries,
      },
    };
  },
};
