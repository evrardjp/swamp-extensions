/**
 * Pi coding-agent session telemetry sink.
 *
 * The companion pi extension batches session, prompt, message, tool, usage,
 * and snapshot events into this model. Each payload is persisted as versioned
 * swamp data so reports can summarize agent activity without reading pi's
 * private JSONL session files directly.
 *
 * @module
 */
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  includeContent: z.boolean().default(false).describe(
    "Store prompt/message text, raw payloads, images, and session snapshots",
  ),
  includeToolPayloads: z.boolean().default(false).describe(
    "Store tool arguments, results, partial results, and details",
  ),
  includePaths: z.boolean().default(false).describe(
    "Store local cwd and pi sessionFile paths",
  ),
});

const EventSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().default("unknown"),
  type: z.string().min(1),
  timestamp: z.iso.datetime(),
  cwd: z.string().optional(),
  piMode: z.string().optional(),
  sessionFile: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});

const PromptSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().default("unknown"),
  timestamp: z.iso.datetime(),
  cwd: z.string().optional(),
  source: z.string().optional(),
  streamingBehavior: z.string().optional(),
  prompt: z.string().optional(),
  promptHash: z.string().optional(),
  systemPrompt: z.string().optional(),
  systemPromptHash: z.string().optional(),
  systemPromptOptions: z.record(z.string(), z.unknown()).optional(),
  contextUsage: z.record(z.string(), z.unknown()).optional(),
  imageCount: z.number().int().nonnegative().optional(),
  images: z.array(z.record(z.string(), z.unknown())).optional(),
});

const MessageSchema = z.object({
  id: z.string().min(1),
  entryId: z.string().optional(),
  parentId: z.string().nullable().optional(),
  sessionId: z.string().default("unknown"),
  timestamp: z.iso.datetime(),
  cwd: z.string().optional(),
  role: z.string().min(1),
  provider: z.string().optional(),
  model: z.string().optional(),
  stopReason: z.string().optional(),
  errorMessage: z.string().optional(),
  isError: z.boolean().optional(),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  content: z.unknown().optional(),
  contentText: z.string().optional(),
  contentHash: z.string().optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

const ToolExecutionSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().default("unknown"),
  timestamp: z.iso.datetime(),
  cwd: z.string().optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().min(1),
  phase: z.string().min(1),
  args: z.unknown().optional(),
  argsHash: z.string().optional(),
  result: z.unknown().optional(),
  partialResult: z.unknown().optional(),
  resultText: z.string().optional(),
  resultHash: z.string().optional(),
  details: z.unknown().optional(),
  message: z.string().optional(),
  isError: z.boolean().optional(),
});

const UsageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().default("unknown"),
  timestamp: z.iso.datetime(),
  cwd: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  input: z.number().optional(),
  output: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
  totalUsageCount: z.number().optional(),
  costTotal: z.number().optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
});

const SessionSnapshotSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().default("unknown"),
  timestamp: z.iso.datetime(),
  cwd: z.string().optional(),
  sessionFile: z.string().optional(),
  reason: z.string().optional(),
  entryCount: z.number().int().nonnegative(),
  branchEntryCount: z.number().int().nonnegative(),
  leafId: z.string().optional(),
  sessionName: z.string().optional(),
  entries: z.array(z.record(z.string(), z.unknown())).optional(),
  branch: z.array(z.record(z.string(), z.unknown())).optional(),
});

