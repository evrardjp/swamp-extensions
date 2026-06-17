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

const GlobalArgsSchema = z.object({});

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
  detectedAt: string;
  checkName?: string;
  checkConclusion?: string;
};

type GithubPrSnapshot = {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  headSha?: string;
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
  version: "2026.06.17.1",
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

        const eventEntries = entries
          .filter((entry) => tagsOf(entry).specName === "feedbackEvent")
          .sort((a, b) => b.name.localeCompare(a.name))
          .slice(0, parsed.limit);

        for (const entry of eventEntries) {
          const event = await readJson<GithubPrFeedEvent>(
            context.dataRepository,
            feedType,
            parsed.feedModelId,
            entry,
          );
          if (!event) continue;
          if (!parsed.includeBots && event.authorType === "bot") continue;

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
                createdAt: event.detectedAt,
                url: event.prUrl,
                tags: ["github-pr-feed"],
              },
            ),
          );

          if (event.type === "check_failure") {
            handles.push(
              await context.writeResource(
                "ciAttention",
                safeName("github-ci", [parsed.repo, event.eventId]),
                {
                  repo: parsed.repo,
                  prNumber: event.prNumber,
                  workflow: event.checkName ?? "github-check",
                  conclusion: event.checkConclusion ?? "failure",
                  url: event.prUrl,
                  reason:
                    `GitHub check failure detected on PR #${event.prNumber}`,
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
          const ciBlocked = snapshot.checksState === "failure";
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
                blockerStatus: ciBlocked ? "ci_blocked" : "unknown",
                blockerReason: ciBlocked
                  ? "GitHub PR feed reported failing checks"
                  : undefined,
                blockerConfidence: ciBlocked ? 0.8 : 0.3,
                securityRelevant: false,
                securitySignals: [],
                inactive: false,
                inactiveDays: 0,
                difficulty: "unknown",
                reviewEffort: "unknown",
                priorityScore: ciBlocked ? 60 : 0,
                recommendedAction: ciBlocked
                  ? "Inspect failing checks and decide whether maintainer action is needed"
                  : undefined,
                tags: ["github-pr-feed"],
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
