/**
 * Codebase heatmap report for @evrardjp/github-project-activity.
 *
 * Renders current repository files grouped by recent PR touches, highlighting
 * hot files/directories and cold files that have no recent recorded PR-file
 * activity. Requires repoFileSnapshot data for "untouched" current files and
 * prFileSnapshot/prSnapshot data for touch history.
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

type RepoFileSnapshot = {
  repo: string;
  path: string;
  type: string;
  sha?: string;
  size?: number;
  defaultBranch?: string;
  url?: string;
  syncedAt: string;
};

type PrFileSnapshot = {
  repo: string;
  prNumber: number;
  path: string;
  status?: string;
  statusShort?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  blobUrl?: string;
  rawUrl?: string;
  merged?: boolean;
  prState?: "open" | "closed";
  landedAt?: string | null;
  syncedAt: string;
};

type PrSnapshot = {
  repo: string;
  number: number;
  title?: string;
  state?: string;
  merged?: boolean;
  updatedAt?: string;
  lastCodeChangeAt?: string | null;
  mergedAt?: string | null;
  closedAt?: string | null;
  url?: string;
  syncedAt: string;
};

type HeatmapRow = {
  path: string;
  directory: string;
  current: boolean;
  size?: number;
  touches: number;
  prs: number[];
  additions: number;
  deletions: number;
  changes: number;
  lastTouchedAt?: string;
  daysSinceTouch: number | null;
  bucket: string;
  lastStatus?: string;
  lastPr?: number;
  lastPrUrl?: string;
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

function directoryOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "." : path.slice(0, idx);
}

function topDirectory(path: string): string {
  const [first] = path.split("/");
  return first || ".";
}

function daysSince(iso?: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

function bucketFor(days: number | null): string {
  if (days == null) return "never-recorded";
  if (days <= 7) return "0-7d";
  if (days <= 30) return "8-30d";
  if (days <= 90) return "31-90d";
  if (days <= 180) return "91-180d";
  if (days <= 365) return "181-365d";
  return ">365d";
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

async function loadLatestByName<T>(
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
    const value = await readJson<T>(context, entry);
    if (value) out.push(value);
  }
  return out;
}

function repoFullName(args?: Record<string, unknown>): string | undefined {
  const owner = typeof args?.owner === "string" ? args.owner : undefined;
  const repo = typeof args?.repo === "string" ? args.repo : undefined;
  return owner && repo ? `${owner}/${repo}` : undefined;
}

function prKey(repo: string, number: number): string {
  return `${repo}:${number}`;
}

function isLandedPr(pr: PrSnapshot | undefined): boolean {
  return Boolean(pr?.merged || pr?.mergedAt);
}

function hasRecordedLanding(
  touch: PrFileSnapshot,
): touch is PrFileSnapshot & { landedAt: string } {
  return typeof touch.landedAt === "string" && touch.landedAt.length > 0;
}

function hasLandedTouch(
  touch: PrFileSnapshot,
  pr: PrSnapshot | undefined,
): boolean {
  if (hasRecordedLanding(touch)) return true;
  if (touch.merged === false || touch.landedAt === null) return false;
  if (touch.merged === true) return isLandedPr(pr);
  return false;
}

function touchTimestamp(touch: PrFileSnapshot): string | undefined {
  if (hasRecordedLanding(touch)) return touch.landedAt;
  return undefined;
}

function buildRows(
  repo: string | undefined,
  files: RepoFileSnapshot[],
  prFiles: PrFileSnapshot[],
  prs: PrSnapshot[],
): HeatmapRow[] {
  const prByRepoAndNumber = new Map(
    prs.map((pr) => [prKey(pr.repo, pr.number), pr]),
  );
  const currentByPath = new Map(
    files.filter((f) => !repo || f.repo === repo).map((f) => [f.path, f]),
  );
  const touchesByPath = new Map<string, PrFileSnapshot[]>();
  for (const f of prFiles.filter((f) => !repo || f.repo === repo)) {
    const pr = prByRepoAndNumber.get(prKey(f.repo, f.prNumber));
    if (!hasLandedTouch(f, pr)) continue;
    const list = touchesByPath.get(f.path) ?? [];
    list.push(f);
    touchesByPath.set(f.path, list);
  }

  const paths = new Set([...currentByPath.keys(), ...touchesByPath.keys()]);
  const rows: HeatmapRow[] = [];
  for (const path of paths) {
    const current = currentByPath.get(path);
    const touches = touchesByPath.get(path) ?? [];
    const prsForPath = [...new Set(touches.map((t) => t.prNumber))].sort((
      a,
      b,
    ) => b - a);
    let lastTouchedAt: string | undefined;
    let lastTouch: PrFileSnapshot | undefined;
    for (const touch of touches) {
      const touchAt = touchTimestamp(touch);
      if (!lastTouchedAt || (touchAt && touchAt > lastTouchedAt)) {
        lastTouchedAt = touchAt;
        lastTouch = touch;
      }
    }
    const age = daysSince(lastTouchedAt);
    const lastPr = lastTouch
      ? prByRepoAndNumber.get(prKey(lastTouch.repo, lastTouch.prNumber))
      : undefined;
    rows.push({
      path,
      directory: directoryOf(path),
      current: Boolean(current),
      size: current?.size,
      touches: touches.length,
      prs: prsForPath,
      additions: touches.reduce((sum, f) => sum + (f.additions ?? 0), 0),
      deletions: touches.reduce((sum, f) => sum + (f.deletions ?? 0), 0),
      changes: touches.reduce((sum, f) => sum + (f.changes ?? 0), 0),
      lastTouchedAt,
      daysSinceTouch: age,
      bucket: bucketFor(age),
      lastStatus: lastTouch?.statusShort ?? lastTouch?.status,
      lastPr: lastTouch?.prNumber,
      lastPrUrl: lastPr?.url,
    });
  }
  return rows;
}

/** Model-scope report that renders a current-codebase heatmap from repo files and PR-file history. */
export const report = {
  name: "@evrardjp/github-codebase-heatmap",
  description:
    "Heatmap of current repository files by recent GitHub PR-file activity",
  scope: "model" as const,
  labels: ["maintainer", "github", "activity", "codebase", "heatmap"],

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
    const repo = repoFullName(context.globalArgs);
    const files = await loadLatestByName<RepoFileSnapshot>(
      context,
      entries,
      "repoFileSnapshot",
    );
    const prFiles = await loadLatestByName<PrFileSnapshot>(
      context,
      entries,
      "prFileSnapshot",
    );
    const prs = await loadLatestByName<PrSnapshot>(
      context,
      entries,
      "prSnapshot",
    );
    const prFilesForRepo = prFiles.filter((f) => !repo || f.repo === repo);
    const prByRepoAndNumber = new Map(
      prs.map((pr) => [prKey(pr.repo, pr.number), pr]),
    );
    const landedPrFiles = prFilesForRepo.filter((f) =>
      hasLandedTouch(f, prByRepoAndNumber.get(prKey(f.repo, f.prNumber)))
    );
    const rows = buildRows(repo, files, prFilesForRepo, prs);

    const currentRows = rows.filter((r) => r.current);
    const byBucket = new Map<string, number>();
    for (const r of currentRows) {
      byBucket.set(r.bucket, (byBucket.get(r.bucket) ?? 0) + 1);
    }

    const dirs = new Map<
      string,
      {
        files: number;
        touched: number;
        changes: number;
        recent: number;
        cold: number;
      }
    >();
    for (const r of currentRows) {
      const dir = topDirectory(r.path);
      const agg = dirs.get(dir) ??
        { files: 0, touched: 0, changes: 0, recent: 0, cold: 0 };
      agg.files++;
      if (r.touches) agg.touched++;
      agg.changes += r.changes;
      if (r.daysSinceTouch != null && r.daysSinceTouch <= 30) agg.recent++;
      if (r.daysSinceTouch == null || r.daysSinceTouch > 365) agg.cold++;
      dirs.set(dir, agg);
    }
    const directoryRows = [...dirs.entries()].map(([dir, agg]) => ({
      dir,
      ...agg,
    }))
      .sort((a, b) =>
        b.recent - a.recent || b.changes - a.changes ||
        a.dir.localeCompare(b.dir)
      );

    const hot = currentRows.filter((r) => r.touches > 0)
      .sort((a, b) =>
        (a.daysSinceTouch ?? 99999) - (b.daysSinceTouch ?? 99999) ||
        b.touches - a.touches ||
        b.changes - a.changes ||
        a.path.localeCompare(b.path)
      ).slice(0, 50);
    const cold = currentRows
      .sort((a, b) =>
        (b.daysSinceTouch ?? 99999) - (a.daysSinceTouch ?? 99999) ||
        a.path.localeCompare(b.path)
      ).slice(0, 50);
    const changedNotCurrent = rows.filter((r) => !r.current)
      .sort((a, b) => (a.daysSinceTouch ?? 99999) - (b.daysSinceTouch ?? 99999))
      .slice(0, 50);

    const modelName = context.definition?.name ?? context.modelId ??
      "github-project-activity";
    const bucketOrder = [
      "0-7d",
      "8-30d",
      "31-90d",
      "91-180d",
      "181-365d",
      ">365d",
      "never-recorded",
    ];
    const lines = [
      `# Codebase Heatmap — ${modelName}`,
      "",
      `Current files: **${currentRows.length}** · Files with recorded landed PR touches: **${
        currentRows.filter((r) => r.touches > 0).length
      }** · Landed PR-file snapshots: **${landedPrFiles.length}** / ${prFilesForRepo.length} · PR snapshots: **${prs.length}**`,
      "",
      files.length === 0
        ? "> No repoFileSnapshot data found, so untouched current files cannot be computed yet. Run `sync_github_file_inventory` first."
        : `Heatmap is based on the latest current file inventory plus stored PR changed-file snapshots. Backfill more history with \`sync_github_backfill\` to reduce false-cold files.`,
      "",
      "## Current file age buckets",
      ...renderTable(
        ["Bucket", "Files"],
        bucketOrder.map((
          bucket,
        ) => [bucket, String(byBucket.get(bucket) ?? 0)]),
      ),
      "",
      "## Top-level directory heat",
      ...renderTable(
        [
          "Directory",
          "Files",
          "Touched",
          "Recent ≤30d",
          "Cold >365d/never",
          "Recorded changes",
        ],
        directoryRows.map((
          d,
        ) => [
          esc(d.dir),
          String(d.files),
          String(d.touched),
          String(d.recent),
          String(d.cold),
          String(d.changes),
        ]),
      ),
      "",
      "## Hottest current files",
      ...renderTable(
        ["Path", "Age", "Last touch", "PRs", "Changes", "+", "-", "Last PR"],
        hot.map((r) => [
          `\`${esc(r.path)}\``,
          r.daysSinceTouch == null ? "never" : `${r.daysSinceTouch}d`,
          esc(r.lastTouchedAt ?? ""),
          esc(r.prs.slice(0, 5).map((n) => `#${n}`).join(", ")),
          String(r.changes),
          String(r.additions),
          String(r.deletions),
          r.lastPrUrl
            ? `[${esc(`#${r.lastPr}`)}](${esc(r.lastPrUrl)})`
            : esc(r.lastPr ?? ""),
        ]),
      ),
      "",
      "## Coldest current files",
      ...renderTable(
        ["Path", "Age", "Last touch", "Touches", "Changes"],
        cold.map((r) => [
          `\`${esc(r.path)}\``,
          r.daysSinceTouch == null ? "never" : `${r.daysSinceTouch}d`,
          esc(r.lastTouchedAt ?? ""),
          String(r.touches),
          String(r.changes),
        ]),
      ),
      "",
      "## Changed historically but not in current inventory",
      ...renderTable(
        ["Path", "Age", "Last touch", "Last status", "Touches", "Changes"],
        changedNotCurrent.map((r) => [
          `\`${esc(r.path)}\``,
          r.daysSinceTouch == null ? "never" : `${r.daysSinceTouch}d`,
          esc(r.lastTouchedAt ?? ""),
          esc(r.lastStatus ?? ""),
          String(r.touches),
          String(r.changes),
        ]),
      ),
    ];

    return {
      markdown: `${lines.join("\n")}\n`,
      json: {
        generatedAt: new Date().toISOString(),
        repo,
        counts: {
          currentFiles: currentRows.length,
          currentFilesWithTouches:
            currentRows.filter((r) => r.touches > 0).length,
          currentFilesWithLandedTouches:
            currentRows.filter((r) => r.touches > 0).length,
          repoFileSnapshots: files.length,
          prFileSnapshots: prFilesForRepo.length,
          landedPrFileSnapshots: landedPrFiles.length,
          prSnapshots: prs.length,
          changedNotCurrent: rows.filter((r) => !r.current).length,
        },
        buckets: Object.fromEntries(
          bucketOrder.map((bucket) => [bucket, byBucket.get(bucket) ?? 0]),
        ),
        directories: directoryRows,
        hottestFiles: hot,
        coldestFiles: cold,
        changedNotCurrent,
      },
    };
  },
};
