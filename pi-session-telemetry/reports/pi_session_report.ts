/**
 * Report for @evrardjp/pi-session-telemetry model instances.
 *
 * Summarizes pi session telemetry by event type, session, model, tool, and
 * errors. The report is intentionally content-light; prompt and tool payloads
 * are captured only when the pi extension is explicitly configured to do so.
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

type PiEvent = {
  id: string;
  sessionId: string;
  type: string;
  timestamp: string;
  cwd?: string;
  piMode?: string;
  sessionFile?: string;
  data?: Record<string, unknown>;
};

function normalizedType(
  modelType: { normalized?: string } | string | undefined,
): string {
  if (!modelType) return "";
  if (typeof modelType === "string") return modelType;
  return modelType.normalized ?? "";
}

function inc(map: Record<string, number>, key: string | undefined): void {
  const safe = key && key.length > 0 ? key : "unknown";
  map[safe] = (map[safe] ?? 0) + 1;
}

function renderTable(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return ["_None._"];
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines;
}

function topRows(counts: Record<string, number>, limit = 20): string[][] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => [name.replaceAll("|", "\\|"), String(count)]);
}

/** Model-scope report summarizing pi telemetry events. */
export const report = {
  name: "@evrardjp/pi-session-report",
  description: "Summarize pi coding-agent session telemetry captured in swamp",
  scope: "model" as const,
  labels: ["pi", "telemetry", "agent", "reporting"],

  execute: async (context: ReportCtx) => {
    if (
      normalizedType(context.modelType) !== "@evrardjp/pi-session-telemetry"
    ) {
      return { markdown: "", json: {} };
    }

    const entries = await context.dataRepository?.findAllForModel(
      context.modelType,
      context.modelId!,
    ) ?? [];
    const eventEntries = entries.filter((entry) => {
      const tags = entry.tags ?? entry.metadata?.tags ?? {};
      return tags.specName === "event";
    });

    const events: PiEvent[] = [];
    for (const entry of eventEntries) {
      const bytes = await context.dataRepository?.getContent(
        context.modelType,
        context.modelId!,
        entry.name,
        entry.version,
      );
      if (!bytes) continue;
      events.push(JSON.parse(new TextDecoder().decode(bytes)) as PiEvent);
    }
    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const byType: Record<string, number> = {};
    const bySession: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    const byTool: Record<string, number> = {};
    const byCwd: Record<string, number> = {};
    const byRole: Record<string, number> = {};
    const errors: PiEvent[] = [];
    const messages: PiEvent[] = [];
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalTokens = 0;
    let totalCost = 0;
    let promptEvents = 0;
    let snapshotEvents = 0;

    for (const event of events) {
      inc(byType, event.type);
      inc(bySession, event.sessionId);
      inc(byCwd, event.cwd);
      if (event.type === "model_select") {
        inc(byModel, String(event.data?.model ?? "unknown"));
      }
      if (event.type === "input" || event.type === "before_agent_start") {
        promptEvents++;
      }
      if (event.type === "session_snapshot") {
        snapshotEvents++;
      }
      if (event.type === "message_end") {
        messages.push(event);
        inc(byRole, String(event.data?.role ?? "unknown"));
        const usage = event.data?.usage && typeof event.data.usage === "object"
          ? event.data.usage as Record<string, unknown>
          : undefined;
        const cost = usage?.cost && typeof usage.cost === "object"
          ? usage.cost as Record<string, unknown>
          : undefined;
        totalInput += Number(usage?.input ?? 0);
        totalOutput += Number(usage?.output ?? 0);
        totalCacheRead += Number(usage?.cacheRead ?? 0);
        totalCacheWrite += Number(usage?.cacheWrite ?? 0);
        totalTokens += Number(usage?.totalTokens ?? 0);
        totalCost += Number(cost?.total ?? 0);
      }
      if (event.type === "tool_execution_end") {
        inc(byTool, String(event.data?.toolName ?? "unknown"));
        if (event.data?.isError === true) errors.push(event);
      }
    }

    const first = events[0]?.timestamp ?? "n/a";
    const last = events.at(-1)?.timestamp ?? "n/a";
    const modelName = context.definition?.name ?? context.modelId ??
      "pi-session-telemetry";
    const lines = [
      `# Pi Session Telemetry — ${modelName}`,
      "",
      `Events: **${events.length}**  ·  Messages: **${messages.length}**  ·  Prompt events: **${promptEvents}**  ·  Snapshots: **${snapshotEvents}**`,
      `Sessions: **${
        Object.keys(bySession).length
      }**  ·  Range: ${first} → ${last}`,
      "",
      "## Usage",
      `Input: **${totalInput}**  ·  Output: **${totalOutput}**  ·  Cache read: **${totalCacheRead}**  ·  Cache write: **${totalCacheWrite}**  ·  Total tokens: **${totalTokens}**  ·  Cost: **$${
        totalCost.toFixed(6)
      }**`,
      "",
      "## Event Types",
      ...renderTable(["Type", "Count"], topRows(byType)),
      "",
      "## Tools",
      ...renderTable(["Tool", "Count"], topRows(byTool)),
      "",
      "## Models Selected",
      ...renderTable(["Model", "Count"], topRows(byModel)),
      "",
      "## Message Roles",
      ...renderTable(["Role", "Count"], topRows(byRole)),
      "",
      "## Sessions",
      ...renderTable(["Session", "Events"], topRows(bySession)),
      "",
      "## Working Directories",
      ...renderTable(["Directory", "Events"], topRows(byCwd)),
      "",
      "## Tool Errors",
    ];

    if (errors.length === 0) {
      lines.push("_No tool errors captured._");
    } else {
      lines.push(...renderTable(
        ["Time", "Session", "Tool", "Message"],
        errors.slice(-20).map((event) => [
          event.timestamp,
          event.sessionId,
          String(event.data?.toolName ?? "unknown"),
          String(event.data?.message ?? "").replaceAll("|", "\\|").slice(
            0,
            160,
          ),
        ]),
      ));
    }

    lines.push("", "## Recent Conversation Messages");
    const recent = messages.slice(-20).map((event) => [
      event.timestamp,
      String(event.data?.role ?? "unknown"),
      String(event.data?.model ?? ""),
      String(event.data?.contentText ?? event.data?.contentHash ?? "")
        .replaceAll("|", "\\|")
        .replaceAll("\n", " ")
        .slice(0, 220),
    ]);
    lines.push(...renderTable(["Time", "Role", "Model", "Content"], recent));

    return {
      markdown: `${lines.join("\n")}\n`,
      json: {
        eventCount: events.length,
        messageCount: messages.length,
        promptEvents,
        snapshotEvents,
        usage: {
          totalInput,
          totalOutput,
          totalCacheRead,
          totalCacheWrite,
          totalTokens,
          totalCost,
        },
        byType,
        bySession,
        byModel,
        byTool,
        byRole,
        byCwd,
        errors,
        recentMessages: messages.slice(-20),
      },
    };
  },
};