const BatchSummarySchema = z.object({
  id: z.string().min(1),
  ingestedAt: z.iso.datetime(),
  eventCount: z.number().int().nonnegative(),
  sessionIds: z.array(z.string()),
  eventTypes: z.record(z.string(), z.number().int().nonnegative()),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type PiEvent = z.infer<typeof EventSchema>;
type BatchSummary = z.infer<typeof BatchSummarySchema>;

type ModelContext = {
  definition: { name: string };
  globalArgs?: Record<string, unknown>;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

function safeName(prefix: string, value: string): string {
  return `${prefix}-${value}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
}

const CONTENT_KEYS = new Set([
  "content",
  "contentText",
  "prompt",
  "systemPrompt",
  "systemPromptOptions",
  "contextFiles",
  "entries",
  "branch",
  "raw",
  "images",
  "imageData",
  "fullLog",
]);

const TOOL_PAYLOAD_KEYS = new Set([
  "args",
  "result",
  "partialResult",
  "resultText",
  "details",
]);

function sanitizeData(
  data: Record<string, unknown>,
  options: GlobalArgs,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!options.includeContent && CONTENT_KEYS.has(key)) continue;
    if (!options.includeToolPayloads && TOOL_PAYLOAD_KEYS.has(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function sanitizeEvent(event: PiEvent, options: GlobalArgs): PiEvent {
  const sanitized: PiEvent = {
    ...event,
    data: sanitizeData(event.data, options),
  };
  if (!options.includePaths) {
    delete sanitized.cwd;
    delete sanitized.sessionFile;
  }
  return sanitized;
}

function contextOptions(context: ModelContext): GlobalArgs {
  return GlobalArgsSchema.parse(context.globalArgs ?? {});
}

function summarize(events: PiEvent[]): BatchSummary {
  const eventTypes: Record<string, number> = {};
  const sessionIds = new Set<string>();
  for (const event of events) {
    sessionIds.add(event.sessionId);
    eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
  }
  return {
    id: crypto.randomUUID(),
    ingestedAt: new Date().toISOString(),
    eventCount: events.length,
    sessionIds: [...sessionIds].sort(),
    eventTypes,
  };
}

async function writeSpecializedResources(
  event: PiEvent,
  context: ModelContext,
): Promise<Array<{ name: string }>> {
  const handles: Array<{ name: string }> = [];
  const base = {
    id: event.id,
    sessionId: event.sessionId,
    timestamp: event.timestamp,
    cwd: event.cwd,
  };

  if (event.type === "input" || event.type === "before_agent_start") {
    handles.push(
      await context.writeResource("prompt", safeName("prompt", event.id), {
        ...base,
        ...event.data,
      }),
    );
  }

  if (event.type === "message_end") {
    const message = { ...base, ...event.data };
    handles.push(
      await context.writeResource(
        "message",
        safeName("message", event.id),
        message,
      ),
    );
    const usage = event.data.usage;
    if (usage && typeof usage === "object") {
      const usageRecord = usage as Record<string, unknown>;
      const cost = usageRecord.cost && typeof usageRecord.cost === "object"
        ? usageRecord.cost as Record<string, unknown>
        : {};
      handles.push(
        await context.writeResource("usage", safeName("usage", event.id), {
          ...base,
          provider: event.data.provider,
          model: event.data.model,
          input: usageRecord.input,
          output: usageRecord.output,
          cacheRead: usageRecord.cacheRead,
          cacheWrite: usageRecord.cacheWrite,
          totalUsageCount: usageRecord.totalTokens,
          costTotal: cost.total,
          usage,
        }),
      );
    }
  }

  if (
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_update" ||
    event.type === "tool_execution_end"
  ) {
    handles.push(
      await context.writeResource("toolExecution", safeName("tool", event.id), {
        ...base,
        ...event.data,
        phase: event.type.replace("tool_execution_", ""),
      }),
    );
  }

  if (event.type === "session_snapshot") {
    handles.push(
      await context.writeResource(
        "sessionSnapshot",
        safeName("snapshot", event.id),
        {
          ...base,
          sessionFile: event.sessionFile,
          ...event.data,
        },
      ),
    );
  }

  return handles;
}

/** Model that stores pi session telemetry events for reporting. */
export const model = {
  type: "@evrardjp/pi-session-telemetry",
  version: "2026.06.29.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    event: {
      description: "One privacy-sanitized pi session telemetry event",
      schema: EventSchema,
      lifetime: "30d" as const,
      garbageCollection: 10000,
    },
    prompt: {
      description: "Captured user/system prompt metadata; content is opt-in",
      schema: PromptSchema,
      lifetime: "30d" as const,
      garbageCollection: 2000,
    },
    message: {
      description:
        "Captured pi conversation message metadata; content is opt-in",
      schema: MessageSchema,
      lifetime: "30d" as const,
      garbageCollection: 5000,
    },
    toolExecution: {
      description:
        "Captured tool execution phase and errors; payloads are opt-in",
      schema: ToolExecutionSchema,
      lifetime: "30d" as const,
      garbageCollection: 5000,
    },
    usage: {
      description: "Assistant model token and cost usage",
      schema: UsageSchema,
      lifetime: "30d" as const,
      garbageCollection: 5000,
    },
    sessionSnapshot: {
      description: "Session tree or active branch snapshot",
      schema: SessionSnapshotSchema,
      lifetime: "30d" as const,
      garbageCollection: 500,
    },
    batch: {
      description: "Ingestion batch summary",
      schema: BatchSummarySchema,
      lifetime: "30d" as const,
      garbageCollection: 200,
    },
  },
  reports: ["@evrardjp/pi-session-report"],
  methods: {
    ingest: {
      description: "Ingest one sanitized pi telemetry event",
      arguments: z.object({ event: EventSchema }),
      execute: async (
        args: { event: PiEvent },
        context: ModelContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const event = sanitizeEvent(
          EventSchema.parse(args.event),
          contextOptions(context),
        );
        const handles = [
          await context.writeResource(
            "event",
            safeName("event", event.id),
            event,
          ),
          ...await writeSpecializedResources(event, context),
        ];
        return { dataHandles: handles };
      },
    },
    ingest_batch: {
      description: "Ingest a batch of sanitized pi telemetry events",
      arguments: z.object({ events: z.array(EventSchema).min(1).max(200) }),
      execute: async (
        args: { events: PiEvent[] },
        context: ModelContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const options = contextOptions(context);
        const events = z.array(EventSchema).min(1).max(200).parse(args.events)
          .map((event) => sanitizeEvent(event, options));
        const handles: Array<{ name: string }> = [];
        for (const event of events) {
          handles.push(
            await context.writeResource(
              "event",
              safeName("event", event.id),
              event,
            ),
          );
          handles.push(...await writeSpecializedResources(event, context));
        }
        const summary = summarize(events);
        handles.push(
          await context.writeResource(
            "batch",
            safeName("batch", summary.id),
            summary,
          ),
        );
        return { dataHandles: handles };
      },
    },
  },
};
