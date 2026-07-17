// deno-lint-ignore-file no-explicit-any require-await prefer-const
/**
 * Swamp-backed GitHub project activity ledger.
 *
 * Stores current snapshots and chronological public/private activity events for
 * maintainer reports, PR dossiers, and future project activity analysis.
 *
 * @module
 */
import { z } from "npm:zod@4";
import type { DataHandle } from "jsr:@systeminit/swamp-testing@0.20260518.13";

const IsoDateTime = z.string();
const NullableIsoDateTime = z.string().nullable().optional();

const GlobalArgsSchema = z.object({
  githubToken: z.string().optional().meta({ sensitive: true }).describe(
    "GitHub token with read access to the repository; required by sync_github_* methods",
  ),
  owner: z.string().min(1).optional().describe(
    "Repository owner, e.g. external-secrets; required by sync_github_* methods",
  ),
  repo: z.string().min(1).optional().describe(
    "Repository name, e.g. external-secrets; required by sync_github_* methods",
  ),
  projectName: z.string().optional().describe("Human-readable project name"),
  knownForks: z.array(z.string()).default([]).describe(
    "Known forks as owner/repo; indexed as metadata only",
  ),
  includePrivateEvents: z.boolean().default(true).describe(
    "Whether reports include private/manual/agent events by default",
  ),
  defaultBackfillWindowDays: z.number().int().positive().default(90),
  staleInactivityDays: z.number().int().positive().default(15).describe(
    "Number of days without conversation or code changes before an open PR/issue becomes a stale candidate",
  ),
  personalGithubHandles: z.array(z.string()).default([
    "evrardjp",
    "evrardj-roche",
  ]).describe(
    "GitHub handles that represent the maintainer/operator using this ledger; reports and agent workflows can use them to distinguish your own comments, reviews, and follow-up obligations from external contributor activity",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const RepoSnapshotSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  fullName: z.string(),
  defaultBranch: z.string().optional(),
  description: z.string().nullable().optional(),
  visibility: z.string().optional(),
  fork: z.boolean().optional(),
  archived: z.boolean().optional(),
  openIssuesCount: z.number().optional(),
  stars: z.number().optional(),
  pushedAt: NullableIsoDateTime,
  updatedAt: NullableIsoDateTime,
  syncedAt: IsoDateTime,
}).passthrough();

const ForkSnapshotSchema = z.object({
  fullName: z.string(),
  owner: z.string(),
  repo: z.string(),
  defaultBranch: z.string().optional(),
  createdAt: NullableIsoDateTime,
  updatedAt: NullableIsoDateTime,
  pushedAt: NullableIsoDateTime,
  private: z.boolean().optional(),
  known: z.boolean().default(false),
  reason: z.enum(["configured", "discovered"]),
  syncedAt: IsoDateTime,
}).passthrough();

const IssueSnapshotSchema = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  state: z.string(),
  author: z.string().optional(),
  labels: z.array(z.string()).default([]),
  assignees: z.array(z.string()).default([]),
  milestone: z.string().nullable().optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: NullableIsoDateTime,
  url: z.string().optional(),
  lastConversationAt: NullableIsoDateTime,
  syncedAt: IsoDateTime,
}).passthrough();

const PrSnapshotSchema = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  state: z.string(),
  merged: z.boolean().default(false),
  draft: z.boolean().default(false),
  author: z.string().optional(),
  baseBranch: z.string().optional(),
  headBranch: z.string().optional(),
  headRepo: z.string().optional(),
  headSha: z.string().optional(),
  labels: z.array(z.string()).default([]),
  assignees: z.array(z.string()).default([]),
  requestedReviewers: z.array(z.string()).default([]),
  reviewDecision: z.string().optional(),
  reviewersRequestingChanges: z.array(z.string()).default([]),
  mergeable: z.boolean().nullable().optional(),
  mergeConflict: z.union([z.boolean(), z.literal("unknown")]).default(
    "unknown",
  ),
  conflictFiles: z.array(z.string()).default([]),
  checksState: z.string().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  changedFiles: z.number().optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastCodeChangeAt: NullableIsoDateTime,
  lastConversationAt: NullableIsoDateTime,
  mergedAt: NullableIsoDateTime,
  closedAt: NullableIsoDateTime,
  url: z.string().optional(),
  syncedAt: IsoDateTime,
}).passthrough();

const PrFileSnapshotSchema = z.object({
  repo: z.string(),
  prNumber: z.number(),
  path: z.string(),
  status: z.string(),
  statusShort: z.string(),
  additions: z.number().default(0),
  deletions: z.number().default(0),
  changes: z.number().default(0),
  blobUrl: z.string().optional(),
  rawUrl: z.string().optional(),
  patchArtifact: z.string().optional(),
  merged: z.boolean().optional(),
  prState: z.enum(["open", "closed"]).optional(),
  landedAt: NullableIsoDateTime,
  syncedAt: IsoDateTime,
}).passthrough();

const RepoFileSnapshotSchema = z.object({
  repo: z.string(),
  path: z.string(),
  type: z.string(),
  sha: z.string().optional(),
  size: z.number().optional(),
  defaultBranch: z.string().optional(),
  url: z.string().optional(),
  syncedAt: IsoDateTime,
}).passthrough();

const CiStatusSnapshotSchema = z.object({
  repo: z.string(),
  prNumber: z.number(),
  name: z.string(),
  status: z.string().optional(),
  conclusion: z.string().nullable().optional(),
  url: z.string().optional(),
  detailsUrl: z.string().optional(),
  artifact: z.string().optional(),
  startedAt: NullableIsoDateTime,
  completedAt: NullableIsoDateTime,
  syncedAt: IsoDateTime,
}).passthrough();

const ActivityEventSchema = z.object({
  id: z.string().min(1),
  repo: z.string().min(1),
  subjectType: z.enum(["repo", "issue", "pr", "fork", "project"]),
  subjectNumber: z.number().int().positive().optional(),
  eventType: z.string().min(1),
  source: z.string().min(1),
  visibility: z.enum(["public", "private"]).default("public"),
  actor: z.string().default("unknown"),
  summary: z.string().min(1),
  body: z.string().optional(),
  createdAt: IsoDateTime,
  url: z.string().optional(),
  filePath: z.string().optional(),
  line: z.number().nullable().optional(),
  startLine: z.number().nullable().optional(),
  endLine: z.number().nullable().optional(),
  diffHunk: z.string().optional(),
  state: z.string().optional(),
  label: z.string().optional(),
  artifactRefs: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
}).passthrough();

const ArtifactIndexSchema = z.object({
  name: z.string(),
  contentType: z.string(),
  repo: z.string().optional(),
  subjectType: z.string().optional(),
  subjectNumber: z.number().optional(),
  description: z.string().optional(),
  size: z.number().optional(),
  createdAt: IsoDateTime,
}).passthrough();

const RawGithubApiResponseSchema = z.object({
  scenario: z.string().min(1),
  method: z.string().default("GET"),
  url: z.string().min(1),
  path: z.string().min(1),
  status: z.number().int(),
  ok: z.boolean(),
  requestHeaders: z.record(z.string(), z.string()).default({}),
  responseHeaders: z.record(z.string(), z.string()).default({}),
  body: z.any(),
  bodyBytes: z.number().int().nonnegative(),
  fetchedAt: IsoDateTime,
}).passthrough();

const FetchFromGithubArgsSchema = z.object({
  scenario: z.string().min(1),
  sourceMethod: z.enum([
    "sync_github_backfill",
    "sync_github_prs",
    "sync_github_issues",
    "sync_github_recent_activity",
    "sync_github_repo",
    "sync_github_file_inventory",
    "sync_github_fork_index",
  ]).default("sync_github_backfill"),
  methodArgs: z.record(z.string(), z.any()).default({}),
});

const IngestFetchedDataArgsSchema = z.object({
  scenario: z.string().min(1),
  sourceMethod: FetchFromGithubArgsSchema.shape.sourceMethod.default(
    "sync_github_backfill",
  ),
  methodArgs: z.record(z.string(), z.any()).default({}),
});

const RecordActivityArgsSchema = z.object({
  event: ActivityEventSchema.omit({ id: true, createdAt: true }).partial({
    repo: true,
  }).extend({ id: z.string().optional(), createdAt: IsoDateTime.optional() })
    .passthrough(),
});
const RecordArtifactArgsSchema = z.object({
  name: z.string().min(1),
  contentType: z.string().default("text/plain"),
  content: z.string(),
  repo: z.string().optional(),
  subjectType: z.string().optional(),
  subjectNumber: z.number().int().positive().optional(),
  description: z.string().optional(),
});
const StateEnumSchema = z.enum(["open", "closed", "all"]);
const StateArgSchema = StateEnumSchema.default("open");
const PrDetailOptionsSchema = z.object({
  includePatchArtifacts: z.boolean().default(false),
  includeReviews: z.boolean().default(true),
  includeReviewComments: z.boolean().default(true),
  includeIssueComments: z.boolean().default(true),
  includeChecks: z.boolean().default(true),
  includeTimeline: z.boolean().default(true),
});
const ClassifyStaleCandidatesArgsSchema = z.object({
  includePrs: z.boolean().default(true),
  includeIssues: z.boolean().default(true),
  staleLabel: z.string().min(1).default("Stale"),
  maxCandidates: z.number().int().positive().optional(),
  asOf: IsoDateTime.optional(),
  dryRun: z.boolean().default(false),
});

