type DataEntry = {
  name: string;
  version?: number;
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

function normalizedType(
  modelType: { normalized?: string } | string | undefined,
): string {
  if (!modelType) return "";
  if (typeof modelType === "string") return modelType;
  return modelType.normalized ?? "";
}

async function readJson<T>(
  context: ReportCtx,
  entry: DataEntry,
): Promise<T | null> {
  const bytes = await context.dataRepository?.getContent(
    context.modelType,
    context.modelId ?? context.definition?.id ?? "",
    entry.name,
    entry.version,
  );
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

function md(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function tagsOf(entry: DataEntry): Record<string, string> {
  return entry.tags ?? entry.metadata?.tags ?? {};
}

function latestByName(
  entries: DataEntry[],
  name: string,
): DataEntry | undefined {
  return entries.filter((e) => e.name === name).sort((a, b) =>
    (b.version ?? 0) - (a.version ?? 0)
  )[0];
}

function latestEntriesByPrefix(
  entries: DataEntry[],
  prefix: string,
): DataEntry[] {
  const latest = new Map<string, DataEntry>();
  for (const entry of entries.filter((e) => e.name.startsWith(prefix))) {
    const current = latest.get(entry.name);
    if (!current || (entry.version ?? 0) > (current.version ?? 0)) {
      latest.set(entry.name, entry);
    }
  }
  return [...latest.values()].sort((a, b) => b.name.localeCompare(a.name));
}

/** Human status report for @evrardjp/github-local-mirror. */
export const report = {
  name: "@evrardjp/github-local-mirror-status",
  description:
    "Summarize sync freshness, local mirror paths, and registered worktree state for a GitHub local mirror model.",
  scope: "model",
  execute: async (context: ReportCtx) => {
    if (normalizedType(context.modelType) !== "@evrardjp/github-local-mirror") {
      return {
        markdown:
          "# GitHub Local Mirror Status\n\nThis report only supports @evrardjp/github-local-mirror models.\n",
      };
    }
    const modelId = context.modelId ?? context.definition?.id;
    if (!modelId || !context.dataRepository) {
      return {
        markdown:
          "# GitHub Local Mirror Status\n\nNo Swamp data repository was available to the report.\n",
      };
    }
    const entries = await context.dataRepository.findAllForModel(
      context.modelType,
      modelId,
    );
    const statusEntry = latestByName(entries, "mirror-status-current") ??
      latestByName(entries, "current");
    const status = statusEntry
      ? await readJson<Record<string, unknown>>(context, statusEntry)
      : null;
    const syncEntries = latestEntriesByPrefix(entries, "sync-");
    const syncRuns: Record<string, unknown>[] = [];
    for (const entry of syncEntries.slice(0, 10)) {
      const data = await readJson<Record<string, unknown>>(context, entry);
      if (data) syncRuns.push({ dataName: entry.name, ...data });
    }
    const latestSync = syncRuns[0];
    const dataCounts = new Map<string, number>();
    for (const entry of entries) {
      const specName = tagsOf(entry).specName;
      if (!specName) continue;
      dataCounts.set(specName, (dataCounts.get(specName) ?? 0) + 1);
    }
    const analyses: Record<string, unknown>[] = [];
    for (const entry of entries.filter((e) => e.name.startsWith("worktree-"))) {
      const data = await readJson<Record<string, unknown>>(context, entry);
      if (data && "recommendedAction" in data) analyses.push(data);
    }
    const stale = analyses.filter((a) => a.isPrHeadStale === true);
    const dirty = analyses.filter((a) => a.isDirty === true);
    const ahead = analyses.filter((a) => Number(a.aheadCommitCount ?? 0) > 0);
    const missing = analyses.filter((a) => a.missing === true);
    const lines: string[] = [];
    lines.push("# GitHub Local Mirror Status");
    lines.push("");
    lines.push(`Model: \`${md(context.definition?.name ?? modelId)}\``);
    const repo = status?.repo ??
      `${context.globalArgs?.owner ?? "unknown"}/${
        context.globalArgs?.repo ?? "unknown"
      }`;
    lines.push(`Repository: \`${md(repo)}\``);
    lines.push("");
    lines.push("## Sync");
    lines.push("");
    const state = status?.state as Record<string, unknown> | undefined;
    const cursor = state?.cursor as Record<string, unknown> | undefined;
    lines.push(
      `- Last successful sync: ${
        md(cursor?.lastSuccessfulSyncAt ?? "unknown")
      }`,
    );
    lines.push(`- Last PR cursor: ${md(cursor?.lastPrUpdatedAt ?? "unknown")}`);
    lines.push(
      `- Last issue cursor: ${md(cursor?.lastIssueUpdatedAt ?? "unknown")}`,
    );
    lines.push(`- Sync in progress: ${md(state?.syncInProgress ?? false)}`);
    if (latestSync) {
      lines.push(`- Latest sync artifact: \`${md(latestSync.dataName)}\``);
      lines.push(`- Latest sync started: ${md(latestSync.startedAt)}`);
      lines.push(`- Latest sync finished: ${md(latestSync.finishedAt)}`);
      lines.push(`- PRs synced in latest run: ${md(latestSync.prCount ?? 0)}`);
      lines.push(`- Issues synced in latest run: ${md(latestSync.issueCount ?? 0)}`);
      lines.push(`- Events synced in latest run: ${md(latestSync.eventCount ?? 0)}`);
      lines.push(
        `- Check runs synced in latest run: ${md(latestSync.checkRunCount ?? 0)}`,
      );
    }
    lines.push(
      `- Git object path: \`${
        md(status?.gitObjectPath ?? context.globalArgs?.gitObjectPath ?? "")
      }\``,
    );
    lines.push(
      `- Artifact root: \`${
        md(status?.artifactRoot ?? context.globalArgs?.artifactRoot ?? "")
      }\``,
    );
    lines.push(
      `- Workspace root: \`${
        md(status?.workspaceRoot ?? context.globalArgs?.workspaceRoot ?? "")
      }\``,
    );
    lines.push("");
    lines.push("## Mirrored data");
    lines.push("");
    if (dataCounts.size === 0) {
      lines.push("_No typed mirror data has been recorded yet._");
    } else {
      lines.push("| Data spec | Artifacts |");
      lines.push("| --- | ---: |");
      for (const [specName, count] of [...dataCounts.entries()].sort()) {
        lines.push(`| ${md(specName)} | ${count} |`);
      }
    }
    lines.push("");
    lines.push("## Recent sync runs");
    lines.push("");
    if (syncRuns.length === 0) {
      lines.push("_No sync runs recorded yet._");
    } else {
      lines.push("| Finished | PRs | Issues | Events | Checks | Artifact |");
      lines.push("| --- | ---: | ---: | ---: | ---: | --- |");
      for (const run of syncRuns) {
        lines.push(
          `| ${md(run.finishedAt)} | ${md(run.prCount ?? 0)} | ${
            md(run.issueCount ?? 0)
          } | ${md(run.eventCount ?? 0)} | ${md(run.checkRunCount ?? 0)} | \`${
            md(run.dataName)
          }\` |`,
        );
      }
    }
    lines.push("");
    lines.push("## Worktrees");
    lines.push("");
    lines.push(`- Registered: ${analyses.length}`);
    lines.push(`- Stale PR head: ${stale.length}`);
    lines.push(`- Dirty: ${dirty.length}`);
    lines.push(`- Ahead commits: ${ahead.length}`);
    lines.push(`- Missing paths: ${missing.length}`);
    if (analyses.length) {
      lines.push("");
      lines.push(
        "| PR | Identity | Path | Stale | Dirty | Ahead | Recommendation |",
      );
      lines.push("| --- | --- | --- | --- | --- | ---: | --- |");
      for (
        const a of analyses.sort((a, b) =>
          Number(a.prNumber ?? 0) - Number(b.prNumber ?? 0)
        )
      ) {
        lines.push(
          `| ${md(a.prNumber)} | ${md(a.identity ?? "")} | \`${
            md(a.path)
          }\` | ${md(a.isPrHeadStale)} | ${md(a.isDirty)} | ${
            md(a.aheadCommitCount)
          } | ${md(a.recommendedAction)} |`,
        );
      }
    }
    lines.push("");
    return {
      markdown: lines.join("\n"),
      json: {
        modelName: context.definition?.name ?? modelId,
        repo,
        state,
        latestSync,
        syncRuns,
        dataCounts: Object.fromEntries([...dataCounts.entries()].sort()),
        worktrees: {
          registered: analyses.length,
          stale: stale.length,
          dirty: dirty.length,
          ahead: ahead.length,
          missing: missing.length,
        },
      },
    };
  },
};
