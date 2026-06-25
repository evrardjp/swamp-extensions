/**
 * Maintainer activity ledger.
 *
 * Stores operational maintainer context that should survive agent sessions:
 * GitHub-derived lifecycle events, agent-session conclusions, full session
 * logs on demand, item classifications, and CI attention records. GitHub mirror
 * models can feed this ledger; Pi/global skills can also record session events.
 *
 * @module
 */
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  personalGithubHandles: z.array(z.string()).default([
    "evrardjp",
    "evrardj-roche",
  ]).describe("GitHub handles that represent the maintainer/user"),
});

const ItemRefSchema = z.object({
  repo: z.string().min(1).describe("Repository as owner/name"),
  itemType: z.enum(["issue", "pr", "repo", "project"]),
  number: z.number().int().positive().optional(),
  url: z.string().url().optional(),
  title: z.string().optional(),
});

const LifecycleEventSchema = z.object({
  id: z.string().min(1).default(() => crypto.randomUUID()),
  repo: z.string().min(1),
  itemType: z.enum(["issue", "pr", "repo", "project"]),
  number: z.number().int().positive().optional(),
  source: z.enum([
    "github",
    "swamp",
    "pi-agent-session",
    "review-tool",
    "manual",
  ]),
  actor: z.string().min(1).default("unknown"),
  eventType: z.string().min(1),
  summary: z.string().min(1),
  body: z.string().optional(),
  createdAt: z.iso.datetime().default(() => new Date().toISOString()),
  url: z.string().url().optional(),
  relatedSessionId: z.string().optional(),
  relatedRunId: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

const ClassificationSchema = z.object({
  id: z.string().min(1).default(() => crypto.randomUUID()),
  repo: z.string().min(1),
  itemType: z.enum(["issue", "pr"]),
  number: z.number().int().positive(),
  title: z.string().optional(),
  url: z.string().url().optional(),
  observedRevision: z.string().optional(),
  analyzedAt: z.iso.datetime().default(() => new Date().toISOString()),
  blockerStatus: z.enum([
    "maintainer_input_needed",
    "author_blocked",
    "reviewer_blocked",
    "ci_blocked",
    "unknown",
    "not_blocked",
  ]).default("unknown"),
  blockerActor: z.string().optional(),
  blockerReason: z.string().optional(),
  blockerConfidence: z.number().min(0).max(1).default(0.5),
  securityRelevant: z.boolean().default(false),
  securitySignals: z.array(z.string()).default([]),
  inactive: z.boolean().default(false),
  inactiveDays: z.number().nonnegative().default(0),
  difficulty: z.enum(["S", "M", "L", "unknown"]).default("unknown"),
  difficultyReason: z.string().optional(),
  reviewEffort: z.enum(["quick", "medium", "deep", "unknown"]).default(
    "unknown",
  ),
  reviewMinutes: z.number().nonnegative().optional(),
  reviewEffortReason: z.string().optional(),
  priorityScore: z.number().default(0),
  recommendedAction: z.string().optional(),
  author: z.string().optional(),
  isOwnPr: z.boolean().default(false),
  state: z.string().default("OPEN"),
  merged: z.boolean().default(false),
  mergeable: z.string().optional(),
  isDraft: z.boolean().default(false),
  labels: z.array(z.string()).default([]),
  checksState: z.string().optional(),
  reviewState: z.string().optional(),
  lastCodeChangeAt: z.string().optional(),
  lastConversationAt: z.string().optional(),
  discussionCount: z.number().nonnegative().default(0),
  additions: z.number().nonnegative().optional(),
  deletions: z.number().nonnegative().optional(),
  changedFiles: z.number().nonnegative().optional(),
  reviewedByMeSinceLastCodeChange: z.boolean().default(false),
  needsMyCodeFix: z.boolean().default(false),
  readyForMaintainerReview: z.boolean().default(false),
  quickWin: z.boolean().default(false),
  needsMaintainerDecision: z.boolean().default(false),
  recommendAuthorAction: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
});

const CiAttentionSchema = z.object({
  id: z.string().min(1).default(() => crypto.randomUUID()),
  repo: z.string().min(1),
  prNumber: z.number().int().positive().optional(),
  workflow: z.string().min(1),
  status: z.string().optional(),
  conclusion: z.string().optional(),
  url: z.string().url().optional(),
  logUrl: z.string().url().optional(),
  errorExcerpt: z.string().optional(),
  reason: z.string().min(1),
  requiresMaintainerAttention: z.boolean().default(true),
  observedAt: z.iso.datetime().default(() => new Date().toISOString()),
  tags: z.array(z.string()).default([]),
});

const SessionLogSchema = z.object({
  id: z.string().min(1).default(() => crypto.randomUUID()),
  sessionId: z.string().min(1),
  startedAt: z.iso.datetime().optional(),
  endedAt: z.iso.datetime().default(() => new Date().toISOString()),
  cwd: z.string().optional(),
  summary: z.string().min(1),
  fullLog: z.string().optional(),
  relatedItems: z.array(ItemRefSchema).default([]),
  tags: z.array(z.string()).default([]),
});

const GithubPrFeedIngestArgsSchema = z.object({
  feedModelId: z.string().min(1).describe(
    "Model id of the @mgreten/github-pr-feed instance",
  ),
  repo: z.string().min(1).describe("Repository as owner/name"),
  limit: z.number().int().positive().default(200),
  includeBots: z.boolean().default(true),
  personalGithubHandles: z.array(z.string()).default([
    "evrardjp",
    "evrardj-roche",
  ]).describe("GitHub handles that represent this maintainer/user"),
});

const PiSessionFindingSchema = z.object({
  sessionId: z.string().min(1).describe(
    "Pi session id, usually from @evrardjp/pi-session-telemetry",
  ),
  repo: z.string().min(1).describe("Repository as owner/name"),
  itemType: z.enum(["issue", "pr", "repo", "project"]),
  number: z.number().int().positive().optional(),
  title: z.string().optional(),
  url: z.string().url().optional(),
  actor: z.string().min(1).default("pi"),
  eventType: z.string().min(1).default("maintainer-finding"),
  summary: z.string().min(1),
  body: z.string().optional(),
  createdAt: z.iso.datetime().default(() => new Date().toISOString()),
  tags: z.array(z.string()).default([]),
  recordSessionLog: z.boolean().default(false),
  sessionSummary: z.string().optional(),
});

type GithubPrFeedEvent = {
  eventId: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  type: string;
  author: string;
  authorType?: string;
  body?: string;
  state?: string;
  occurredAt?: string;
  detectedAt: string;
  checkName?: string;
  checkConclusion?: string;
  checkUrl?: string;
  checkDetailsUrl?: string;
  checkExcerpt?: string;
};

type GithubPrSnapshot = {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  headSha?: string;
  state?: string;
  merged?: boolean;
  author?: string;
  isDraft?: boolean;
  labels?: string[];
  reviewDecision?: string;
  mergeable?: string;
  createdAt?: string;
  updatedAt?: string;
  lastCodeChangeAt?: string;
  lastConversationAt?: string;
  discussionCount?: number;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  reviewState?: string;
  checksState?: string;
  lastPollAt: string;
};

type DataEntry = {
  name: string;
  version: number;
  tags?: Record<string, string>;
  metadata?: { tags?: Record<string, string> };
};

function tagsOf(entry: DataEntry): Record<string, string> {
  return entry.tags ?? entry.metadata?.tags ?? {};
}

async function readJson<T>(
  dataRepository: {
    getContent: (
      modelType: unknown,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  },
  modelType: string,
  modelId: string,
  entry: DataEntry,
): Promise<T | null> {
  const bytes = await dataRepository.getContent(
    modelType,
    modelId,
    entry.name,
    entry.version,
  );
  if (!bytes) return null;
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function safeName(
  prefix: string,
  parts: Array<string | number | undefined>,
): string {
  return `${prefix}-${
    parts.filter((p) => p !== undefined && p !== "").join("-")
  }`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
}

function checkRunId(eventId: string): string | undefined {
  return eventId.match(/-check-(\d+)$/)?.[1];
}

function checkRunUrl(repo: string, eventId: string): string | undefined {
  const id = checkRunId(eventId);
  return id ? `https://github.com/${repo}/runs/${id}` : undefined;
}

async function runGh(
  args: string[],
): Promise<{ stdout: string; success: boolean }> {
  const output = await new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    stdout: new TextDecoder().decode(output.stdout),
    success: output.success,
  };
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

function errorWarningExcerpt(...chunks: Array<unknown>): string {
  const lines = chunks
    .flatMap((chunk) => String(chunk ?? "").split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) =>
      /\b(error|warning|fail(?:ed|ure)?|panic|exception|critical)\b/i.test(line)
    );
  return truncate([...new Set(lines)].slice(0, 5).join(" | "), 1000);
}

async function lookupCheckRun(
  repo: string,
  eventId: string,
): Promise<{ url?: string; logUrl?: string; excerpt?: string }> {
  const id = checkRunId(eventId);
  if (!id) return {};
  const check = await runGh([
    "api",
    `repos/${repo}/check-runs/${id}`,
    "--jq",
    `{html_url, details_url, output}`,
  ]);
  if (!check.success) return { url: checkRunUrl(repo, eventId) };
  const parsed = JSON.parse(check.stdout) as {
    html_url?: string;
    details_url?: string;
    output?: { title?: string; summary?: string; text?: string };
  };
  const annotations = await runGh([
    "api",
    `repos/${repo}/check-runs/${id}/annotations`,
    "--jq",
    `[.[] | select((.annotation_level == "failure") or (.annotation_level == "warning")) | [.path, .start_line, .annotation_level, .message, .raw_details] | map(select(. == null | not)) | join(":")] | .[:5] | join("\\n")`,
  ]);
  return {
    url: parsed.html_url ?? checkRunUrl(repo, eventId),
    logUrl: parsed.details_url,
    excerpt: errorWarningExcerpt(
      parsed.output?.title,
      parsed.output?.summary,
      parsed.output?.text,
      annotations.success ? annotations.stdout : "",
    ),
  };
}

function daysBetween(later: Date, earlierIso?: string): number {
  if (!earlierIso) return Number.POSITIVE_INFINITY;
  const earlier = new Date(earlierIso);
  if (Number.isNaN(earlier.getTime())) return Number.POSITIVE_INFINITY;
  return (later.getTime() - earlier.getTime()) / (24 * 60 * 60 * 1000);
}

function inactiveDaysSince(later: Date, earlierIso?: string): number {
  const days = daysBetween(later, earlierIso);
  if (!Number.isFinite(days)) return 9999;
  return Math.max(0, Math.floor(days));
}

function maxIso(values: Array<string | undefined>): string | undefined {
  const valid = values.filter((v): v is string => Boolean(v));
  if (valid.length === 0) return undefined;
  return valid.sort().at(-1);
}

function isDesignProposal(snapshot: GithubPrSnapshot): boolean {
  const title = snapshot.prTitle.toLowerCase();
  const labels = (snapshot.labels ?? []).map((label) => label.toLowerCase());
  return title.startsWith("design") ||
    title.includes("proposal") ||
    labels.some((label) =>
      label.includes("design") || label.includes("proposal") ||
      label.includes("architecture")
    );
}

function isQuickWin(snapshot: GithubPrSnapshot, isOwnPr: boolean): boolean {
  if (isOwnPr || snapshot.isDraft || snapshot.checksState !== "success") {
    return false;
  }
  const title = snapshot.prTitle.toLowerCase();
  const labels = (snapshot.labels ?? []).map((label) => label.toLowerCase());
  const totalChanges = (snapshot.additions ?? 0) + (snapshot.deletions ?? 0);
  const smallDiff = (snapshot.changedFiles ?? 999) <= 5 && totalChanges <= 250;
  const smallKind = /^(docs|doc|fix|chore|test)(\(|:)/.test(title) ||
    labels.some((label) =>
      label.includes("docs") || label.includes("chore") ||
      label.includes("kind/documentation")
    );
  return smallDiff || smallKind;
}

type ModelContext = {
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  dataRepository?: {
    findAllForModel: (
      modelType: unknown,
      modelId: string,
    ) => Promise<DataEntry[]>;
    getContent: (
      modelType: unknown,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
};

/** Model that stores durable maintainer activity and agent-session context. */
export const model = {
  type: "@evrardjp/maintainer-activity",
  version: "2026.06.25.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    lifecycleEvent: {
      description: "GitHub, Swamp, manual, or Pi agent-session lifecycle event",
      schema: LifecycleEventSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10000,
    },
    classification: {
      description:
        "Per issue/PR classification for briefing and drill-down reports",
      schema: ClassificationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10000,
    },
    ciAttention: {
      description:
        "CI failure or workflow status requiring maintainer attention",
      schema: CiAttentionSchema,
      lifetime: "90d" as const,
      garbageCollection: 5000,
    },
    sessionLog: {
      description:
        "On-demand full or summarized agent session log for resume context",
      schema: SessionLogSchema,
      lifetime: "180d" as const,
      garbageCollection: 1000,
    },
  },
  reports: ["@evrardjp/maintainer-briefing"],
  methods: {
    ingest_github_pr_feed: {
      description:
        "Ingest cached @mgreten/github-pr-feed events and snapshots into maintainer activity",
      arguments: GithubPrFeedIngestArgsSchema,
      execute: async (
        args: z.infer<typeof GithubPrFeedIngestArgsSchema>,
        context: ModelContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        if (!context.dataRepository) {
          throw new Error(
            "dataRepository is required to ingest cross-model data",
          );
        }
        const parsed = GithubPrFeedIngestArgsSchema.parse(args);
        const feedType = "@mgreten/github-pr-feed";
        const entries = await context.dataRepository.findAllForModel(
          feedType,
          parsed.feedModelId,
        );
        const handles: Array<{ name: string }> = [];

        const personalHandles = new Set(
          parsed.personalGithubHandles.map((handle) => handle.toLowerCase()),
        );
        const now = new Date();
        const eventEntries = entries
          .filter((entry) => tagsOf(entry).specName === "feedbackEvent")
          .sort((a, b) => b.name.localeCompare(a.name))
          .slice(0, parsed.limit);
        const eventsByPr = new Map<number, GithubPrFeedEvent[]>();

        for (const entry of eventEntries) {
          const event = await readJson<GithubPrFeedEvent>(
            context.dataRepository,
            feedType,
            parsed.feedModelId,
            entry,
          );
          if (!event) continue;
          if (!parsed.includeBots && event.authorType === "bot") continue;
          const prEvents = eventsByPr.get(event.prNumber) ?? [];
          prEvents.push(event);
          eventsByPr.set(event.prNumber, prEvents);

          handles.push(
            await context.writeResource(
              "lifecycleEvent",
              safeName("github-event", [parsed.repo, event.eventId]),
              {
                repo: parsed.repo,
                itemType: "pr",
                number: event.prNumber,
                source: "github",
                actor: event.author,
                eventType: event.type,
                summary:
                  `${event.type} by ${event.author} on PR #${event.prNumber}: ${event.prTitle}`,
                body: event.body,
                createdAt: event.occurredAt ?? event.detectedAt,
                url: event.prUrl,
                tags: ["github-pr-feed"],
              },
            ),
          );

          if (event.type === "check_failure") {
            const checkRun = event.checkUrl && event.checkExcerpt
              ? {}
              : await lookupCheckRun(parsed.repo, event.eventId);
            const errorExcerpt = event.checkExcerpt || checkRun.excerpt;
            handles.push(
              await context.writeResource(
                "ciAttention",
                safeName("github-ci", [parsed.repo, event.eventId]),
                {
                  repo: parsed.repo,
                  prNumber: event.prNumber,
                  workflow: event.checkName ?? "github-check",
                  conclusion: event.checkConclusion ?? "failure",
                  url: event.checkUrl ?? checkRun.url ?? event.prUrl,
                  logUrl: event.checkDetailsUrl ?? checkRun.logUrl,
                  errorExcerpt,
                  reason: errorExcerpt || event.body ||
                    `${event.checkName ?? "GitHub check"} failed`,
                  requiresMaintainerAttention: true,
                  observedAt: event.detectedAt,
                  tags: ["github-pr-feed"],
                },
              ),
            );
          }
        }

        const latestSnapshots = new Map<string, DataEntry>();
        for (
          const entry of entries.filter((e) =>
            tagsOf(e).specName === "prSnapshot"
          )
        ) {
          const current = latestSnapshots.get(entry.name);
          if (!current || entry.version > current.version) {
            latestSnapshots.set(entry.name, entry);
          }
        }
        for (
          const entry of [...latestSnapshots.values()].slice(0, parsed.limit)
        ) {
          const snapshot = await readJson<GithubPrSnapshot>(
            context.dataRepository,
            feedType,
            parsed.feedModelId,
            entry,
          );
          if (!snapshot) continue;
          const prEvents = eventsByPr.get(snapshot.prNumber) ?? [];
          const isOwnPr = personalHandles.has(
            (snapshot.author ?? "").toLowerCase(),
          );
          const prState = snapshot.merged
            ? "MERGED"
            : (snapshot.state ?? "OPEN");
          const isOpen = prState === "OPEN";
          const ciBlocked = isOpen && snapshot.checksState === "failure";
          const changesRequested = isOpen &&
            snapshot.reviewState === "changes_requested";
          const lastCodeChangeAt = snapshot.lastCodeChangeAt ??
            snapshot.updatedAt;
          const lastConversationAt = maxIso([
            snapshot.lastConversationAt,
            ...prEvents.map((event) => event.occurredAt ?? event.detectedAt),
          ]);
          const humanConversationAt = maxIso(
            prEvents
              .filter((event) =>
                ["review", "review_comment", "issue_comment"].includes(
                  event.type,
                ) && event.authorType !== "bot"
              )
              .map((event) => event.occurredAt ?? event.detectedAt),
          );
          const latestRelevantActivityAt = maxIso([
            lastCodeChangeAt,
            humanConversationAt,
          ]);
          const referenceTime = new Date(snapshot.lastPollAt);
          const inactiveDays = isOpen
            ? inactiveDaysSince(referenceTime, latestRelevantActivityAt)
            : 0;
          const personalReviewAt = maxIso(
            prEvents
              .filter((event) =>
                event.type === "review" &&
                personalHandles.has(event.author.toLowerCase())
              )
              .map((event) => event.occurredAt ?? event.detectedAt),
          );
          const reviewedByMeSinceLastCodeChange = Boolean(
            personalReviewAt && lastCodeChangeAt &&
              personalReviewAt >= lastCodeChangeAt,
          );
          const humanNonPersonalCommentAfterCode = prEvents.some((event) =>
            ["review", "review_comment", "issue_comment"].includes(
              event.type,
            ) &&
            event.authorType !== "bot" &&
            !personalHandles.has(event.author.toLowerCase()) &&
            (!lastCodeChangeAt ||
              (event.occurredAt ?? event.detectedAt) >= lastCodeChangeAt)
          );
          const staleHighActivityDecision =
            (snapshot.discussionCount ?? 0) > 10 &&
            daysBetween(now, maxIso([lastConversationAt, lastCodeChangeAt])) >=
              7;
          const designProposal = isDesignProposal(snapshot);
          const needsMaintainerDecision = isOpen &&
            (staleHighActivityDecision || designProposal);
          const needsMyCodeFix = isOpen && isOwnPr &&
            (ciBlocked || changesRequested || humanNonPersonalCommentAfterCode);
          const readyForMaintainerReview = isOpen && !isOwnPr &&
            !snapshot.isDraft &&
            snapshot.checksState === "success" &&
            !changesRequested &&
            !reviewedByMeSinceLastCodeChange;
          const quickWin = isOpen && isQuickWin(snapshot, isOwnPr);
          const recommendAuthorAction = isOpen && !isOwnPr &&
            ciBlocked &&
            !changesRequested &&
            daysBetween(now, lastCodeChangeAt) >= 1;
          const categories = [
            needsMyCodeFix ? "needs-my-code-fix" : undefined,
            readyForMaintainerReview
              ? "ready-for-maintainer-review"
              : undefined,
            quickWin ? "quick-win" : undefined,
            needsMaintainerDecision ? "needs-maintainer-decision" : undefined,
            recommendAuthorAction ? "recommend-author-action" : undefined,
          ].filter((tag): tag is string => Boolean(tag));
          const priorityScore = Math.max(
            needsMyCodeFix ? 100 : 0,
            readyForMaintainerReview ? 80 : 0,
            quickWin ? 70 : 0,
            needsMaintainerDecision ? 65 : 0,
            ciBlocked ? 60 : 0,
            recommendAuthorAction ? 45 : 0,
          );
          const recommendedAction = needsMyCodeFix
            ? "Fix your PR: address CI, requested changes, or reviewer comments since the last code change"
            : readyForMaintainerReview
            ? personalReviewAt
              ? "Review this PR; code has changed since your last review"
              : "Review this PR; you have never reviewed it"
            : needsMaintainerDecision
            ? "Make or request a maintainer decision"
            : recommendAuthorAction
            ? "Recommend changes or bump the author; CI is failing and no code change landed in the last 24h"
            : ciBlocked
            ? "Inspect failing checks and decide whether maintainer action is needed"
            : undefined;
          const blockerStatus = needsMyCodeFix || readyForMaintainerReview ||
              needsMaintainerDecision
            ? "maintainer_input_needed"
            : ciBlocked
            ? "ci_blocked"
            : isOpen
            ? "unknown"
            : "not_blocked";

          handles.push(
            await context.writeResource(
              "classification",
              safeName("github-snapshot", [
                parsed.repo,
                snapshot.prNumber,
                snapshot.headSha,
              ]),
              {
                repo: parsed.repo,
                itemType: "pr",
                number: snapshot.prNumber,
                title: snapshot.prTitle,
                url: snapshot.prUrl,
                observedRevision: snapshot.headSha,
                analyzedAt: snapshot.lastPollAt,
                blockerStatus,
                blockerReason: ciBlocked
                  ? "GitHub PR feed reported failing checks"
                  : needsMaintainerDecision
                  ? "Design proposal or high-activity stale conversation needs a decision"
                  : readyForMaintainerReview
                  ? "Maintainer has not reviewed since the latest code change"
                  : undefined,
                blockerConfidence: blockerStatus === "unknown" ? 0.3 : 0.8,
                securityRelevant: false,
                securitySignals: [],
                inactive: isOpen,
                inactiveDays,
                difficulty: "unknown",
                reviewEffort: quickWin ? "quick" : "unknown",
                priorityScore,
                recommendedAction,
                state: prState,
                merged: Boolean(snapshot.merged),
                mergeable: snapshot.mergeable,
                author: snapshot.author,
                isOwnPr,
                isDraft: Boolean(snapshot.isDraft),
                labels: snapshot.labels ?? [],
                checksState: snapshot.checksState,
                reviewState: snapshot.reviewState,
                lastCodeChangeAt,
                lastConversationAt,
                discussionCount: snapshot.discussionCount ?? 0,
                additions: snapshot.additions,
                deletions: snapshot.deletions,
                changedFiles: snapshot.changedFiles,
                reviewedByMeSinceLastCodeChange,
                needsMyCodeFix,
                readyForMaintainerReview,
                quickWin,
                needsMaintainerDecision,
                recommendAuthorAction,
                tags: ["github-pr-feed", ...categories],
              },
            ),
          );
        }

        return { dataHandles: handles };
      },
    },
    record_pi_session_finding: {
      description:
        "Bridge a distilled Pi session finding into maintainer activity",
      arguments: z.object({ finding: PiSessionFindingSchema }),
      execute: async (
        args: { finding: z.infer<typeof PiSessionFindingSchema> },
        context: ModelContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const finding = PiSessionFindingSchema.parse(args.finding);
        const tags = [...new Set(["pi-session-telemetry", ...finding.tags])];
        const lifecycleEvent = LifecycleEventSchema.parse({
          repo: finding.repo,
          itemType: finding.itemType,
          number: finding.number,
          source: "pi-agent-session",
          actor: finding.actor,
          eventType: finding.eventType,
          summary: finding.summary,
          body: finding.body,
          createdAt: finding.createdAt,
          url: finding.url,
          relatedSessionId: finding.sessionId,
          tags,
        });
        const handles = [
          await context.writeResource(
            "lifecycleEvent",
            safeName("pi-session-event", [
              finding.repo,
              finding.itemType,
              finding.number,
              finding.sessionId,
              finding.createdAt,
            ]),
            lifecycleEvent,
          ),
        ];

        if (finding.recordSessionLog) {
          const sessionLog = SessionLogSchema.parse({
            sessionId: finding.sessionId,
            endedAt: finding.createdAt,
            summary: finding.sessionSummary ?? finding.summary,
            relatedItems: [{
              repo: finding.repo,
              itemType: finding.itemType,
              number: finding.number,
              title: finding.title,
              url: finding.url,
            }],
            tags,
          });
          handles.push(
            await context.writeResource(
              "sessionLog",
              safeName("pi-session", [finding.sessionId, finding.createdAt]),
              sessionLog,
            ),
          );
        }

        return { dataHandles: handles };
      },
    },
    record_event: {
      description:
        "Record one lifecycle event for a repo, PR, issue, project, or agent session",
      arguments: z.object({ event: LifecycleEventSchema }),
      execute: async (
        args: { event: z.infer<typeof LifecycleEventSchema> },
        context: ModelContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const event = LifecycleEventSchema.parse(args.event);
        const name = safeName("event", [
          event.repo,
          event.itemType,
          event.number,
          event.createdAt,
          event.id,
        ]);
        return {
          dataHandles: [
            await context.writeResource("lifecycleEvent", name, event),
          ],
        };
      },
    },
    record_classification: {
      description: "Record or refresh one issue/PR classification",
      arguments: z.object({ classification: ClassificationSchema }),
      execute: async (
        args: { classification: z.infer<typeof ClassificationSchema> },
        context: ModelContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const classification = ClassificationSchema.parse(args.classification);
        const name = safeName("classification", [
          classification.repo,
          classification.itemType,
          classification.number,
          classification.analyzedAt,
        ]);
        return {
          dataHandles: [
            await context.writeResource("classification", name, classification),
          ],
        };
      },
    },
    record_ci_attention: {
      description:
        "Record a CI failure or workflow result requiring maintainer attention",
      arguments: z.object({ ci: CiAttentionSchema }),
      execute: async (
        args: { ci: z.infer<typeof CiAttentionSchema> },
        context: ModelContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const ci = CiAttentionSchema.parse(args.ci);
        const name = safeName("ci", [
          ci.repo,
          ci.prNumber,
          ci.workflow,
          ci.observedAt,
          ci.id,
        ]);
        return {
          dataHandles: [await context.writeResource("ciAttention", name, ci)],
        };
      },
    },
    record_session_log: {
      description: "Record an on-demand full or summarized agent session log",
      arguments: z.object({ sessionLog: SessionLogSchema }),
      execute: async (
        args: { sessionLog: z.infer<typeof SessionLogSchema> },
        context: ModelContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const sessionLog = SessionLogSchema.parse(args.sessionLog);
        const name = safeName("session", [
          sessionLog.sessionId,
          sessionLog.endedAt,
          sessionLog.id,
        ]);
        return {
          dataHandles: [
            await context.writeResource("sessionLog", name, sessionLog),
          ],
        };
      },
    },
  },
};