function requireGithubProject(
  g: GlobalArgs,
): asserts g is GlobalArgs & {
  githubToken: string;
  owner: string;
  repo: string;
} {
  if (!g.githubToken || !g.owner || !g.repo) {
    throw new Error(
      "githubToken, owner, and repo global arguments are required for this method",
    );
  }
}
function repoFullName(g: GlobalArgs): string {
  if (!g.owner || !g.repo) {
    throw new Error(
      "owner and repo global arguments are required for this method",
    );
  }
  return `${g.owner}/${g.repo}`;
}
function nowIso(): string {
  return new Date().toISOString();
}
function safeName(
  prefix: string,
  parts: Array<string | number | undefined | null>,
): string {
  return `${prefix}-${parts.filter((p) => p != null && p !== "").join("-")}`
    .toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(
      0,
      220,
    );
}
async function sha1(input: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function statusShort(status?: string): string {
  return ({
    added: "A",
    modified: "M",
    removed: "D",
    renamed: "R",
    copied: "C",
  } as Record<string, string>)[status ?? ""] ?? "?";
}
function maxIso(values: Array<string | undefined | null>): string | undefined {
  return values.filter(Boolean).sort().at(-1) as string | undefined;
}
function daysBetween(later: Date, earlierIso?: string): number {
  if (!earlierIso) return Number.POSITIVE_INFINITY;
  const earlier = new Date(earlierIso);
  if (Number.isNaN(earlier.getTime())) return Number.POSITIVE_INFINITY;
  return (later.getTime() - earlier.getTime()) / 86400_000;
}
function inactiveDaysSince(later: Date, earlierIso?: string): number {
  const days = daysBetween(later, earlierIso);
  return Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 9999;
}
function labelsOf(x: any): string[] {
  return (x.labels ?? []).map((l: any) => typeof l === "string" ? l : l.name)
    .filter(Boolean);
}
function usersOf(xs: any[] | undefined): string[] {
  return (xs ?? []).map((x) => x?.login).filter(Boolean);
}
function visibility(args: GlobalArgs): "public" | "private" {
  return args.includePrivateEvents ? "private" : "public";
}
function tagsOf(entry: any): Record<string, string> {
  return entry.tags ?? entry.metadata?.tags ?? {};
}

async function gh<T>(
  g: GlobalArgs,
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  requireGithubProject(g);
  const url = new URL(
    path.startsWith("http") ? path : `https://api.github.com${path}`,
  );
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${g.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "swamp-github-project-activity/1.0",
    },
  });
  if (!resp.ok) {
    throw new Error(
      `GitHub API ${resp.status} ${url}: ${(await resp.text()).slice(0, 500)}`,
    );
  }
  return resp.json() as Promise<T>;
}
async function ghPages<T>(
  g: GlobalArgs,
  path: string,
  params: Record<string, string | number | boolean | undefined>,
  limit?: number,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1;; page++) {
    const items = await gh<T[]>(g, path, { ...params, per_page: 100, page });
    out.push(...items);
    if (items.length < 100 || (limit && out.length >= limit)) break;
  }
  return limit ? out.slice(0, limit) : out;
}
async function ghPagesUpdatedSince<T extends { updated_at?: string }>(
  g: GlobalArgs,
  path: string,
  params: Record<string, string | number | boolean | undefined>,
  since: string,
  limit?: number,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1;; page++) {
    const items = await gh<T[]>(g, path, { ...params, per_page: 100, page });
    out.push(...items);
    const oldestOnPage = items.map((item) => item.updated_at).filter(Boolean)
      .sort().at(0);
    if (
      items.length < 100 ||
      (limit && out.length >= limit) ||
      (oldestOnPage && oldestOnPage < since)
    ) break;
  }
  return limit ? out.slice(0, limit) : out;
}

async function readResponseBody(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out = Object.fromEntries([...headers.entries()]);
  for (const key of Object.keys(out)) {
    if (["authorization", "cookie", "set-cookie"].includes(key.toLowerCase())) {
      out[key] = "<redacted>";
    }
  }
  return out;
}

type CapturedGithubResponse = z.infer<typeof RawGithubApiResponseSchema>;

async function runSourceMethodNoWrites(
  sourceMethod: string,
  methodArgs: Record<string, unknown>,
  ctx: WriteContext & {
    definition?: { name?: string };
    globalArgs: GlobalArgs;
  },
): Promise<void> {
  const noopCtx = {
    ...ctx,
    dataRepository: undefined,
    writeResource: async (
      specName: string,
      name: string,
      _data: Record<string, unknown>,
    ) => ({ name, specName, kind: "resource", version: 0 }),
    createFileWriter: (specName: string, name: string) => ({
      writeText: async (_content: string) => ({
        name,
        specName,
        kind: "file",
        version: 0,
      }),
    }),
  };
  const method = (model.methods as Record<
    string,
    {
      execute: (
        args: Record<string, unknown>,
        ctx: unknown,
      ) => Promise<unknown>;
    }
  >)[sourceMethod];
  if (!method) throw new Error(`Unknown sourceMethod: ${sourceMethod}`);
  await method.execute(methodArgs, noopCtx);
}

async function runSourceMethodWithFixtureFetch(
  sourceMethod: string,
  methodArgs: Record<string, unknown>,
  ctx: WriteContext & {
    definition?: { name?: string };
    globalArgs: GlobalArgs;
  },
  byUrl: Map<string, CapturedGithubResponse>,
): Promise<unknown> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    const captured = byUrl.get(url);
    if (!captured) {
      throw new Error(`No fetched GitHub fixture for URL: ${url}`);
    }
    return new Response(JSON.stringify(captured.body), {
      status: captured.status,
      headers: {
        "content-type": captured.responseHeaders["content-type"] ??
          "application/json",
      },
    });
  };
  try {
    const method = (model.methods as Record<
      string,
      {
        execute: (
          args: Record<string, unknown>,
          ctx: unknown,
        ) => Promise<unknown>;
      }
    >)[sourceMethod];
    if (!method) throw new Error(`Unknown sourceMethod: ${sourceMethod}`);
    const replayCtx = {
      ...ctx,
      globalArgs: {
        ...ctx.globalArgs,
        githubToken: ctx.globalArgs.githubToken ?? "fixture-replay",
      },
    };
    return await method.execute(methodArgs, replayCtx);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

type WriteContext = {
  globalArgs: GlobalArgs;
  modelType?: string;
  modelId?: string;
  dataRepository?: any;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: Record<string, unknown>,
  ) => Promise<DataHandle>;
  createFileWriter: (
    specName: string,
    name: string,
    overrides?: Record<string, unknown>,
  ) => { writeText: (content: string) => Promise<DataHandle> };
};

