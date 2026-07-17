/** OpenCode plugin that exports session metadata and optional native archives to Swamp. */
import type { Message, Part, Session } from "@opencode-ai/sdk";
import { type Plugin, tool } from "@opencode-ai/plugin";

type MessageWithParts = { info: Message; parts: Part[] };
type ArchivePolicy = "none" | "tagged" | "all";
type ExportReason = "idle" | "manual" | "backfill";
type ExporterOptions = {
  endpoint: string;
  token?: string;
  tokenEnv: string;
  authHeader: string;
  authPrefix: string;
  archivePolicy: ArchivePolicy;
  archiveTitleTag: string;
  includeDiscussionText: boolean;
  includeDirectory: boolean;
  discussionMaxChars: number;
  requestTimeoutMs: number;
};

type ModelUsage = {
  providerID: string;
  modelID: string;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
};

function stringOption(
  options: Record<string, unknown>,
  name: string,
  fallback: string,
): string {
  return typeof options[name] === "string" ? options[name] as string : fallback;
}

function numberOption(
  options: Record<string, unknown>,
  name: string,
  fallback: number,
): number {
  const value = options[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseOptions(raw: Record<string, unknown>): ExporterOptions {
  const policy = stringOption(raw, "archivePolicy", "tagged");
  if (policy !== "none" && policy !== "tagged" && policy !== "all") {
    throw new Error("archivePolicy must be none, tagged, or all");
  }
  return {
    endpoint: stringOption(
      raw,
      "endpoint",
      process.env.OPENCODE_SWAMP_WEBHOOK_URL ?? "",
    ),
    token: typeof raw.token === "string" ? raw.token : undefined,
    tokenEnv: stringOption(raw, "tokenEnv", "OPENCODE_SWAMP_WEBHOOK_TOKEN"),
    authHeader: stringOption(raw, "authHeader", "x-opencode-swamp-token"),
    authPrefix: stringOption(raw, "authPrefix", "Bearer "),
    archivePolicy: policy,
    archiveTitleTag: stringOption(raw, "archiveTitleTag", "[archive]"),
    includeDiscussionText: raw.includeDiscussionText === true,
    includeDirectory: raw.includeDirectory === true,
    discussionMaxChars: Math.max(
      0,
      Math.min(4000, Math.trunc(numberOption(raw, "discussionMaxChars", 1000))),
    ),
    requestTimeoutMs: Math.max(
      1000,
      Math.min(
        120000,
        Math.trunc(numberOption(raw, "requestTimeoutMs", 15000)),
      ),
    ),
  };
}

function textParts(message: MessageWithParts): string[] {
  return message.parts.flatMap((part) =>
    part.type === "text" && !("synthetic" in part && part.synthetic)
      ? [part.text.trim()]
      : []
  ).filter(Boolean);
}

function toolName(part: Part): string | undefined {
  if (part.type !== "tool") return undefined;
  return "tool" in part && typeof part.tool === "string"
    ? part.tool
    : "unknown";
}

/** Build the versioned webhook payload without mutating OpenCode data. */
export function buildExportPayload(
  session: Session,
  messages: MessageWithParts[],
  options: Pick<
    ExporterOptions,
    | "archivePolicy"
    | "archiveTitleTag"
    | "includeDiscussionText"
    | "includeDirectory"
    | "discussionMaxChars"
  >,
  reason: ExportReason,
  forceArchive = false,
) {
  const archive = forceArchive || options.archivePolicy === "all" ||
    (options.archivePolicy === "tagged" &&
      session.title.includes(options.archiveTitleTag));
  const models = new Map<string, ModelUsage>();
  const tools: Record<string, number> = {};
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let errorCount = 0;
  for (const message of messages) {
    if (message.info.role === "user") userMessageCount++;
    if (message.info.role === "assistant") {
      assistantMessageCount++;
      if (message.info.error) errorCount++;
      const key = `${message.info.providerID}/${message.info.modelID}`;
      const usage = models.get(key) ?? {
        providerID: message.info.providerID,
        modelID: message.info.modelID,
        messageCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0,
      };
      usage.messageCount++;
      usage.inputTokens += message.info.tokens.input;
      usage.outputTokens += message.info.tokens.output;
      usage.reasoningTokens += message.info.tokens.reasoning;
      usage.cacheReadTokens += message.info.tokens.cache.read;
      usage.cacheWriteTokens += message.info.tokens.cache.write;
      usage.cost += message.info.cost;
      models.set(key, usage);
    }
    for (const part of message.parts) {
      const name = toolName(part);
      if (name) tools[name] = (tools[name] ?? 0) + 1;
    }
  }

  const discussion = options.includeDiscussionText
    ? messages.filter((message) => message.info.role === "user")
      .flatMap(textParts).join("\n\n")
    : undefined;
  return {
    schemaVersion: 1 as const,
    exportedAt: new Date().toISOString(),
    reason,
    metadata: {
      sessionID: session.id,
      projectID: session.projectID,
      parentID: session.parentID,
      title: session.title,
      opencodeVersion: session.version,
      createdAt: new Date(session.time.created).toISOString(),
      updatedAt: new Date(session.time.updated).toISOString(),
      durationMs: Math.max(0, session.time.updated - session.time.created),
      messageCount: messages.length,
      userMessageCount,
      assistantMessageCount,
      toolCallCount: Object.values(tools).reduce(
        (sum, count) => sum + count,
        0,
      ),
      errorCount,
      discussion: discussion?.slice(0, options.discussionMaxChars) || undefined,
      discussionTruncated: Boolean(
        discussion && discussion.length > options.discussionMaxChars,
      ),
      directory: options.includeDirectory ? session.directory : undefined,
      archived: archive,
      models: [...models.values()],
      tools,
    },
    archiveJson: archive
      ? JSON.stringify({ info: session, messages })
      : undefined,
  };
}

export const OpenCodeSwampExporter: Plugin = async ({ client }, rawOptions) => {
  const options = parseOptions(rawOptions ?? {});
  const inFlight = new Map<string, Promise<void>>();
  const exportedUpdate = new Map<string, number>();

  const log = async (
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ) => {
    await client.app.log({
      body: { service: "opencode-swamp-exporter", level, message },
    });
  };

  const exportSession = async (
    sessionID: string,
    reason: ExportReason,
    forceArchive = false,
  ): Promise<void> => {
    if (!options.endpoint) {
      throw new Error("Swamp webhook endpoint is not configured");
    }
    const token = options.token ?? process.env[options.tokenEnv];
    if (!token) {
      throw new Error(`Swamp webhook token is missing (${options.tokenEnv})`);
    }

    const sessionResult = await client.session.get({ path: { id: sessionID } });
    if (!sessionResult.data) {
      throw new Error(`OpenCode session not found: ${sessionID}`);
    }
    if (
      !forceArchive &&
      exportedUpdate.get(sessionID) === sessionResult.data.time.updated
    ) {
      return;
    }
    const messagesResult = await client.session.messages({
      path: { id: sessionID },
    });
    if (!messagesResult.data) {
      throw new Error(`OpenCode messages not found: ${sessionID}`);
    }
    const payload = buildExportPayload(
      sessionResult.data,
      messagesResult.data,
      options,
      reason,
      forceArchive,
    );
    const response = await fetch(options.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [options.authHeader]: `${options.authPrefix}${token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `Swamp webhook rejected export with HTTP ${response.status}`,
      );
    }
    exportedUpdate.set(sessionID, sessionResult.data.time.updated);
  };

  const enqueue = (
    sessionID: string,
    reason: ExportReason,
    forceArchive = false,
  ): Promise<void> => {
    const current = inFlight.get(sessionID) ?? Promise.resolve();
    const next = current.then(() =>
      exportSession(sessionID, reason, forceArchive)
    )
      .catch(async (error) => {
        await log(
          "error",
          `Session ${sessionID} export failed: ${String(error)}`,
        );
        throw error;
      }).finally(() => {
        if (inFlight.get(sessionID) === next) inFlight.delete(sessionID);
      });
    inFlight.set(sessionID, next);
    return next;
  };

  if (!options.endpoint) {
    await log(
      "warn",
      "Swamp exporter is loaded but no webhook endpoint is configured",
    );
  }

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle" || !options.endpoint) return;
      await enqueue(event.properties.sessionID, "idle").catch(() => undefined);
    },
    tool: {
      swamp_archive_session: tool({
        description:
          "Archive an OpenCode session in Swamp using its native importable JSON format",
        args: {
          sessionID: tool.schema.string().optional().describe(
            "Session ID to archive; defaults to the current session",
          ),
        },
        execute: async (args, context) => {
          const sessionID = args.sessionID ?? context.sessionID;
          await enqueue(sessionID, "manual", true);
          return `Archived OpenCode session ${sessionID} in Swamp.`;
        },
      }),
    },
  };
};

export default OpenCodeSwampExporter;
