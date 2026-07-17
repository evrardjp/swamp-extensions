/**
 * Overview report for archived OpenCode session metadata.
 *
 * @module
 */

type DataEntry = {
  name: string;
  version: number;
  tags?: Record<string, string>;
  metadata?: { tags?: Record<string, string> };
};

type SessionMetadata = {
  sessionID: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  messageCount: number;
  toolCallCount: number;
  errorCount: number;
  discussion?: string;
  archived: boolean;
  models: Array<{
    providerID: string;
    modelID: string;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cost: number;
  }>;
  tools: Record<string, number>;
};

type ReportContext = {
  modelType?: { normalized?: string } | string;
  modelId?: string;
  definition?: { name?: string };
  dataRepository?: {
    findAllForModel(modelType: unknown, modelId: string): Promise<DataEntry[]>;
    getContent(
      modelType: unknown,
      modelId: string,
      name: string,
      version?: number,
    ): Promise<Uint8Array | null>;
  };
};

function typeName(value: ReportContext["modelType"]): string {
  return typeof value === "string" ? value : value?.normalized ?? "";
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function table(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return ["_None._"];
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
}

function increment(
  target: Record<string, number>,
  key: string,
  value = 1,
): void {
  target[key] = (target[key] ?? 0) + value;
}

function topRows(values: Record<string, number>, limit = 15): string[][] {
  return Object.entries(values)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => [escapeCell(name), String(count)]);
}

/** Model-scope report summarizing OpenCode sessions and archives. */
export const report = {
  name: "@evrardjp/opencode-session-overview",
  description:
    "Summarize OpenCode session activity, usage, topics, and archives",
  scope: "model" as const,
  labels: ["opencode", "sessions", "analytics", "archive"],
  execute: async (context: ReportContext) => {
    if (typeName(context.modelType) !== "@evrardjp/opencode-session-archive") {
      return { markdown: "", json: {} };
    }

    const entries = await context.dataRepository?.findAllForModel(
      context.modelType,
      context.modelId!,
    ) ?? [];
    const latest = new Map<string, DataEntry>();
    for (const entry of entries) {
      const tags = entry.tags ?? entry.metadata?.tags ?? {};
      if (tags.specName !== "session") continue;
      const current = latest.get(entry.name);
      if (!current || entry.version > current.version) {
        latest.set(entry.name, entry);
      }
    }

    const sessions: SessionMetadata[] = [];
    for (const entry of latest.values()) {
      const content = await context.dataRepository?.getContent(
        context.modelType,
        context.modelId!,
        entry.name,
        entry.version,
      );
      if (content) {
        sessions.push(
          JSON.parse(new TextDecoder().decode(content)) as SessionMetadata,
        );
      }
    }
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const models: Record<string, number> = {};
    const tools: Record<string, number> = {};
    let durationMs = 0;
    let messages = 0;
    let toolCalls = 0;
    let errors = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let cost = 0;
    for (const session of sessions) {
      durationMs += session.durationMs;
      messages += session.messageCount;
      toolCalls += session.toolCallCount;
      errors += session.errorCount;
      for (const usage of session.models) {
        increment(models, `${usage.providerID}/${usage.modelID}`);
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
        reasoningTokens += usage.reasoningTokens;
        cacheReadTokens += usage.cacheReadTokens;
        cacheWriteTokens += usage.cacheWriteTokens;
        cost += usage.cost;
      }
      for (const [tool, count] of Object.entries(session.tools)) {
        increment(tools, tool, count);
      }
    }

    const archived = sessions.filter((session) => session.archived).length;
    const recent = sessions.slice(0, 25).map((session) => [
      session.updatedAt,
      escapeCell(session.title).slice(0, 100),
      `${Math.round(session.durationMs / 60000)}m`,
      String(session.messageCount),
      session.archived ? `archive-${session.sessionID}` : "",
      escapeCell(session.discussion ?? "").slice(0, 180),
    ]);
    const name = context.definition?.name ?? "opencode-sessions";
    const lines = [
      `# OpenCode Session Overview - ${name}`,
      "",
      `Sessions: **${sessions.length}** | Archived: **${archived}** | Messages: **${messages}** | Duration: **${
        (durationMs / 3600000).toFixed(1)
      }h**`,
      `Tool calls: **${toolCalls}** | Errors: **${errors}** | Estimated cost: **$${
        cost.toFixed(4)
      }**`,
      "",
      "## Tokens",
      "",
      `Input: **${inputTokens}** | Output: **${outputTokens}** | Reasoning: **${reasoningTokens}** | Cache read: **${cacheReadTokens}** | Cache write: **${cacheWriteTokens}**`,
      "",
      "## Models",
      ...table(["Model", "Sessions"], topRows(models)),
      "",
      "## Tools",
      ...table(["Tool", "Calls"], topRows(tools)),
      "",
      "## Recent Sessions",
      ...table(
        [
          "Updated",
          "Title",
          "Duration",
          "Messages",
          "Archive data",
          "Discussion",
        ],
        recent,
      ),
    ];

    return {
      markdown: `${lines.join("\n")}\n`,
      json: {
        sessionCount: sessions.length,
        archivedCount: archived,
        durationMs,
        messageCount: messages,
        toolCallCount: toolCalls,
        errorCount: errors,
        usage: {
          inputTokens,
          outputTokens,
          reasoningTokens,
          cacheReadTokens,
          cacheWriteTokens,
          cost,
        },
        models,
        tools,
        recentSessions: sessions.slice(0, 25),
      },
    };
  },
};