async function writeActivityEvent(
  ctx: WriteContext,
  event: z.infer<typeof ActivityEventSchema>,
): Promise<DataHandle> {
  const parsed = ActivityEventSchema.parse(event);
  return ctx.writeResource(
    "activityEvent",
    safeName("event", [
      parsed.repo,
      parsed.subjectType,
      parsed.subjectNumber,
      parsed.eventType,
      parsed.id,
    ]),
    parsed,
    {
      tags: {
        eventType: parsed.eventType,
        visibility: parsed.visibility,
        source: parsed.source,
      },
    },
  );
}
async function writeArtifact(
  ctx: WriteContext,
  args: z.infer<typeof RecordArtifactArgsSchema>,
): Promise<DataHandle[]> {
  const writer = ctx.createFileWriter("artifact", args.name, {
    contentType: args.contentType,
    tags: { artifact: "true" },
  });
  const file = await writer.writeText(args.content);
  const index = await ctx.writeResource(
    "artifactIndex",
    safeName("artifact-index", [args.name]),
    {
      name: args.name,
      contentType: args.contentType,
      repo: args.repo,
      subjectType: args.subjectType,
      subjectNumber: args.subjectNumber,
      description: args.description,
      size: new TextEncoder().encode(args.content).length,
      createdAt: nowIso(),
    },
  );
  return [file, index];
}
async function upsertRepoSnapshot(
  ctx: WriteContext,
  repo: any,
): Promise<DataHandle> {
  const syncedAt = nowIso();
  return ctx.writeResource("repoSnapshot", "repo-current", {
    owner: repo.owner?.login,
    repo: repo.name,
    fullName: repo.full_name,
    defaultBranch: repo.default_branch,
    description: repo.description,
    visibility: repo.visibility,
    fork: repo.fork,
    archived: repo.archived,
    openIssuesCount: repo.open_issues_count,
    stars: repo.stargazers_count,
    pushedAt: repo.pushed_at,
    updatedAt: repo.updated_at,
    syncedAt,
  });
}
async function upsertForkSnapshot(
  ctx: WriteContext,
  fork: any,
  reason: "configured" | "discovered",
): Promise<DataHandle> {
  const [owner, repo] = String(fork.full_name).split("/");
  return ctx.writeResource("forkSnapshot", safeName("fork", [fork.full_name]), {
    fullName: fork.full_name,
    owner,
    repo,
    defaultBranch: fork.default_branch,
    createdAt: fork.created_at,
    updatedAt: fork.updated_at,
    pushedAt: fork.pushed_at,
    private: fork.private,
    known: true,
    reason,
    syncedAt: nowIso(),
  });
}
async function upsertIssueSnapshot(
  ctx: WriteContext,
  issue: any,
  repo: string,
): Promise<DataHandle> {
  return ctx.writeResource(
    "issueSnapshot",
    safeName("issue", [repo, issue.number, "snapshot"]),
    {
      repo,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      author: issue.user?.login,
      labels: labelsOf(issue),
      assignees: usersOf(issue.assignees),
      milestone: issue.milestone?.title ?? null,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      closedAt: issue.closed_at,
      url: issue.html_url,
      lastConversationAt: issue.updated_at,
      syncedAt: nowIso(),
    },
  );
}
async function upsertPrSnapshot(
  ctx: WriteContext,
  pr: any,
  repo: string,
  checksState?: string,
  reviewersRequestingChanges: string[] = [],
): Promise<DataHandle> {
  return ctx.writeResource(
    "prSnapshot",
    safeName("pr", [repo, pr.number, "snapshot"]),
    {
      repo,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      merged: Boolean(pr.merged_at || pr.merged),
      draft: Boolean(pr.draft),
      author: pr.user?.login,
      baseBranch: pr.base?.ref,
      headBranch: pr.head?.ref,
      headRepo: pr.head?.repo?.full_name,
      headSha: pr.head?.sha,
      labels: labelsOf(pr),
      assignees: usersOf(pr.assignees),
      requestedReviewers: usersOf(pr.requested_reviewers),
      reviewDecision: reviewersRequestingChanges.length
        ? "CHANGES_REQUESTED"
        : undefined,
      reviewersRequestingChanges,
      mergeable: pr.mergeable,
      mergeConflict: pr.mergeable === false
        ? true
        : pr.mergeable === true
        ? false
        : "unknown",
      conflictFiles: [],
      checksState,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      lastCodeChangeAt: pr.head?.repo?.pushed_at ?? pr.updated_at,
      lastConversationAt: pr.updated_at,
      mergedAt: pr.merged_at,
      closedAt: pr.closed_at,
      url: pr.html_url,
      syncedAt: nowIso(),
    },
  );
}
async function upsertRepoFileSnapshot(
  ctx: WriteContext,
  file: any,
  repo: string,
  defaultBranch?: string,
): Promise<DataHandle> {
  return ctx.writeResource(
    "repoFileSnapshot",
    safeName("repo-file", [repo, await sha1(file.path)]),
    {
      repo,
      path: file.path,
      type: file.type,
      sha: file.sha,
      size: file.size,
      defaultBranch,
      url: file.url,
      syncedAt: nowIso(),
    },
  );
}
async function upsertPrFileSnapshot(
  ctx: WriteContext,
  file: any,
  repo: string,
  prNumber: number,
  landedAt: string | null | undefined,
  merged: boolean,
  prState: "open" | "closed",
  includePatch: boolean,
): Promise<DataHandle[]> {
  const handles: DataHandle[] = [];
  let patchArtifact: string | undefined;
  if (includePatch && file.patch) {
    patchArtifact = safeName("artifact-pr-file-patch", [
      repo,
      prNumber,
      await sha1(file.filename),
    ]);
    handles.push(
      ...await writeArtifact(ctx, {
        name: patchArtifact,
        contentType: "text/x-diff",
        content: file.patch,
        repo,
        subjectType: "pr",
        subjectNumber: prNumber,
        description: `Patch for ${file.filename} in PR #${prNumber}`,
      }),
    );
  }
  handles.push(
    await ctx.writeResource(
      "prFileSnapshot",
      safeName("pr-file", [repo, prNumber, await sha1(file.filename)]),
      {
        repo,
        prNumber,
        path: file.filename,
        status: file.status,
        statusShort: statusShort(file.status),
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
        changes: file.changes ?? 0,
        blobUrl: file.blob_url,
        rawUrl: file.raw_url,
        patchArtifact,
        merged,
        prState,
        landedAt,
        syncedAt: nowIso(),
      },
    ),
  );
  return handles;
}

