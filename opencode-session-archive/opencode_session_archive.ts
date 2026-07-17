/**
 * Long-term OpenCode session metadata and native export archive storage.
 *
 * @module
 */
import { z } from "npm:zod@4";

const SessionIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);

const ModelUsageSchema = z.object({
  providerID: z.string().min(1),
  modelID: z.string().min(1),
  messageCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
});

const SessionMetadataSchema = z.object({
  sessionID: SessionIdSchema,
  projectID: z.string().min(1),
  parentID: z.string().optional(),
  title: z.string().max(1000),
  opencodeVersion: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  userMessageCount: z.number().int().nonnegative(),
  assistantMessageCount: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  discussion: z.string().max(4000).optional(),
  discussionTruncated: z.boolean(),
  directory: z.string().max(4096).optional(),
  archived: z.boolean(),
  models: z.array(ModelUsageSchema).max(100),
  tools: z.record(z.string(), z.number().int().nonnegative()),
});

const NativeMessageSchema = z.object({
  info: z.object({
    id: z.string().min(1),
    sessionID: SessionIdSchema,
    role: z.string().min(1),
  }).passthrough(),
  parts: z.array(
    z.object({
      id: z.string().min(1),
      sessionID: SessionIdSchema,
      messageID: z.string().min(1),
      type: z.string().min(1),
    }).passthrough(),
  ),
});

const NativeArchiveSchema = z.object({
  info: z.object({ id: SessionIdSchema }).passthrough(),
  messages: z.array(NativeMessageSchema).max(100000),
});

const IngestPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  exportedAt: z.iso.datetime(),
  reason: z.enum(["idle", "manual", "backfill"]),
  metadata: SessionMetadataSchema,
  archiveJson: z.string().min(2).optional().meta({ sensitive: true }),
});

const IngestReceiptSchema = z.object({
  sessionID: SessionIdSchema,
  exportedAt: z.iso.datetime(),
  archived: z.boolean(),
  archiveDataName: z.string().optional(),
});

type IngestPayload = z.infer<typeof IngestPayloadSchema>;
type DataHandle = { name: string };
type ModelContext = {
  readResource: (name: string) => Promise<Record<string, unknown> | null>;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<DataHandle>;
  createFileWriter: (
    specName: string,
    name: string,
    overrides?: Record<string, unknown>,
  ) => { writeText: (content: string) => Promise<DataHandle> };
  logger?: {
    info: (message: string, values?: Record<string, unknown>) => void;
  };
};

function parseArchive(payload: IngestPayload) {
  if (!payload.archiveJson) return undefined;
  try {
    return NativeArchiveSchema.parse(JSON.parse(payload.archiveJson));
  } catch (error) {
    throw new Error(
      `archiveJson is not a valid native OpenCode export: ${error}`,
    );
  }
}

function validatePayload(
  payload: IngestPayload,
  archive: z.infer<typeof NativeArchiveSchema> | undefined,
): void {
  if (payload.metadata.archived !== Boolean(archive)) {
    throw new Error("metadata.archived must match archiveJson presence");
  }
  if (
    archive && archive.info.id !== payload.metadata.sessionID
  ) {
    throw new Error("archive session ID must match metadata session ID");
  }
  for (const message of archive?.messages ?? []) {
    if (message.info.sessionID !== payload.metadata.sessionID) {
      throw new Error(
        "archive message session ID must match metadata session ID",
      );
    }
    for (const part of message.parts) {
      if (
        part.sessionID !== payload.metadata.sessionID ||
        part.messageID !== message.info.id
      ) {
        throw new Error(
          "archive part references an inconsistent session or message",
        );
      }
    }
  }
}

/** Model that stores OpenCode session analytics and importable native archives. */
export const model = {
  type: "@evrardjp/opencode-session-archive",
  version: "2026.07.17.1",
  globalArguments: z.object({}),
  resources: {
    session: {
      description: "Long-lived OpenCode session metadata and usage totals",
      schema: SessionMetadataSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
    receipt: {
      description:
        "Latest successful ingestion receipt for an OpenCode session",
      schema: IngestReceiptSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  files: {
    archive: {
      description:
        "Native OpenCode JSON export, directly accepted by opencode import",
      contentType: "application/json",
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  reports: ["@evrardjp/opencode-session-overview"],
  methods: {
    ingest: {
      description:
        "Ingest one OpenCode session export from the webhook workflow",
      arguments: z.object({ payload: IngestPayloadSchema }),
      execute: async (
        args: { payload: IngestPayload },
        context: ModelContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const payload = IngestPayloadSchema.parse(args.payload);
        const archive = parseArchive(payload);
        validatePayload(payload, archive);

        const handles: DataHandle[] = [];
        const sessionName = `session-${payload.metadata.sessionID}`;
        context.logger?.info("Ingesting OpenCode session {sessionID}", {
          sessionID: payload.metadata.sessionID,
        });

        let archiveDataName: string | undefined;
        if (archive) {
          archiveDataName = `archive-${payload.metadata.sessionID}`;
          handles.push(
            await context.createFileWriter("archive", archiveDataName, {
              tags: { sessionID: payload.metadata.sessionID },
            }).writeText(`${JSON.stringify(archive, null, 2)}\n`),
          );
        }

        const previous = await context.readResource(sessionName);
        const archived = payload.metadata.archived ||
          previous?.archived === true;
        if (archived) archiveDataName = `archive-${payload.metadata.sessionID}`;
        handles.push(
          await context.writeResource("session", sessionName, {
            ...payload.metadata,
            archived,
          }),
        );

        handles.push(
          await context.writeResource(
            "receipt",
            `receipt-${payload.metadata.sessionID}`,
            {
              sessionID: payload.metadata.sessionID,
              exportedAt: payload.exportedAt,
              archived,
              archiveDataName,
            },
          ),
        );
        context.logger?.info("Ingested OpenCode session {sessionID}", {
          sessionID: payload.metadata.sessionID,
        });
        return { dataHandles: handles };
      },
    },
  },
};
