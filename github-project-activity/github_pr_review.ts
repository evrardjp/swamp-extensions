/**
 * PR review report for @evrardjp/github-project-activity.
 *
 * It prefers a previously rendered `prReport` resource. When the selected PR has
 * no stored `prReport`, it renders an equivalent dossier from the current stored
 * Swamp data and persists it as `prReport` when the report context allows model
 * resource writes.
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
  methodArgs?: Record<string, unknown>;
  methodName?: string;
  dataRepository?: {
    findAllForModel(modelType: unknown, modelId: string): Promise<DataEntry[]>;
    getContent(
      modelType: unknown,
      modelId: string,
      dataName: string,
      version?: number,
    ): Promise<Uint8Array | null>;
  };
  writeResource?: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: Record<string, unknown>,
  ) => Promise<unknown>;
};

type PrSnapshot = {
  repo: string;
  number: number;
  title?: string;
  state?: string;
  merged?: boolean;
  draft?: boolean;
  author?: string;
  baseBranch?: string;
  headBranch?: string;
  labels?: string[];
  assignees?: string[];
  requestedReviewers?: string[];
  reviewDecision?: string;
  reviewersRequestingChanges?: string[];
  mergeConflict?: boolean | "unknown";
  conflictFiles?: string[];
  checksState?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  createdAt?: string;
  updatedAt?: string;
  lastCodeChangeAt?: string | null;
  lastConversationAt?: string | null;
  syncedAt?: string;
};

type PrFileSnapshot = {
  repo: string;
  prNumber: number;
  path: string;
  statusShort?: string;
  additions?: number;
  deletions?: number;
  patchArtifact?: string;
};

type CiStatusSnapshot = {
  repo: string;
  prNumber: number;
  name: string;
  status?: string;
  conclusion?: string | null;
  artifact?: string;
};

type ActivityEvent = {
  repo: string;
  subjectType: string;
  subjectNumber?: number;
  eventType?: string;
  visibility?: "public" | "private";
  actor?: string;
  summary?: string;
  body?: string;
  createdAt: string;
  filePath?: string;
  line?: number | null;
  artifactRefs?: string[];
  tags?: string[];
};

type PrReport = {
  repo: string;
  prNumber: number;
  markdown: string;
  generatedAt?: string;
  currentState?: PrSnapshot;
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

function safeName(
  prefix: string,
  parts: Array<string | number | undefined | null>,
): string {
  return `${prefix}-${parts.filter((p) => p != null && p !== "").join("-")}`
    .toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 220);
}

function repoFullName(
  globalArgs?: Record<string, unknown>,
): string | undefined {
  const owner = String(globalArgs?.owner ?? "").trim();
  const repo = String(globalArgs?.repo ?? "").trim();
  return owner && repo ? `${owner}/${repo}` : undefined;
}

function md(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function singleLine(value: unknown, max = 500): string {
  const text = String(value ?? "")
    .replace(/\r?\n/g, " / ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function readJson<T>(
  context: ReportCtx,
  entry: DataEntry,
): Promise<T | null> {
  const bytes = await context.dataRepository?.getContent(
    context.modelType,
    context.modelId!,
    entry.name,
    entry.version,
  );
  if (!bytes) return null;
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

async function latestBySpec<T>(
  context: ReportCtx,
  entries: DataEntry[],
  specName: string,
  predicate: (value: T) => boolean = () => true,
): Promise<T | null> {
  let latest: { entry: DataEntry; value: T } | null = null;
  for (const entry of entries.filter((e) => tagsOf(e).specName === specName)) {
    const value = await readJson<T>(context, entry);
    if (!value || !predicate(value)) continue;
    if (!latest || entry.version > latest.entry.version) {
      latest = { entry, value };
    }
  }
  return latest?.value ?? null;
}

async function allBySpec<T>(
  context: ReportCtx,
  entries: DataEntry[],
  specName: string,
  predicate: (value: T) => boolean,
): Promise<T[]> {
  const values: T[] = [];
  for (const entry of entries.filter((e) => tagsOf(e).specName === specName)) {
    const value = await readJson<T>(context, entry);
    if (value && predicate(value)) values.push(value);
  }
  return values;
}

async function selectPr(
  context: ReportCtx,
  entries: DataEntry[],
): Promise<{ repo: string; prNumber: number; source: string } | null> {
  const repo = repoFullName(context.globalArgs);
  const argPr = Number(context.methodArgs?.prNumber);
  if (Number.isInteger(argPr) && argPr > 0 && repo) {
    return { repo, prNumber: argPr, source: "methodArgs.prNumber" };
  }

  const latestReport = await latestBySpec<PrReport>(
    context,
    entries,
    "prReport",
    (r) => !!r.repo && Number.isInteger(r.prNumber),
  );
  if (latestReport) {
    return {
      repo: latestReport.repo,
      prNumber: latestReport.prNumber,
      source: "latest prReport",
    };
  }

  const latestPr = await latestBySpec<PrSnapshot>(
    context,
    entries,
    "prSnapshot",
    (p) => !repo || p.repo === repo,
  );
  if (latestPr) {
    return {
      repo: latestPr.repo,
      prNumber: latestPr.number,
      source: "latest prSnapshot",
    };
  }

  return null;
}

function renderMarkdown(
  definitionName: string,
  repo: string,
  prNumber: number,
  pr: PrSnapshot | null,
  files: PrFileSnapshot[],
  checks: CiStatusSnapshot[],
  events: ActivityEvent[],
): string {
  const artifactLink = (name?: string) =>
    name ? `\`swamp data get ${definitionName} ${name}\`` : "";
  const formatState = () =>
    pr ? `${pr.state}${pr.merged ? " / merged" : ""}` : "unknown";
  const failingChecks = checks.filter((c) =>
    c.conclusion &&
    !["success", "neutral", "skipped"].includes(String(c.conclusion))
  );
  const reviewEvents = events.filter((e) =>
    String(e.eventType ?? "").includes("review") ||
    (e.tags ?? []).includes("review")
  );
  const privateEvents = events.filter((e) => e.visibility === "private");
  const questionEvents = events.filter((e) =>
    e.eventType === "pi-llm-questions" ||
    (e.tags ?? []).some((tag) =>
      ["llm-question", "follow-up-question", "question"].includes(tag)
    )
  );
  const lines: string[] = [
    `# PR Review Report: ${repo}#${prNumber} — ${pr?.title ?? "unknown title"}`,
    "",
    "## Labels",
    "",
    (pr?.labels ?? []).length
      ? (pr?.labels ?? []).map((l) => `- ${l}`).join("\n")
      : "- _(none recorded)_",
    "",
    "## Context Summary",
    "",
    `- **State:** ${formatState()}${pr?.draft ? " (draft)" : ""}`,
    `- **Author:** ${pr?.author ?? "unknown"}`,
    `- **Branches:** ${pr?.baseBranch ?? "?"} ← ${pr?.headBranch ?? "?"}`,
    `- **Review decision:** ${pr?.reviewDecision ?? "unknown"}`,
    `- **CI/checks:** ${pr?.checksState ?? "unknown"}${
      failingChecks.length
        ? ` (${failingChecks.length} non-success checks recorded)`
        : ""
    }`,
    `- **Size:** +${pr?.additions ?? 0} / -${pr?.deletions ?? 0}, ${
      pr?.changedFiles ?? files.length
    } changed files`,
    `- **Synced at:** ${pr?.syncedAt ?? "unknown"}`,
    "",
    "## Code Path Walkthrough",
    "",
  ];

  if (files.length === 0) {
    lines.push("_No changed-file snapshots are stored for this PR._", "");
  } else {
    lines.push(
      "| Path | Status | + | - | Patch artifact |",
      "|---|---:|---:|---:|---|",
    );
    for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
      lines.push(
        `| \`${md(f.path)}\` | ${md(f.statusShort)} | ${f.additions ?? 0} | ${
          f.deletions ?? 0
        } | ${artifactLink(f.patchArtifact)} |`,
      );
    }
    lines.push("");
  }

  lines.push(
    "## Review Findings",
    "",
    "This section is data-backed. Use the timeline, changed files, and artifacts below to draft final human review findings.",
    "",
    "| Signal | Value |",
    "|---|---|",
    `| Review comments/events | ${reviewEvents.length} |`,
    `| Private/manual events included | ${privateEvents.length} |`,
    `| Reviewers requesting changes | ${
      md((pr?.reviewersRequestingChanges ?? []).join(", ") || "none")
    } |`,
    `| Merge conflicts | ${md(String(pr?.mergeConflict ?? "unknown"))} |`,
    `| Conflict files | ${
      md((pr?.conflictFiles ?? []).join(", ") || "none")
    } |`,
    "",
    "## Test Plan",
    "",
    "| Job | Status | Conclusion | Artifact |",
    "|---|---|---|---|",
  );
  if (checks.length === 0) {
    lines.push("| _(no CI/check snapshots)_ |  |  |  |");
  } else {
    for (const c of checks) {
      lines.push(
        `| ${md(c.name)} | ${md(c.status ?? "")} | ${
          md(c.conclusion ?? "")
        } | ${artifactLink(c.artifact)} |`,
      );
    }
  }

  lines.push(
    "",
    "## Follow-up Questions",
    "",
  );
  if (questionEvents.length > 0) {
    for (const e of questionEvents) {
      const artifacts = (e.artifactRefs ?? []).map(artifactLink).join(", ");
      lines.push(
        `- ${singleLine(e.summary ?? e.body ?? "Recorded LLM question")}${
          artifacts ? ` (${artifacts})` : ""
        }`,
      );
    }
  } else {
    lines.push(
      "- Are any changed areas missing tests or local/e2e validation?",
      "- Do private/manual notes below change your public review stance?",
    );
  }
  lines.push(
    "",
    "## Timeline",
    "",
  );
  for (
    const e of events.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  ) {
    const details = [`visibility=${e.visibility}`];
    if (e.filePath) {
      details.push(
        `file=${e.filePath}${e.line ? `:${e.line}` : ""}`,
      );
    }
    if (e.body) details.push(`body="${singleLine(e.body)}"`);
    for (const a of e.artifactRefs ?? []) {
      details.push(
        `artifact=${artifactLink(a)}`,
      );
    }
    lines.push(
      `${e.createdAt} - ${e.actor ?? "unknown"} - ${e.summary ?? ""} - ${
        details.join("; ")
      }`,
      "",
    );
  }
  if (events.length === 0) {
    lines.push("_No activity events are stored for this PR._", "");
  }

  return lines.join("\n");
}

/** Model-scope report that renders a structured PR review from stored activity data. */
export const report = {
  name: "@evrardjp/pr-review",
  description:
    "Structured PR review report from github-project-activity PR dossier data",
  scope: "model" as const,
  labels: ["maintainer", "github", "activity", "pr", "review", "pr-dossier"],

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
    const selected = await selectPr(context, entries);
    if (!selected) {
      return {
        markdown:
          "# PR Review Report\n\nNo PR snapshot or PR report data is available yet.",
        json: { error: false, selected: null, status: "missing-pr-data" },
      };
    }

    const existing = await latestBySpec<PrReport>(
      context,
      entries,
      "prReport",
      (r) =>
        r.repo === selected.repo && r.prNumber === selected.prNumber &&
        !!r.markdown,
    );
    if (existing) {
      return {
        markdown: existing.markdown,
        json: {
          repo: selected.repo,
          prNumber: selected.prNumber,
          selectedBy: selected.source,
          source: "existing-prReport",
          generatedAt: existing.generatedAt,
        },
      };
    }

    const [pr, files, checks, events] = await Promise.all([
      latestBySpec<PrSnapshot>(
        context,
        entries,
        "prSnapshot",
        (p) => p.repo === selected.repo && p.number === selected.prNumber,
      ),
      allBySpec<PrFileSnapshot>(
        context,
        entries,
        "prFileSnapshot",
        (f) => f.repo === selected.repo && f.prNumber === selected.prNumber,
      ),
      allBySpec<CiStatusSnapshot>(
        context,
        entries,
        "ciStatusSnapshot",
        (c) => c.repo === selected.repo && c.prNumber === selected.prNumber,
      ),
      allBySpec<ActivityEvent>(
        context,
        entries,
        "activityEvent",
        (e) =>
          e.repo === selected.repo && e.subjectType === "pr" &&
          e.subjectNumber === selected.prNumber &&
          (context.globalArgs?.includePrivateEvents !== false ||
            e.visibility !== "private"),
      ),
    ]);

    const markdown = renderMarkdown(
      context.definition?.name ?? String(context.modelId ?? "model"),
      selected.repo,
      selected.prNumber,
      pr,
      files,
      checks,
      events,
    );
    const generatedAt = new Date().toISOString();
    const reportData: PrReport = {
      repo: selected.repo,
      prNumber: selected.prNumber,
      markdown,
      generatedAt,
      currentState: pr ?? undefined,
    };

    const dataName = safeName("pr-report", [selected.repo, selected.prNumber]);
    if (context.writeResource) {
      await context.writeResource("prReport", dataName, reportData);
    }

    return {
      markdown,
      json: {
        repo: selected.repo,
        prNumber: selected.prNumber,
        selectedBy: selected.source,
        source: "generated-prReport",
        persisted: !!context.writeResource,
        generatedAt,
        dataName,
      },
    };
  },
};