async function markMissingLandedPrFilesNotLanded(
  ctx: WriteContext,
  repo: string,
  prNumber: number,
  currentPaths: Set<string>,
): Promise<DataHandle[]> {
  if (!ctx.dataRepository || !ctx.modelType || !ctx.modelId) return [];

  const entries = await ctx.dataRepository.findAllForModel(
    ctx.modelType,
    ctx.modelId,
  );
  const namePrefix = `${safeName("pr-file", [repo, prNumber])}-`;
  const latest = new Map<string, any>();
  for (
    const entry of entries.filter((e: any) =>
      tagsOf(e).specName === "prFileSnapshot" &&
      typeof e.name === "string" &&
      e.name.startsWith(namePrefix)
    )
  ) {
    const current = latest.get(entry.name);
    if (!current || entry.version > current.version) {
      latest.set(entry.name, entry);
    }
  }

  const handles: DataHandle[] = [];
  for (const entry of latest.values()) {
    const value = await readJson(
      ctx.dataRepository,
      ctx.modelType,
      ctx.modelId,
      entry,
    );
    if (value?.repo !== repo || value?.prNumber !== prNumber) continue;
    if (typeof value.path !== "string" || currentPaths.has(value.path)) {
      continue;
    }
    if (value.landedAt !== undefined) continue;

    handles.push(
      await ctx.writeResource(
        "prFileSnapshot",
        safeName("pr-file", [repo, prNumber, await sha1(value.path)]),
        {
          ...value,
          merged: false,
          prState: "closed",
          landedAt: null,
          syncedAt: nowIso(),
        },
      ),
    );
  }
  return handles;
}
async function upsertCiStatusSnapshot(
  ctx: WriteContext,
  check: any,
  repo: string,
  prNumber: number,
): Promise<DataHandle> {
  return ctx.writeResource(
    "ciStatusSnapshot",
    safeName("ci", [repo, prNumber, check.id ?? check.name]),
    {
      repo,
      prNumber,
      name: check.name ?? check.check_suite?.app?.name ?? "check",
      status: check.status,
      conclusion: check.conclusion,
      url: check.html_url,
      detailsUrl: check.details_url,
      startedAt: check.started_at,
      completedAt: check.completed_at,
      syncedAt: nowIso(),
    },
  );
}
function githubEvent(
  repo: string,
  subjectType: "repo" | "issue" | "pr" | "fork",
  subjectNumber: number | undefined,
  eventType: string,
  id: string | number,
  actor: string | undefined,
  summary: string,
  createdAt: string,
  extra: Partial<z.infer<typeof ActivityEventSchema>> = {},
): z.infer<typeof ActivityEventSchema> {
  return ActivityEventSchema.parse({
    id: String(id),
    repo,
    subjectType,
    subjectNumber,
    eventType,
    source: "github",
    visibility: "public",
    actor: actor ?? "github",
    summary,
    createdAt,
    artifactRefs: [],
    tags: ["github"],
    ...extra,
  });
}
async function syncRepoFileInventory(ctx: WriteContext): Promise<DataHandle[]> {
  const g = ctx.globalArgs;
  const repo = repoFullName(g);
  const repoInfo = await gh<any>(g, `/repos/${g.owner}/${g.repo}`);
  const branch = repoInfo.default_branch ?? "HEAD";
  const tree = await gh<any>(
    g,
    `/repos/${g.owner}/${g.repo}/git/trees/${encodeURIComponent(branch)}`,
    { recursive: 1 },
  );
  const handles: DataHandle[] = [];
  handles.push(await upsertRepoSnapshot(ctx, repoInfo));
  for (const item of tree.tree ?? []) {
    if (item.type !== "blob") continue;
    handles.push(await upsertRepoFileSnapshot(ctx, item, repo, branch));
  }
  handles.push(
    await writeActivityEvent(
      ctx,
      githubEvent(
        repo,
        "repo",
        undefined,
        "repo_file_inventory_synced",
        `repo-file-inventory-${branch}`,
        "github",
        `Indexed ${
          (tree.tree ?? []).filter((item: any) => item.type === "blob").length
        } files from ${branch}`,
        nowIso(),
        { tags: ["github", "inventory", "codebase"] },
      ),
    ),
  );
  return handles;
}
async function syncForkIndex(
  ctx: WriteContext,
  args: { limit?: number; includeConfiguredKnownForks?: boolean },
): Promise<DataHandle[]> {
  const g = ctx.globalArgs;
  const handles: DataHandle[] = [];
  const repo = repoFullName(g);
  const forks = await ghPages<any>(g, `/repos/${g.owner}/${g.repo}/forks`, {
    sort: "newest",
  }, args.limit);
  for (const fork of forks) {
    handles.push(await upsertForkSnapshot(ctx, fork, "discovered"));
    handles.push(
      await writeActivityEvent(
        ctx,
        githubEvent(
          repo,
          "fork",
          undefined,
          "fork_indexed",
          fork.id ?? fork.full_name,
          fork.owner?.login,
          `Indexed fork ${fork.full_name}`,
          fork.created_at ?? nowIso(),
          { url: fork.html_url },
        ),
      ),
    );
  }
  if (args.includeConfiguredKnownForks ?? true) {
    for (const full of g.knownForks) {
      if (forks.some((f) => f.full_name === full)) continue;
      const [owner, repoName] = full.split("/");
      if (!owner || !repoName) continue;
      const fork = await gh<any>(
        { ...g, owner, repo: repoName },
        `/repos/${owner}/${repoName}`,
      );
      handles.push(await upsertForkSnapshot(ctx, fork, "configured"));
    }
  }
  return handles;
}
async function syncIssueComments(
  ctx: WriteContext,
  repo: string,
  number: number,
): Promise<DataHandle[]> {
  const comments = await ghPages<any>(
    ctx.globalArgs,
    `/repos/${ctx.globalArgs.owner}/${ctx.globalArgs.repo}/issues/${number}/comments`,
    {},
    undefined,
  );
  return Promise.all(
    comments.map((c) =>
      writeActivityEvent(
        ctx,
        githubEvent(
          repo,
          "issue",
          number,
          "issue_comment_added",
          c.id,
          c.user?.login,
          `Issue #${number} comment by ${c.user?.login ?? "unknown"}`,
          c.created_at,
          { body: c.body, url: c.html_url, tags: ["github", "comment"] },
        ),
      )
    ),
  );
}
async function syncIssueTimeline(
  ctx: WriteContext,
  repo: string,
  number: number,
  subjectType: "issue" | "pr" = "issue",
): Promise<DataHandle[]> {
  const events = await ghPages<any>(
    ctx.globalArgs,
    `/repos/${ctx.globalArgs.owner}/${ctx.globalArgs.repo}/issues/${number}/timeline`,
    {},
    undefined,
  ).catch(() => []);
  return Promise.all(
    events.filter((e) => e.created_at).map((e) =>
      writeActivityEvent(
        ctx,
        githubEvent(
          repo,
          subjectType,
          number,
          `github_${e.event ?? "timeline_event"}`,
          e.id ?? `${e.event}-${e.created_at}`,
          e.actor?.login,
          `${e.event ?? "timeline event"} on #${number}`,
          e.created_at,
          {
            url: e.html_url,
            label: e.label?.name,
            state: e.state,
            tags: ["github", "timeline"],
          },
        ),
      )
    ),
  );
}
async function syncPrDetails(
  ctx: WriteContext,
  prListItem: any,
  opts: {
    includePatchArtifacts?: boolean;
    includeReviews?: boolean;
    includeReviewComments?: boolean;
    includeIssueComments?: boolean;
    includeChecks?: boolean;
    includeTimeline?: boolean;
  },
): Promise<DataHandle[]> {
  const g = ctx.globalArgs;
  const repo = repoFullName(g);
  const n = prListItem.number;
  const handles: DataHandle[] = [];
  const pr = await gh<any>(g, `/repos/${g.owner}/${g.repo}/pulls/${n}`);
  let reviewersRequestingChanges: string[] = [];
  if (opts.includeReviews) {
    const reviews = await ghPages<any>(
      g,
      `/repos/${g.owner}/${g.repo}/pulls/${n}/reviews`,
      {},
      undefined,
    );
    reviewersRequestingChanges = [
      ...new Set(
        reviews.filter((r) => r.state === "CHANGES_REQUESTED").map((r) =>
          r.user?.login
        ).filter(Boolean),
      ),
    ];
    for (const r of reviews) {
      handles.push(
        await writeActivityEvent(
          ctx,
          githubEvent(
            repo,
            "pr",
            n,
            "review_submitted",
            r.id,
            r.user?.login,
            `${r.state} review on PR #${n}`,
            r.submitted_at ?? pr.updated_at,
            {
              body: r.body,
              url: r.html_url,
              state: r.state,
              tags: ["github", "review"],
            },
          ),
        ),
      );
    }
  }
  let checksState: string | undefined;
  if (opts.includeChecks && pr.head?.sha) {
    const checks = await gh<any>(
      g,
      `/repos/${g.owner}/${g.repo}/commits/${pr.head.sha}/check-runs`,
      { per_page: 100 },
    ).catch(() => ({ check_runs: [] }));
    const runs = checks.check_runs ?? [];
    checksState = runs.some((r: any) =>
        ["failure", "cancelled", "timed_out", "action_required"].includes(
          r.conclusion,
        )
      )
      ? "failure"
      : runs.some((r: any) =>
          r.status !== "completed"
        )
      ? "pending"
      : runs.length
      ? "success"
      : undefined;
    for (const check of runs) {
      handles.push(await upsertCiStatusSnapshot(ctx, check, repo, n));
      handles.push(
        await writeActivityEvent(
          ctx,
          githubEvent(
            repo,
            "pr",
            n,
            "ci_status",
            check.id,
            check.app?.slug ?? "github-actions",
            `${check.name} ${check.status}${
              check.conclusion ? `/${check.conclusion}` : ""
            }`,
            check.completed_at ?? check.started_at ?? pr.updated_at,
            {
              url: check.html_url,
              state: check.conclusion ?? check.status,
              tags: ["github", "ci"],
            },
          ),
        ),
      );
    }
  }
  handles.push(
    await upsertPrSnapshot(
      ctx,
      pr,
      repo,
      checksState,
      reviewersRequestingChanges,
    ),
  );
  handles.push(
    await writeActivityEvent(
      ctx,
      githubEvent(
        repo,
        "pr",
        n,
        pr.merged_at
          ? "pr_merged"
          : pr.closed_at
          ? "pr_closed"
          : "pr_snapshot_synced",
        pr.node_id ?? n,
        pr.user?.login,
        `PR #${n}: ${pr.title}`,
        pr.updated_at,
        { url: pr.html_url },
      ),
    ),
  );
  const files = await ghPages<any>(
    g,
    `/repos/${g.owner}/${g.repo}/pulls/${n}/files`,
    {},
    undefined,
  );
  const currentPaths = new Set<string>();
  const prMerged = Boolean(pr.merged_at);
  const prState = pr.state === "closed" ? "closed" : "open";
  for (const f of files) {
    if (typeof f.filename === "string") currentPaths.add(f.filename);
    handles.push(
      ...await upsertPrFileSnapshot(
        ctx,
        f,
        repo,
        n,
        pr.merged_at ?? undefined,
        prMerged,
        prState,
        Boolean(opts.includePatchArtifacts),
      ),
    );
  }
  if (pr.merged_at) {
    handles.push(
      ...await markMissingLandedPrFilesNotLanded(ctx, repo, n, currentPaths),
    );
  }
  if (opts.includeReviewComments) {
    for (
      const c of await ghPages<any>(
        g,
        `/repos/${g.owner}/${g.repo}/pulls/${n}/comments`,
        {},
        undefined,
      )
    ) {
      handles.push(
        await writeActivityEvent(
          ctx,
          githubEvent(
            repo,
            "pr",
            n,
            "review_comment_added",
            c.id,
            c.user?.login,
            `Review comment on ${c.path}`,
            c.created_at,
            {
              body: c.body,
              url: c.html_url,
              filePath: c.path,
              line: c.line ?? c.original_line,
              startLine: c.start_line,
              endLine: c.line,
              diffHunk: c.diff_hunk,
              tags: ["github", "review", "code-context"],
            },
          ),
        ),
      );
    }
  }
  if (opts.includeIssueComments) {
    for (
      const c of await ghPages<any>(
        g,
        `/repos/${g.owner}/${g.repo}/issues/${n}/comments`,
        {},
        undefined,
      )
    ) {
      handles.push(
        await writeActivityEvent(
          ctx,
          githubEvent(
            repo,
            "pr",
            n,
            "issue_comment_added",
            c.id,
            c.user?.login,
            `PR #${n} conversation comment by ${c.user?.login ?? "unknown"}`,
            c.created_at,
            { body: c.body, url: c.html_url, tags: ["github", "comment"] },
          ),
        ),
      );
    }
  }
  if (opts.includeTimeline) {
    handles.push(...await syncIssueTimeline(ctx, repo, n, "pr"));
  }
  return handles;
}
async function readJson(
  dataRepository: any,
  modelType: string,
  modelId: string,
  entry: any,
): Promise<any | null> {
  const bytes = await dataRepository.getContent(
    modelType,
    modelId,
    entry.name,
    entry.version,
  );
  if (!bytes) return null;
  return JSON.parse(new TextDecoder().decode(bytes));
}

type StaleCandidate = {
  subjectType: "pr" | "issue";
  number: number;
  title: string;
  url?: string;
  labels: string[];
  lastActivityAt: string;
  inactiveDays: number;
};

function hasLabel(labels: string[] | undefined, label: string): boolean {
  const wanted = label.toLowerCase();
  return (labels ?? []).some((l) => l.toLowerCase() === wanted);
}

function staleActivityAt(snapshot: any, subjectType: "pr" | "issue"): string {
  if (subjectType === "pr") {
    return maxIso([
      snapshot.lastConversationAt,
      snapshot.lastCodeChangeAt,
      snapshot.updatedAt,
      snapshot.createdAt,
    ]) ?? snapshot.createdAt;
  }
  return maxIso([
    snapshot.lastConversationAt,
    snapshot.updatedAt,
    snapshot.createdAt,
  ]) ?? snapshot.createdAt;
}

async function latestSnapshotsByNumber(
  ctx: WriteContext,
  entries: any[],
  specName: "prSnapshot" | "issueSnapshot",
): Promise<Map<number, any>> {
  const byNumber = new Map<number, { entry: any; value: any }>();
  for (const entry of entries.filter((e) => tagsOf(e).specName === specName)) {
    const value = await readJson(
      ctx.dataRepository,
      ctx.modelType!,
      ctx.modelId!,
      entry,
    );
    if (!value?.number) continue;
    const existing = byNumber.get(value.number);
    if (!existing || (entry.version ?? 0) > (existing.entry.version ?? 0)) {
      byNumber.set(value.number, { entry, value });
    }
  }
  return new Map([...byNumber].map(([number, item]) => [number, item.value]));
}

async function classifyStaleCandidates(
  ctx: WriteContext,
  args: z.infer<typeof ClassifyStaleCandidatesArgsSchema>,
): Promise<{ dataHandles: DataHandle[]; candidates: StaleCandidate[] }> {
  if (!ctx.dataRepository || !ctx.modelType || !ctx.modelId) {
    throw new Error(
      "dataRepository, modelType, and modelId are required to classify stale candidates",
    );
  }
  const repo = repoFullName(ctx.globalArgs);
  const asOfIso = args.asOf ?? nowIso();
  const asOf = new Date(asOfIso);
  if (Number.isNaN(asOf.getTime())) {
    throw new Error(`Invalid asOf timestamp: ${asOfIso}`);
  }
  const thresholdDays = ctx.globalArgs.staleInactivityDays ?? 15;
  const entries = await ctx.dataRepository.findAllForModel(
    ctx.modelType,
    ctx.modelId,
  );
  const existingClassifications = new Set<string>();
  for (
    const entry of entries.filter((e: any) =>
      tagsOf(e).specName === "activityEvent"
    )
  ) {
    const event = await readJson(
      ctx.dataRepository,
      ctx.modelType,
      ctx.modelId,
      entry,
    );
    if (event?.eventType !== "classification_stale_candidate") continue;
    if (event?.repo !== repo) continue;
    existingClassifications.add(
      `${event.subjectType}:${event.subjectNumber}:${event.state ?? ""}:${
        event.label ?? ""
      }`,
    );
  }

  const candidates: StaleCandidate[] = [];
  const collect = async (
    specName: "prSnapshot" | "issueSnapshot",
    subjectType: "pr" | "issue",
  ) => {
    const snapshots = await latestSnapshotsByNumber(ctx, entries, specName);
    for (const snapshot of snapshots.values()) {
      if (snapshot.repo !== repo || snapshot.state !== "open") continue;
      const labels = labelsOf(snapshot);
      if (hasLabel(labels, args.staleLabel)) continue;
      const lastActivityAt = staleActivityAt(snapshot, subjectType);
      const inactiveDays = inactiveDaysSince(asOf, lastActivityAt);
      if (inactiveDays < thresholdDays) continue;
      candidates.push({
        subjectType,
        number: snapshot.number,
        title: snapshot.title,
        url: snapshot.url,
        labels,
        lastActivityAt,
        inactiveDays,
      });
    }
  };
  if (args.includePrs) await collect("prSnapshot", "pr");
  if (args.includeIssues) await collect("issueSnapshot", "issue");
  candidates.sort((a, b) =>
    a.lastActivityAt.localeCompare(b.lastActivityAt) ||
    a.subjectType.localeCompare(b.subjectType) ||
    a.number - b.number
  );
  const selected = args.maxCandidates
    ? candidates.slice(0, args.maxCandidates)
    : candidates;
  if (args.dryRun) return { dataHandles: [], candidates: selected };

  const handles: DataHandle[] = [];
  for (const candidate of selected) {
    const state = `stale:${candidate.lastActivityAt}:${thresholdDays}`;
    const dedupeKey =
      `${candidate.subjectType}:${candidate.number}:${state}:${args.staleLabel}`;
    if (existingClassifications.has(dedupeKey)) continue;
    handles.push(
      await writeActivityEvent(ctx, {
        id: safeName("stale-candidate", [
          repo,
          candidate.subjectType,
          candidate.number,
          thresholdDays,
          candidate.lastActivityAt,
        ]),
        repo,
        subjectType: candidate.subjectType,
        subjectNumber: candidate.number,
        eventType: "classification_stale_candidate",
        source: "github-project-activity/classify_stale_candidates",
        visibility: visibility(ctx.globalArgs),
        actor: "swamp",
        summary:
          `${candidate.subjectType.toUpperCase()} #${candidate.number} classified as stale candidate (${candidate.inactiveDays}d inactive >= ${thresholdDays}d)`,
        body: JSON.stringify(
          {
            title: candidate.title,
            url: candidate.url,
            staleLabel: args.staleLabel,
            staleInactivityDays: thresholdDays,
            lastActivityAt: candidate.lastActivityAt,
            inactiveDays: candidate.inactiveDays,
            asOf: asOfIso,
          },
          null,
          2,
        ),
        createdAt: asOfIso,
        url: candidate.url,
        state,
        label: args.staleLabel,
        artifactRefs: [],
        tags: ["classification", "stale", "stale-candidate"],
      }),
    );
    existingClassifications.add(dedupeKey);
  }
  return { dataHandles: handles, candidates: selected };
}

async function clearStaleCandidates(
  ctx: WriteContext,
  args: z.infer<typeof ClassifyStaleCandidatesArgsSchema>,
): Promise<{ dataHandles: DataHandle[]; candidates: StaleCandidate[] }> {
  if (!ctx.dataRepository || !ctx.modelType || !ctx.modelId) {
    throw new Error(
      "dataRepository, modelType, and modelId are required to clear stale candidates",
    );
  }
  const repo = repoFullName(ctx.globalArgs);
  const asOfIso = args.asOf ?? nowIso();
  const asOf = new Date(asOfIso);
  if (Number.isNaN(asOf.getTime())) {
    throw new Error(`Invalid asOf timestamp: ${asOfIso}`);
  }
  const thresholdDays = ctx.globalArgs.staleInactivityDays ?? 15;
  const entries = await ctx.dataRepository.findAllForModel(
    ctx.modelType,
    ctx.modelId,
  );
  const priorStale = new Set<string>();
  const existingClears = new Set<string>();
  for (
    const entry of entries.filter((e: any) =>
      tagsOf(e).specName === "activityEvent"
    )
  ) {
    const event = await readJson(
      ctx.dataRepository,
      ctx.modelType,
      ctx.modelId,
      entry,
    );
    if (event?.repo !== repo) continue;
    if (event?.label !== args.staleLabel) continue;
    const key = `${event.subjectType}:${event.subjectNumber}`;
    if (event?.eventType === "classification_stale_candidate") {
      priorStale.add(key);
    }
    if (event?.eventType === "classification_stale_candidate_cleared") {
      existingClears.add(`${key}:${event.state ?? ""}:${event.label ?? ""}`);
    }
  }

  const candidates: StaleCandidate[] = [];
  const collect = async (
    specName: "prSnapshot" | "issueSnapshot",
    subjectType: "pr" | "issue",
  ) => {
    const snapshots = await latestSnapshotsByNumber(ctx, entries, specName);
    for (const snapshot of snapshots.values()) {
      if (snapshot.repo !== repo || snapshot.state !== "open") continue;
      const labels = labelsOf(snapshot);
      const key = `${subjectType}:${snapshot.number}`;
      if (!hasLabel(labels, args.staleLabel) && !priorStale.has(key)) continue;
      const lastActivityAt = staleActivityAt(snapshot, subjectType);
      const inactiveDays = inactiveDaysSince(asOf, lastActivityAt);
      if (inactiveDays >= thresholdDays) continue;
      candidates.push({
        subjectType,
        number: snapshot.number,
        title: snapshot.title,
        url: snapshot.url,
        labels,
        lastActivityAt,
        inactiveDays,
      });
    }
  };
  if (args.includePrs) await collect("prSnapshot", "pr");
  if (args.includeIssues) await collect("issueSnapshot", "issue");
  candidates.sort((a, b) =>
    b.lastActivityAt.localeCompare(a.lastActivityAt) ||
    a.subjectType.localeCompare(b.subjectType) ||
    a.number - b.number
  );
  const selected = args.maxCandidates
    ? candidates.slice(0, args.maxCandidates)
    : candidates;
  if (args.dryRun) return { dataHandles: [], candidates: selected };

  const handles: DataHandle[] = [];
  for (const candidate of selected) {
    const state = `active:${candidate.lastActivityAt}:${thresholdDays}`;
    const key = `${candidate.subjectType}:${candidate.number}`;
    const dedupeKey = `${key}:${state}:${args.staleLabel}`;
    if (existingClears.has(dedupeKey)) continue;
    handles.push(
      await writeActivityEvent(ctx, {
        id: safeName("stale-candidate-cleared", [
          repo,
          candidate.subjectType,
          candidate.number,
          thresholdDays,
          candidate.lastActivityAt,
        ]),
        repo,
        subjectType: candidate.subjectType,
        subjectNumber: candidate.number,
        eventType: "classification_stale_candidate_cleared",
        source: "github-project-activity/clear_stale_candidates",
        visibility: visibility(ctx.globalArgs),
        actor: "swamp",
        summary:
          `${candidate.subjectType.toUpperCase()} #${candidate.number} cleared as stale candidate (${candidate.inactiveDays}d inactive < ${thresholdDays}d)`,
        body: JSON.stringify(
          {
            title: candidate.title,
            url: candidate.url,
            staleLabel: args.staleLabel,
            staleInactivityDays: thresholdDays,
            lastActivityAt: candidate.lastActivityAt,
            inactiveDays: candidate.inactiveDays,
            asOf: asOfIso,
            note:
              "This clears Swamp's stale classification only. Remove the GitHub label with a GitHub-labeling method when that mutation is added.",
          },
          null,
          2,
        ),
        createdAt: asOfIso,
        url: candidate.url,
        state,
        label: args.staleLabel,
        artifactRefs: [],
        tags: ["classification", "stale", "stale-candidate", "cleared"],
      }),
    );
    existingClears.add(dedupeKey);
  }
  return { dataHandles: handles, candidates: selected };
}

/** GitHub maintainer activity database model for repository snapshots, PR dossiers, artifacts, and maintainer notes. */
export const model = {
  type: "@evrardjp/github-project-activity",
  version: "2026.07.06.1",
  globalArguments: GlobalArgsSchema,
  reports: [
    "@evrardjp/github-project-briefing",
    "@evrardjp/github-codebase-heatmap",
    "@evrardjp/pr-review",
  ],
  resources: {
    repoSnapshot: {
      description: "Current repository metadata",
      schema: RepoSnapshotSchema,
      lifetime: "infinite",
      garbageCollection: 1000,
    },
    forkSnapshot: {
      description: "Fork metadata index only; not fork activity ingestion",
      schema: ForkSnapshotSchema,
      lifetime: "infinite",
      garbageCollection: 10000,
    },
    issueSnapshot: {
      description: "Current issue state",
      schema: IssueSnapshotSchema,
      lifetime: "infinite",
      garbageCollection: 10000,
    },
    prSnapshot: {
      description: "Current pull request state",
      schema: PrSnapshotSchema,
      lifetime: "infinite",
      garbageCollection: 10000,
    },
    prFileSnapshot: {
      description: "Current changed-file overview for a PR",
      schema: PrFileSnapshotSchema,
      lifetime: "infinite",
      garbageCollection: 50000,
    },
    repoFileSnapshot: {
      description:
        "Current repository file inventory for codebase heatmap reports",
      schema: RepoFileSnapshotSchema,
      lifetime: "infinite",
      garbageCollection: 100000,
    },
    ciStatusSnapshot: {
      description: "Current CI/check status for a PR",
      schema: CiStatusSnapshotSchema,
      lifetime: "180d",
      garbageCollection: 50000,
    },
    activityEvent: {
      description: "Chronological public/private timeline entry",
      schema: ActivityEventSchema,
      lifetime: "infinite",
      garbageCollection: 100000,
    },
    artifactIndex: {
      description: "Metadata for large file artifacts",
      schema: ArtifactIndexSchema,
      lifetime: "infinite",
      garbageCollection: 100000,
    },
    rawGithubApiResponse: {
      description:
        "Raw/minimally processed GitHub API response captured for fixture replay and ingestion benchmarks",
      schema: RawGithubApiResponseSchema,
      lifetime: "infinite",
      garbageCollection: 100000,
    },
    prReport: {
      description: "Rendered PR dossier markdown and machine-readable source",
      schema: z.object({
        prNumber: z.number(),
        markdown: z.string(),
        generatedAt: z.string(),
      }).passthrough(),
      lifetime: "90d",
      garbageCollection: 50,
    },
  },
  files: {
    artifact: {
      description: "Large timeline/report artifact content",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 100000,
    },
  },
  methods: {
    fetch_from_github: {
      description:
        "Fetch GitHub API data once and store raw/minimally processed responses as Swamp fixtures for later replay",
      arguments: FetchFromGithubArgsSchema,
      execute: async (args: any, ctx: any) => {
        const parsed = FetchFromGithubArgsSchema.parse(args);
        const captured = new Map<string, CapturedGithubResponse>();
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (
          input: string | URL | Request,
          init?: RequestInit,
        ) => {
          const request = input instanceof Request
            ? input
            : new Request(input, init);
          const resp = await originalFetch(request);
          const clone = resp.clone();
          const body = await readResponseBody(clone);
          const url = request.url;
          const path = url.startsWith("https://api.github.com")
            ? url.slice("https://api.github.com".length)
            : new URL(url).pathname + new URL(url).search;
          const encoded = new TextEncoder().encode(JSON.stringify(body));
          captured.set(
            url,
            RawGithubApiResponseSchema.parse({
              scenario: parsed.scenario,
              method: request.method,
              url,
              path,
              status: resp.status,
              ok: resp.ok,
              requestHeaders: headersToRecord(request.headers),
              responseHeaders: headersToRecord(resp.headers),
              body,
              bodyBytes: encoded.byteLength,
              fetchedAt: nowIso(),
            }),
          );
          return resp;
        };
        try {
          await runSourceMethodNoWrites(
            parsed.sourceMethod,
            parsed.methodArgs,
            ctx,
          );
        } finally {
          globalThis.fetch = originalFetch;
        }
        const handles: DataHandle[] = [];
        for (const response of captured.values()) {
          handles.push(
            await ctx.writeResource(
              "rawGithubApiResponse",
              safeName("github-api", [
                parsed.scenario,
                response.method.toLowerCase(),
                await sha1(response.url),
              ]),
              response,
              { tags: { scenario: parsed.scenario, method: response.method } },
            ),
          );
        }
        return {
          dataHandles: handles,
          summary: {
            scenario: parsed.scenario,
            sourceMethod: parsed.sourceMethod,
            responseCount: captured.size,
            totalBodyBytes: [...captured.values()].reduce(
              (sum, r) => sum + r.bodyBytes,
              0,
            ),
          },
        };
      },
    },
    ingest_fetched_data: {
      description:
        "Replay stored GitHub API fixtures and ingest them into the derived project activity resources without calling GitHub",
      arguments: IngestFetchedDataArgsSchema,
      execute: async (args: any, ctx: any) => {
        const parsed = IngestFetchedDataArgsSchema.parse(args);
        if (!ctx.dataRepository || !ctx.modelType || !ctx.modelId) {
          throw new Error(
            "dataRepository, modelType, and modelId are required to ingest fetched data",
          );
        }
        const entries = await ctx.dataRepository.findAllForModel(
          ctx.modelType,
          ctx.modelId,
        );
        const byUrl = new Map<string, CapturedGithubResponse>();
        for (
          const entry of entries.filter((e: any) =>
            tagsOf(e).specName === "rawGithubApiResponse" &&
            (tagsOf(e).scenario === parsed.scenario ||
              tagsOf(e).scenario === undefined)
          )
        ) {
          const value = await readJson(
            ctx.dataRepository,
            ctx.modelType,
            ctx.modelId,
            entry,
          );
          if (value?.scenario === parsed.scenario && value?.url) {
            const existing = byUrl.get(value.url);
            if (!existing || entry.version >= (existing as any).__version) {
              byUrl.set(value.url, { ...value, __version: entry.version });
            }
          }
        }
        if (byUrl.size === 0) {
          throw new Error(
            `No rawGithubApiResponse fixtures found for scenario ${parsed.scenario}`,
          );
        }
        const started = performance.now();
        const result: any = await runSourceMethodWithFixtureFetch(
          parsed.sourceMethod,
          parsed.methodArgs,
          ctx,
          byUrl,
        );
        const durationMs = performance.now() - started;
        return {
          ...result,
          summary: {
            ...(result?.summary ?? {}),
            scenario: parsed.scenario,
            sourceMethod: parsed.sourceMethod,
            fixtureResponses: byUrl.size,
            durationMs,
            dataHandleCount: result?.dataHandles?.length ?? 0,
          },
        };
      },
    },
    sync_github_repo: {
      description:
        "Fetch repository metadata and optionally refresh fork index (for tracking fork repositories that may appear as PR heads without ingesting full fork activity)",
      arguments: z.object({ includeForkIndex: z.boolean().default(false) }),
      execute: async (args: any, ctx: any) => {
        const handles = [
          await upsertRepoSnapshot(
            ctx,
            await gh<any>(
              ctx.globalArgs,
              `/repos/${ctx.globalArgs.owner}/${ctx.globalArgs.repo}`,
            ),
          ),
        ];
        if (args.includeForkIndex) {
          handles.push(
            ...await syncForkIndex(ctx, { includeConfiguredKnownForks: true }),
          );
        }
        return { dataHandles: handles };
      },
    },
    sync_github_file_inventory: {
      description:
        "Fetch current default-branch file inventory for codebase heatmap reports",
      arguments: z.object({}),
      execute: async (_args: any, ctx: any) => ({
        dataHandles: await syncRepoFileInventory(ctx),
      }),
    },
    sync_github_fork_index: {
      description: "Fetch known/discovered forks as metadata only",
      arguments: z.object({
        limit: z.number().int().positive().optional(),
        includeConfiguredKnownForks: z.boolean().default(true),
      }),
      execute: async (args: any, ctx: any) => ({
        dataHandles: await syncForkIndex(ctx, args),
      }),
    },
    sync_github_issues: {
      description: "Fetch issue snapshots and issue-related activity",
      arguments: z.object({
        state: StateArgSchema,
        since: z.string().optional(),
        limit: z.number().int().positive().optional(),
        includeComments: z.boolean().default(false),
        includeTimeline: z.boolean().default(false),
      }),
      execute: async (args: any, ctx: any) => {
        const g = ctx.globalArgs;
        const repo = repoFullName(g);
        const handles: DataHandle[] = [];
        const issues =
          (await ghPages<any>(g, `/repos/${g.owner}/${g.repo}/issues`, {
            state: args.state,
            since: args.since,
          }, args.limit)).filter((i) => !i.pull_request);
        for (const issue of issues) {
          handles.push(await upsertIssueSnapshot(ctx, issue, repo));
          handles.push(
            await writeActivityEvent(
              ctx,
              githubEvent(
                repo,
                "issue",
                issue.number,
                issue.closed_at ? "issue_closed" : "issue_snapshot_synced",
                issue.node_id ?? issue.id,
                issue.user?.login,
                `Issue #${issue.number}: ${issue.title}`,
                issue.updated_at,
                { url: issue.html_url },
              ),
            ),
          );
          if (args.includeComments) {
            handles.push(...await syncIssueComments(ctx, repo, issue.number));
          }
          if (args.includeTimeline) {
            handles.push(...await syncIssueTimeline(ctx, repo, issue.number));
          }
        }
        return { dataHandles: handles };
      },
    },
    sync_github_prs: {
      description:
        "Fetch PR snapshots, files, reviews, comments, timeline, and CI status",
      arguments: PrDetailOptionsSchema.extend({
        state: StateArgSchema,
        since: z.string().optional(),
        limit: z.number().int().positive().optional(),
      }),
      execute: async (args: any, ctx: any) => {
        const g = ctx.globalArgs;
        let prs = await ghPages<any>(g, `/repos/${g.owner}/${g.repo}/pulls`, {
          state: args.state,
          sort: "updated",
          direction: "desc",
        }, args.limit);
        if (args.since) prs = prs.filter((p) => p.updated_at >= args.since);
        const handles: DataHandle[] = [];
        for (const pr of prs) {
          handles.push(...await syncPrDetails(ctx, pr, args));
        }
        return { dataHandles: handles };
      },
    },
    sync_github_pr_by_number: {
      description:
        "Fetch exactly one PR by number, regardless of state, including files, reviews, comments, timeline, and CI status",
      arguments: PrDetailOptionsSchema.extend({
        prNumber: z.number().int().positive(),
      }),
      execute: async (args: any, ctx: any) => {
        const { prNumber, ...detailOptions } = args;
        return {
          dataHandles: await syncPrDetails(
            ctx,
            { number: prNumber },
            detailOptions,
          ),
        };
      },
    },
    sync_github_recent_activity: {
      description: "Fast frequent sync for recently changed open PRs/issues",
      arguments: z.object({
        lookbackMinutes: z.number().int().positive().default(180),
        includeOpenPrs: z.boolean().default(true),
        includeRecentlyUpdatedIssues: z.boolean().default(true),
      }),
      execute: async (args: any, ctx: any) => {
        const since = new Date(Date.now() - args.lookbackMinutes * 60_000)
          .toISOString();
        const handles: DataHandle[] = [];
        if (args.includeOpenPrs) {
          const prs = (await ghPages<any>(
            ctx.globalArgs,
            `/repos/${ctx.globalArgs.owner}/${ctx.globalArgs.repo}/pulls`,
            { state: "open", sort: "updated", direction: "desc" },
            100,
          )).filter((p) => p.updated_at >= since);
          for (const pr of prs) {
            handles.push(
              ...await syncPrDetails(ctx, pr, {
                includeReviews: true,
                includeReviewComments: true,
                includeIssueComments: true,
                includeChecks: true,
                includeTimeline: true,
              }),
            );
          }
        }
        if (args.includeRecentlyUpdatedIssues) {
          const issues = (await ghPages<any>(
            ctx.globalArgs,
            `/repos/${ctx.globalArgs.owner}/${ctx.globalArgs.repo}/issues`,
            { state: "open", since },
            100,
          )).filter((i) => !i.pull_request);
          for (const issue of issues) {
            handles.push(
              await upsertIssueSnapshot(
                ctx,
                issue,
                repoFullName(ctx.globalArgs),
              ),
            );
            handles.push(
              ...await syncIssueComments(
                ctx,
                repoFullName(ctx.globalArgs),
                issue.number,
              ),
            );
          }
        }
        return { dataHandles: handles };
      },
    },
    sync_github_backfill: {
      description: "Slower historical sync/repair over a bounded window",
      arguments: z.object({
        since: z.string().optional(),
        until: z.string().optional(),
        state: StateEnumSchema.default("all"),
        includeClosed: z.boolean().default(true),
        limit: z.number().int().positive().optional(),
        includeForkIndex: z.boolean().default(false),
      }),
      execute: async (args: any, ctx: any) => {
        const g = ctx.globalArgs;
        const since = args.since ??
          new Date(Date.now() - g.defaultBackfillWindowDays * 86400_000)
            .toISOString();
        const until = args.until ?? nowIso();
        const handles: DataHandle[] = [
          await upsertRepoSnapshot(
            ctx,
            await gh<any>(g, `/repos/${g.owner}/${g.repo}`),
          ),
        ];
        if (args.includeForkIndex) {
          handles.push(
            ...await syncForkIndex(ctx, {
              includeConfiguredKnownForks: true,
              limit: args.limit,
            }),
          );
        }
        const prState = args.includeClosed ? args.state : "open";
        let prs = await ghPagesUpdatedSince<any>(
          g,
          `/repos/${g.owner}/${g.repo}/pulls`,
          {
            state: prState,
            sort: "updated",
            direction: "desc",
          },
          since,
          args.limit,
        );
        prs = prs.filter((p) => p.updated_at >= since && p.updated_at <= until);
        for (const pr of prs) {
          handles.push(
            ...await syncPrDetails(ctx, pr, {
              includePatchArtifacts: false,
              includeReviews: true,
              includeReviewComments: true,
              includeIssueComments: true,
              includeChecks: true,
              includeTimeline: true,
            }),
          );
        }
        let issues =
          (await ghPages<any>(g, `/repos/${g.owner}/${g.repo}/issues`, {
            state: prState,
            since,
          }, args.limit)).filter((i) =>
            !i.pull_request && i.updated_at <= until
          );
        for (const issue of issues) {
          handles.push(await upsertIssueSnapshot(ctx, issue, repoFullName(g)));
          handles.push(
            ...await syncIssueTimeline(ctx, repoFullName(g), issue.number),
          );
        }
        return { dataHandles: handles };
      },
    },
    classify_stale_candidates: {
      description:
        "Classify open PRs/issues with no recent activity as stale candidates from stored snapshots",
      arguments: ClassifyStaleCandidatesArgsSchema,
      execute: async (args: any, ctx: any) => {
        const parsed = ClassifyStaleCandidatesArgsSchema.parse(args);
        const result = await classifyStaleCandidates(ctx, parsed);
        return {
          dataHandles: result.dataHandles,
          summary: {
            candidateCount: result.candidates.length,
            classifiedCount: result.dataHandles.length,
            staleInactivityDays: ctx.globalArgs.staleInactivityDays ?? 15,
            dryRun: parsed.dryRun,
          },
          candidates: result.candidates,
        };
      },
    },
    clear_stale_candidates: {
      description:
        "Clear Swamp stale-candidate classifications for PRs/issues that became active again",
      arguments: ClassifyStaleCandidatesArgsSchema,
      execute: async (args: any, ctx: any) => {
        const parsed = ClassifyStaleCandidatesArgsSchema.parse(args);
        const result = await clearStaleCandidates(ctx, parsed);
        return {
          dataHandles: result.dataHandles,
          summary: {
            candidateCount: result.candidates.length,
            clearedCount: result.dataHandles.length,
            staleInactivityDays: ctx.globalArgs.staleInactivityDays ?? 15,
            dryRun: parsed.dryRun,
          },
          candidates: result.candidates,
        };
      },
    },
    record_activity: {
      description:
        "Append one caller-provided public/private activity event for manual notes, agent session outcomes, maintainer decisions, follow-up reminders, and other project context that GitHub APIs do not expose directly",
      arguments: RecordActivityArgsSchema,
      execute: async (args: any, ctx: any) => {
        const raw = args.event;
        const event = ActivityEventSchema.parse({
          ...raw,
          id: raw.id ?? crypto.randomUUID(),
          repo: raw.repo ?? repoFullName(ctx.globalArgs),
          createdAt: raw.createdAt ?? nowIso(),
          visibility: raw.visibility ?? visibility(ctx.globalArgs),
          source: raw.source ?? "manual",
          actor: raw.actor ?? "unknown",
          artifactRefs: raw.artifactRefs ?? [],
          tags: raw.tags ?? [],
        });
        return { dataHandles: [await writeActivityEvent(ctx, event)] };
      },
    },
    record_artifact: {
      description: "Store one caller-provided large artifact",
      arguments: RecordArtifactArgsSchema,
      execute: async (args: any, ctx: any) => ({
        dataHandles: await writeArtifact(ctx, {
          ...args,
          repo: args.repo ?? repoFullName(ctx.globalArgs),
        }),
      }),
    },
    render_pr_report: {
      description:
        "Render a parameterized, durable PR dossier for one pull request. This is a model method rather than only a Swamp report because it needs runtime inputs (prNumber, includePrivate, since/until), writes a durable prReport data object named for that PR, and is an explicit render-this-PR action rather than a passive post-run execution summary.",
      arguments: z.object({
        prNumber: z.number().int().positive(),
        includePrivate: z.boolean().optional(),
        since: z.string().nullable().optional(),
        until: z.string().nullable().optional(),
      }),
      execute: async (args: any, ctx: any) => {
        if (!ctx.dataRepository) {
          throw new Error("dataRepository is required to render reports");
        }
        const includePrivate = args.includePrivate ??
          ctx.globalArgs.includePrivateEvents;
        const entries = await ctx.dataRepository.findAllForModel(
          ctx.modelType,
          ctx.modelId,
        );
        const bySpec = (spec: string) =>
          entries.filter((e: any) => tagsOf(e).specName === spec);
        const latest = async (spec: string, pred: (x: any) => boolean) => {
          let found: any = null;
          for (const e of bySpec(spec)) {
            const v = await readJson(
              ctx.dataRepository,
              ctx.modelType,
              ctx.modelId,
              e,
            );
            if (v && pred(v) && (!found || e.version > found.version)) {
              found = { value: v, version: e.version };
            }
          }
          return found?.value;
        };
        const all = async (spec: string, pred: (x: any) => boolean) => {
          const vals = [];
          for (const e of bySpec(spec)) {
            const v = await readJson(
              ctx.dataRepository,
              ctx.modelType,
              ctx.modelId,
              e,
            );
            if (v && pred(v)) vals.push(v);
          }
          return vals;
        };
        const repo = repoFullName(ctx.globalArgs);
        const pr = await latest(
          "prSnapshot",
          (p) => p.repo === repo && p.number === args.prNumber,
        );
        const files = await all(
          "prFileSnapshot",
          (f) => f.repo === repo && f.prNumber === args.prNumber,
        );
        const checks = await all(
          "ciStatusSnapshot",
          (c) => c.repo === repo && c.prNumber === args.prNumber,
        );
        let events = await all(
          "activityEvent",
          (e) =>
            e.repo === repo && e.subjectType === "pr" &&
            e.subjectNumber === args.prNumber &&
            (includePrivate || e.visibility !== "private"),
        );
        if (args.since) {
          events = events.filter((e) => e.createdAt >= args.since!);
        }
        if (args.until) {
          events = events.filter((e) => e.createdAt <= args.until!);
        }
        events.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const singleLine = (value: unknown, max = 500) => {
          const text = String(value ?? "")
            .replace(/\r?\n/g, " / ")
            .replace(/\s+/g, " ")
            .trim();
          return text.length > max ? `${text.slice(0, max - 1)}…` : text;
        };
        const md = (value: unknown) =>
          String(value ?? "")
            .replace(/\|/g, "\\|")
            .replace(/\r?\n/g, "<br>");
        const artifactLink = (name?: string) =>
          name ? `\`swamp data get ${ctx.definition.name} ${name}\`` : "";
        const formatState = () =>
          pr ? `${pr.state}${pr.merged ? " / merged" : ""}` : "unknown";
        const codeAreas = (() => {
          const roots = new Map<
            string,
            { count: number; additions: number; deletions: number }
          >();
          for (const f of files) {
            const area = String(f.path ?? "").split("/")[0] || "(root)";
            const current = roots.get(area) ??
              { count: 0, additions: 0, deletions: 0 };
            current.count += 1;
            current.additions += f.additions ?? 0;
            current.deletions += f.deletions ?? 0;
            roots.set(area, current);
          }
          return [...roots.entries()]
            .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
            .slice(0, 8);
        })();
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
          (e.tags ?? []).some((tag: string) =>
            ["llm-question", "follow-up-question", "question"].includes(tag)
          )
        );
        const lines: string[] = [];
        lines.push(
          `# PR Review Report: ${repo}#${args.prNumber} — ${
            pr?.title ?? "unknown title"
          }`,
          "",
          "## Labels",
          "",
          (pr?.labels ?? []).length
            ? (pr?.labels ?? []).map((l: string) => `- ${l}`).join("\n")
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
        );
        if (files.length === 0) {
          lines.push("_No changed-file snapshots are stored for this PR._", "");
        } else {
          lines.push(
            "| Area | Files | + | - |",
            "|---|---:|---:|---:|",
          );
          for (const [area, stat] of codeAreas) {
            lines.push(
              `| \`${
                md(area)
              }\` | ${stat.count} | ${stat.additions} | ${stat.deletions} |`,
            );
          }
          lines.push(
            "",
            "### Changed Files",
            "",
            "| Path | Status | + | - | Patch artifact |",
            "|---|---:|---:|---:|---|",
          );
          for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
            lines.push(
              `| \`${md(f.path)}\` | ${
                md(f.statusShort)
              } | ${f.additions} | ${f.deletions} | ${
                artifactLink(f.patchArtifact)
              } |`,
            );
          }
          lines.push("");
        }
        lines.push(
          "## Review Findings",
          "",
          "This section is intentionally data-backed, not a substitute for Pi's human-quality analysis. Use the timeline, changed files, and artifacts below to draft findings in the conversation.",
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
            const artifacts = (e.artifactRefs ?? []).map(artifactLink).join(
              ", ",
            );
            lines.push(
              `- ${singleLine(e.summary ?? e.body ?? "Recorded LLM question")}${
                artifacts ? ` (${artifacts})` : ""
              }`,
            );
          }
        } else {
          lines.push(
            "- Which maintainer decision is needed next (approve, request changes, wait for author/CI, or close)?",
            "- Are any changed areas missing tests or local/e2e validation?",
            "- Do private/manual notes below change the public review stance?",
          );
        }
        lines.push(
          "",
          "## Timeline",
          "",
        );
        const actorWidth = 32;
        const fixedActor = (actor: unknown) => {
          const value = String(actor ?? "unknown");
          return value.length > actorWidth
            ? `${value.slice(0, actorWidth - 1)}…`
            : value.padEnd(actorWidth, " ");
        };
        const detailsFor = (e: any) => {
          const details = [`visibility=${e.visibility}`];
          if (e.filePath) {
            details.push(
              `file=${e.filePath}${e.line ? `:${e.line}` : ""}`,
            );
          }
          if (e.body) details.push(`body="${singleLine(e.body)}"`);
          for (const a of e.artifactRefs ?? []) {
            details.push(`artifact=${artifactLink(a)}`);
          }
          return details.join("; ");
        };
        let day = "";
        let hour = "";
        if (events.length === 0) {
          lines.push("_No activity events are stored for this PR._", "");
        }
        for (const e of events) {
          const d = e.createdAt.slice(0, 10);
          const h = e.createdAt.slice(11, 13);
          if (d !== day) {
            day = d;
            hour = "";
            lines.push(`### ${day}`, "");
          }
          if (h !== hour) {
            hour = h;
            lines.push(`#### ${hour}:00`, "");
          }
          lines.push(
            `${e.createdAt.slice(11, 16)} - ${
              fixedActor(e.actor)
            } - ${e.summary} - ${detailsFor(e)}`,
            "",
          );
        }
        lines.push(
          "## Reference",
          "",
          "### Current State",
          "",
          "| Field | Value |",
          "|---|---|",
        );
        const stateRows = [
          ["PR state", formatState()],
          ["Draft", pr?.draft ? "yes" : "no"],
          ["Author", pr?.author ?? ""],
          ["Base branch", pr?.baseBranch ?? ""],
          ["Head branch", pr?.headBranch ?? ""],
          ["Review decision", pr?.reviewDecision ?? "unknown"],
          [
            "Reviewers requesting changes",
            (pr?.reviewersRequestingChanges ?? []).join(", "),
          ],
          ["Merge conflicts", String(pr?.mergeConflict ?? "unknown")],
          ["Conflict files", (pr?.conflictFiles ?? []).join(", ")],
          ["Labels", (pr?.labels ?? []).join(", ")],
          ["Assignees", (pr?.assignees ?? []).join(", ")],
          ["Requested reviewers", (pr?.requestedReviewers ?? []).join(", ")],
          ["Created", pr?.createdAt ?? ""],
          ["Updated", pr?.updatedAt ?? ""],
          ["Last code change", pr?.lastCodeChangeAt ?? ""],
          ["Last conversation", pr?.lastConversationAt ?? ""],
          ["Synced", pr?.syncedAt ?? ""],
        ];
        for (const [k, v] of stateRows) lines.push(`| ${md(k)} | ${md(v)} |`);
        const markdown = lines.join("\n");
        const handle = await ctx.writeResource(
          "prReport",
          safeName("pr-report", [repo, args.prNumber]),
          {
            prNumber: args.prNumber,
            repo,
            includePrivate,
            since: args.since,
            until: args.until,
            generatedAt: nowIso(),
            markdown,
            eventCount: events.length,
            fileCount: files.length,
            ciStatusCount: checks.length,
            currentState: pr,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
