import { z } from "npm:zod@4";

const IsoDateTime = z.string().datetime({ offset: true });

const GlobalArgsSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  githubToken: z.string().min(1).optional().meta({ sensitive: true }),
  gitObjectPath: z.string().min(1).describe(
    "Path to the managed bare git object repository used by the mirror",
  ),
  workspaceRoot: z.string().min(1).describe(
    "Directory where prepare_worktree creates editable worktrees",
  ),
  artifactRoot: z.string().min(1).describe(
    "Directory where sync stores durable mirror artifacts and cursors",
  ),
  gitRemote: z.string().min(1).default("origin"),
  gitRemoteUrl: z.string().min(1).optional(),
  sshRemoteBase: z.string().min(1).default("git@github.com:"),
  syncOverlapMinutes: z.number().int().nonnegative().default(5),
  firstSyncSince: z.string().optional(),
  knownRemotes: z.record(z.string(), z.string()).default({}),
  timelineCodeGranularity: z.enum(["observed-push", "commit"]).default(
    "observed-push",
  ),
  needsClarificationLabels: z.array(z.string()).default([
    "needs-info",
    "needs-information",
    "needs-clarification",
  ]),
  maxApiPages: z.number().int().positive().max(1000).default(100),
});

type GlobalArgs = z.input<typeof GlobalArgsSchema>;
type ParsedGlobalArgs = z.output<typeof GlobalArgsSchema>;
type WriteResource = (
  specName: string,
  name: string,
  data: Record<string, unknown>,
  overrides?: Record<string, unknown>,
) => Promise<unknown>;
type Context = {
  globalArgs: GlobalArgs;
  definition?: { name?: string };
  writeResource: WriteResource;
};

type RunResult = { code: number; stdout: string; stderr: string };

type GhUser = { login?: string };
type GhRepoRef = {
  name?: string;
  full_name?: string;
  clone_url?: string;
  ssh_url?: string;
  owner?: GhUser;
};
type GhBranchRef = {
  ref?: string;
  sha?: string;
  repo?: GhRepoRef;
};
type GhRepo = {
  default_branch?: string;
  private?: boolean;
  archived?: boolean;
  pushed_at?: string;
  updated_at?: string;
};
type GhIssue = {
  number: number;
  title?: string;
  state?: string;
  user?: GhUser;
  labels?: Array<{ name?: string } | string>;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  html_url?: string;
  body?: string | null;
  pull_request?: unknown;
};
type GhPr = GhIssue & {
  draft?: boolean;
  merged_at?: string | null;
  maintainer_can_modify?: boolean;
  base?: GhBranchRef;
  head?: GhBranchRef;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  requested_reviewers?: GhUser[];
  mergeable?: boolean | null;
  mergeable_state?: string;
};
type GhComment = {
  id?: string | number;
  user?: GhUser;
  body?: string;
  html_url?: string;
  created_at?: string;
  path?: string;
  line?: number | null;
  side?: string | null;
  commit_id?: string;
};
type GhTimelineEvent = {
  id?: string | number;
  event?: string;
  actor?: GhUser;
  html_url?: string;
  state?: string;
  created_at?: string;
  [key: string]: unknown;
};
type GhReview = GhComment & {
  state?: string;
  submitted_at?: string;
};
type GhFile = {
  filename: string;
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  sha?: string;
  raw_url?: string;
  patch?: string;
};
type GhCheckRun = {
  id?: string | number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  started_at?: string | null;
  completed_at?: string | null;
};
type GhCheckRuns = { check_runs?: GhCheckRun[] };
type GhCommit = {
  sha: string;
  parents?: Array<{ sha?: string }>;
  commit?: {
    message?: string;
    author?: { name?: string; email?: string; date?: string | null };
    committer?: { date?: string | null };
  };
  html_url?: string;
};

const ChangedFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  status: z.string(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
}).passthrough();

type ChangedFile = z.infer<typeof ChangedFileSchema>;

type PrRecord = {
  number: number;
  title?: string;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  author?: string;
  baseRef?: string;
  baseSha?: string;
  headOwner?: string;
  headRepo?: string;
  headFullName?: string;
  headRef?: string;
  headSha?: string;
  maintainerCanModify?: boolean;
  headSshUrl?: string;
  headHttpsUrl?: string;
  remoteName?: string;
  updatedAt?: string;
  observedAt: string;
  body?: string;
  url?: string;
};

type WorktreeRecord = {
  id: string;
  repo: string;
  prNumber: number;
  identity?: string;
  path: string;
  branch: string;
  baseHeadSha: string;
  createdAt: string;
  status: "active" | "missing" | "removed";
  removedAt?: string;
};

const MirrorStateSchema = z.object({
  repo: z.string(),
  cursor: z.object({
    lastSuccessfulSyncAt: IsoDateTime.optional(),
    lastPrUpdatedAt: z.string().optional(),
    lastIssueUpdatedAt: z.string().optional(),
  }).default({}),
  syncInProgress: z.boolean().default(false),
  updatedAt: IsoDateTime,
}).passthrough();

const RepoSnapshotSchema = z.object({
  repo: z.string(),
  owner: z.string(),
  name: z.string(),
  defaultBranch: z.string().optional(),
  private: z.boolean().optional(),
  archived: z.boolean().optional(),
  pushedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  syncedAt: IsoDateTime,
}).passthrough();

const PrSnapshotSchema = z.object({
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string().optional(),
  state: z.string().optional(),
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  author: z.string().optional(),
  body: z.string().optional(),
  url: z.string().optional(),
  labels: z.array(z.string()).default([]),
  requestedReviewers: z.array(z.string()).default([]),
  reviewDecision: z.string().optional(),
  mergeable: z.boolean().nullable().optional(),
  mergeableState: z.string().optional(),
  baseRef: z.string().optional(),
  baseSha: z.string().optional(),
  headOwner: z.string().optional(),
  headRepo: z.string().optional(),
  headFullName: z.string().optional(),
  headRef: z.string().optional(),
  headSha: z.string().optional(),
  maintainerCanModify: z.boolean().optional(),
  remoteName: z.string().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  changedFiles: z.number().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  closedAt: z.string().nullable().optional(),
  mergedAt: z.string().nullable().optional(),
  syncedAt: IsoDateTime,
}).passthrough();

const PrRevisionSchema = z.object({
  repo: z.string(),
  prNumber: z.number().int().positive(),
  baseSha: z.string().optional(),
  headSha: z.string().min(1),
  previousHeadSha: z.string().optional(),
  patchHeadShort: z.string(),
  observedAt: IsoDateTime,
  gitObjectPath: z.string(),
  patchPath: z.string().optional(),
  filesPath: z.string().optional(),
  changedFiles: z.array(ChangedFileSchema).default([]),
}).passthrough();

const PrHeadStateSchema = z.object({
  repo: z.string(),
  prNumber: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40,64}$/i),
  fetchedAt: IsoDateTime,
}).passthrough();

const PrFileSnapshotSchema = z.object({
  repo: z.string(),
  prNumber: z.number().int().positive(),
  headSha: z.string().optional(),
  path: z.string(),
  previousFilename: z.string().optional(),
  status: z.string().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  changes: z.number().optional(),
  blobSha: z.string().optional(),
  rawUrl: z.string().optional(),
  patchPath: z.string().optional(),
  syncedAt: IsoDateTime,
}).passthrough();

const IssueSnapshotSchema = z.object({
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string().optional(),
  state: z.string().optional(),
  author: z.string().optional(),
  body: z.string().optional(),
  url: z.string().optional(),
  labels: z.array(z.string()).default([]),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  closedAt: z.string().nullable().optional(),
  syncedAt: IsoDateTime,
}).passthrough();

const ActivityEventSchema = z.object({
  repo: z.string(),
  subjectType: z.enum(["issue", "pr", "repo"]),
  subjectNumber: z.number().int().positive().optional(),
  eventType: z.string(),
  githubId: z.string().optional(),
  actor: z.string().optional(),
  summary: z.string(),
  body: z.string().optional(),
  url: z.string().optional(),
  filePath: z.string().optional(),
  line: z.number().int().optional(),
  side: z.string().optional(),
  commitSha: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  state: z.string().optional(),
  createdAt: z.string(),
  syncedAt: IsoDateTime,
}).passthrough();

const SubjectReferenceSchema = z.object({
  repo: z.string(),
  sourceType: z.enum(["issue", "pr"]),
  sourceNumber: z.number().int().positive(),
  targetRepo: z.string(),
  targetType: z.enum(["issue", "pr", "unknown"]),
  targetNumber: z.number().int().positive(),
  url: z.string().optional(),
  relationship: z.enum(["closing", "cross-reference", "text"]),
  external: z.boolean(),
  createdAt: z.string().optional(),
  syncedAt: IsoDateTime,
}).passthrough();

const PrCommitSchema = z.object({
  repo: z.string(),
  prNumber: z.number().int().positive(),
  headSha: z.string().optional(),
  sha: z.string().min(1),
  parentShas: z.array(z.string()),
  message: z.string().optional(),
  authorName: z.string().optional(),
  authorEmail: z.string().optional(),
  authoredAt: z.string().nullable().optional(),
  committedAt: z.string().nullable().optional(),
  url: z.string().optional(),
  changedFiles: z.array(ChangedFileSchema).default([]),
  syncedAt: IsoDateTime,
}).passthrough();

const ReviewSelectionSchema = z.object({
  repo: z.string(),
  subjectType: z.enum(["issue", "pr"]),
  subjectNumber: z.number().int().positive(),
  headSha: z.string().optional(),
  selectedAt: IsoDateTime,
}).passthrough();

const CollectionStatusSchema = z.object({
  repo: z.string(),
  subjectType: z.enum(["issue", "pr", "repo"]).optional(),
  subjectNumber: z.number().int().positive().optional(),
  component: z.enum([
    "prSnapshot",
    "checkRunSnapshot",
    "activityEvent",
    "prCommit",
  ]),
  complete: z.boolean(),
  error: z.string().optional(),
  itemCount: z.number().int().nonnegative(),
  syncedAt: IsoDateTime,
}).passthrough();

const PrAnalysisEvidenceSchema = z.object({
  repo: z.string(),
  prNumber: z.number().int().positive(),
  baseSha: z.string().optional(),
  headSha: z.string().min(1),
  generatedAt: IsoDateTime,
  generator: z.string().min(1),
  sections: z.object({
    codePathWalkthrough: z.string().min(1),
    reviewAttentionMap: z.string().min(1),
  }),
  evidenceRefs: z.array(z.string()),
}).passthrough();

const CheckRunSchema = z.object({
  repo: z.string(),
  prNumber: z.number().int().positive(),
  headSha: z.string(),
  name: z.string(),
  status: z.string().optional(),
  conclusion: z.string().nullable().optional(),
  url: z.string().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  syncedAt: IsoDateTime,
}).passthrough();

const WorktreeSnapshotSchema = z.object({
  id: z.string(),
  repo: z.string(),
  prNumber: z.number().int().positive(),
  identity: z.string().optional(),
  path: z.string(),
  branch: z.string(),
  baseHeadSha: z.string(),
  createdAt: IsoDateTime,
  status: z.string(),
  removedAt: IsoDateTime.optional(),
}).passthrough();

const WorktreeAnalysisSchema = z.object({
  worktreeId: z.string(),
  repo: z.string(),
  prNumber: z.number().int().positive(),
  identity: z.string().optional(),
  path: z.string(),
  branch: z.string(),
  baseHeadSha: z.string(),
  latestMirrorHeadSha: z.string().optional(),
  isPrHeadStale: z.boolean(),
  isDirty: z.boolean(),
  aheadCommitCount: z.number().int().nonnegative(),
  missing: z.boolean(),
  analysisComplete: z.boolean().default(true),
  errors: z.array(z.string()).default([]),
  recommendedAction: z.string(),
  analyzedAt: IsoDateTime,
}).passthrough();

const WorktreeCleanupRunSchema = z.object({
  repo: z.string(),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime,
  activeCount: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative(),
  removedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  complete: z.boolean(),
  results: z.array(z.object({
    worktreeId: z.string(),
    prNumber: z.number().int().positive(),
    path: z.string(),
    branch: z.string(),
    outcome: z.enum(["removed", "failed", "skipped"]),
    reason: z.string().optional(),
    error: z.string().optional(),
    branchRetained: z.boolean(),
    stateRecorded: z.boolean(),
  })),
}).passthrough();

const SyncRunSummarySchema = z.object({
  repo: z.string(),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime,
  prCount: z.number().int().nonnegative(),
  issueCount: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  checkRunCount: z.number().int().nonnegative(),
  gitFetched: z.boolean(),
  githubStartedAt: IsoDateTime.optional(),
  githubFinishedAt: IsoDateTime.optional(),
  gitFetchStartedAt: IsoDateTime.optional(),
  gitFetchFinishedAt: IsoDateTime.optional(),
  errors: z.array(z.object({
    component: z.string(),
    subjectType: z.string().optional(),
    subjectNumber: z.number().int().positive().optional(),
    error: z.string(),
  })).default([]),
  complete: z.boolean().nullable().default(null),
  cursorPrUpdatedAt: z.string().optional(),
  cursorIssueUpdatedAt: z.string().optional(),
}).passthrough();

const MirrorStatusSchema = z.object({
  repo: z.string(),
  modelName: z.string(),
  state: MirrorStateSchema,
  worktreeCount: z.number().int().nonnegative(),
  artifactRoot: z.string(),
  workspaceRoot: z.string(),
  gitObjectPath: z.string(),
  generatedAt: IsoDateTime,
}).passthrough();

function repoFullName(g: GlobalArgs): string {
  return `${g.owner}/${g.repo}`;
}

function modelName(ctx: Context): string {
  return ctx.definition?.name ??
    `${ctx.globalArgs.owner}-${ctx.globalArgs.repo}-mirror`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeName(
  prefix: string,
  parts: Array<string | number | undefined | null>,
): string {
  return `${prefix}-${parts.filter((p) => p != null && p !== "").join("-")}`
    .toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 220);
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

async function hashPrefix(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes).slice(0, 10))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function remoteNameForOwner(owner: string): string {
  return safeName("fork", [owner]);
}

function isManagedWorktreeBranch(branch: string): boolean {
  return /^review\/pr-\d+-patchhead-[0-9a-f]{12}(?:-.+)?$/i.test(branch);
}

function refsConflict(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`);
}

function githubApiHeaders(g: GlobalArgs): HeadersInit {
  const headers: Record<string, string> = {
    "accept": "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "swamp-github-local-mirror",
  };
  if (g.githubToken) headers.authorization = `Bearer ${g.githubToken}`;
  return headers;
}

function deadlineSignal(deadlineMs?: number): AbortSignal | undefined {
  if (!deadlineMs) return undefined;
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    return AbortSignal.abort(new Error("sync budget exhausted"));
  }
  return AbortSignal.timeout(remaining);
}

async function gh<T>(
  g: GlobalArgs,
  path: string,
  deadlineMs?: number,
): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: githubApiHeaders(g),
    signal: deadlineSignal(deadlineMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub ${res.status} for ${path}: ${body.slice(0, 500)}`);
  }
  return await res.json() as T;
}

function parseNext(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const [urlPart, relPart] = part.split(";").map((s) => s.trim());
    if (relPart === 'rel="next"') return urlPart.slice(1, -1);
  }
}

type PageResult<T> = { items: T[]; complete: boolean; error?: string };

async function ghPages<T>(
  g: ParsedGlobalArgs,
  path: string,
  params: Record<string, string | number | undefined> = {},
  extract: (value: unknown) => T[] = (value) => value as T[],
  deadlineMs?: number,
  stopAfterPage?: (items: T[]) => boolean,
): Promise<PageResult<T>> {
  const url = new URL(`https://api.github.com${path}`);
  url.searchParams.set("per_page", "100");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const out: T[] = [];
  let next: string | undefined = url.toString();
  for (let page = 0; next && page < g.maxApiPages; page++) {
    if (deadlineMs && Date.now() > deadlineMs) {
      return {
        items: out,
        complete: false,
        error: `sync budget exhausted while collecting ${path}`,
      };
    }
    try {
      const res = await fetch(next, {
        headers: githubApiHeaders(g),
        signal: deadlineSignal(deadlineMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          items: out,
          complete: false,
          error: `GitHub ${res.status} for ${new URL(next).pathname}: ${
            body.slice(0, 500)
          }`,
        };
      }
      const pageItems = extract(await res.json());
      out.push(...pageItems);
      next = parseNext(res.headers.get("link"));
      if (stopAfterPage?.(pageItems)) next = undefined;
    } catch (err) {
      return { items: out, complete: false, error: errorMessage(err) };
    }
  }
  if (next) {
    return {
      items: out,
      complete: false,
      error: `pagination exceeded maxApiPages=${g.maxApiPages} for ${path}`,
    };
  }
  return { items: out, complete: true };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type SyncError = {
  component: string;
  subjectType?: string;
  subjectNumber?: number;
  error: string;
};

async function writeCollectionStatus(
  ctx: Context,
  component: "prSnapshot" | "checkRunSnapshot" | "activityEvent" | "prCommit",
  complete: boolean,
  itemCount: number,
  syncedAt: string,
  subjectType?: "issue" | "pr" | "repo",
  subjectNumber?: number,
  error?: string,
): Promise<unknown> {
  return await ctx.writeResource(
    "collectionStatus",
    safeName("collection", [subjectType ?? "repo", subjectNumber, component]),
    {
      repo: repoFullName(ctx.globalArgs),
      subjectType,
      subjectNumber,
      component,
      complete,
      error,
      itemCount,
      syncedAt,
    },
  );
}

async function runGit(
  gitObjectPath: string,
  args: string[],
  deadlineMs?: number,
  input?: string,
): Promise<RunResult> {
  if (deadlineMs && Date.now() >= deadlineMs) {
    throw new Error("sync budget exhausted before running git");
  }
  const child = new Deno.Command("git", {
    args: ["--git-dir", gitObjectPath, ...args],
    stdin: input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const timer = deadlineMs
    ? setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may have exited between the timer firing and kill.
      }
    }, Math.max(1, deadlineMs - Date.now()))
    : undefined;
  const out = await (async () => {
    if (input !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(input));
      await writer.close();
    }
    return await child.output();
  })().finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function runGitOk(
  gitObjectPath: string,
  args: string[],
  deadlineMs?: number,
  input?: string,
): Promise<string> {
  const res = await runGit(gitObjectPath, args, deadlineMs, input);
  if (res.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.trim()}`);
  }
  return res.stdout;
}

async function changedFilesBetween(
  gitObjectPath: string,
  fromSha: string | undefined,
  toSha: string,
  deadlineMs?: number,
): Promise<ChangedFile[]> {
  const range = fromSha ? `${fromSha}..${toSha}` : toSha;
  const commonArgs = fromSha ? [range] : ["--root", toSha];
  const [names, stats] = await Promise.all([
    runGitOk(gitObjectPath, [
      "diff-tree",
      "-r",
      "-M",
      "--name-status",
      ...commonArgs,
    ], deadlineMs),
    runGitOk(gitObjectPath, [
      "diff-tree",
      "-r",
      "-M",
      "--numstat",
      ...commonArgs,
    ], deadlineMs),
  ]);
  const counts = new Map<string, { additions?: number; deletions?: number }>();
  for (const line of stats.split("\n")) {
    if (!line) continue;
    const [added, deleted, ...pathParts] = line.split("\t");
    const path = pathParts.at(-1);
    if (!path) continue;
    counts.set(path, {
      additions: added === "-" ? undefined : Number(added),
      deletions: deleted === "-" ? undefined : Number(deleted),
    });
  }
  const files: ChangedFile[] = [];
  for (const line of names.split("\n")) {
    if (!line) continue;
    const [rawStatus, firstPath, secondPath] = line.split("\t");
    if (!rawStatus || !firstPath) continue;
    const renamed = rawStatus.startsWith("R") || rawStatus.startsWith("C");
    const path = renamed && secondPath ? secondPath : firstPath;
    files.push({
      path,
      previousPath: renamed ? firstPath : undefined,
      status: rawStatus,
      ...counts.get(path),
    });
  }
  return files;
}

async function gitMergeBase(
  gitObjectPath: string,
  baseSha: string,
  headSha: string,
  deadlineMs?: number,
): Promise<string> {
  return (await runGitOk(
    gitObjectPath,
    ["merge-base", baseSha, headSha],
    deadlineMs,
  )).trim();
}

async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function removeFileIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return fallback;
    throw err;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await ensureDir(path.split("/").slice(0, -1).join("/") || ".");
  await Deno.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeJsonFileAtomically(
  path: string,
  value: unknown,
): Promise<void> {
  await ensureDir(path.split("/").slice(0, -1).join("/") || ".");
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeTextFile(
      temporaryPath,
      `${JSON.stringify(value, null, 2)}\n`,
    );
    await Deno.rename(temporaryPath, path);
  } catch (err) {
    await removeFileIfPresent(temporaryPath);
    throw err;
  }
}

function statePath(g: GlobalArgs): string {
  return `${g.artifactRoot}/state.json`;
}

function prRecordPath(g: GlobalArgs, pr: number): string {
  return `${g.artifactRoot}/prs/${pr}/current.json`;
}

function prFilesCompletePath(
  g: GlobalArgs,
  prNumber: number,
  headSha: string,
): string {
  return `${g.artifactRoot}/prs/${prNumber}/revisions/${headSha}/files.complete.json`;
}

function issueRecordPath(g: GlobalArgs, issue: number): string {
  return `${g.artifactRoot}/issues/${issue}/current.json`;
}

function worktreeIndexPath(g: GlobalArgs): string {
  return `${g.artifactRoot}/worktrees/index.json`;
}

async function readState(
  g: GlobalArgs,
): Promise<z.infer<typeof MirrorStateSchema>> {
  return await readJsonFile(statePath(g), {
    repo: repoFullName(g),
    cursor: {},
    syncInProgress: false,
    updatedAt: nowIso(),
  });
}

async function writeState(
  g: GlobalArgs,
  state: z.infer<typeof MirrorStateSchema>,
) {
  await writeJsonFile(statePath(g), state);
}

async function ensureRemote(
  g: GlobalArgs,
  name: string,
  url: string,
  deadlineMs?: number,
): Promise<void> {
  const remotes = (await runGit(g.gitObjectPath, ["remote"], deadlineMs)).stdout
    .split("\n")
    .map((s) => s.trim()).filter(Boolean);
  if (remotes.includes(name)) {
    await runGitOk(
      g.gitObjectPath,
      ["remote", "set-url", name, url],
      deadlineMs,
    );
    return;
  }
  await runGitOk(
    g.gitObjectPath,
    ["remote", "add", name, url],
    deadlineMs,
  );
}

async function ensureGitRepo(
  g: ParsedGlobalArgs,
  deadlineMs?: number,
): Promise<void> {
  if (!await exists(g.gitObjectPath)) {
    throw new Error(
      `gitObjectPath ${g.gitObjectPath} does not exist; create it with git init --bare or provide an existing bare repo`,
    );
  }
  const originUrl = g.gitRemoteUrl ??
    `https://github.com/${g.owner}/${g.repo}.git`;
  await ensureRemote(g, g.gitRemote, originUrl, deadlineMs);
  for (const [name, url] of Object.entries(g.knownRemotes)) {
    await ensureRemote(g, name, url, deadlineMs);
  }
}

async function fetchGit(
  g: ParsedGlobalArgs,
  deadlineMs?: number,
): Promise<void> {
  if (!await exists(g.gitObjectPath)) {
    throw new Error(
      `gitObjectPath ${g.gitObjectPath} does not exist; create it with git init --bare or provide an existing bare repo`,
    );
  }
  const lockFile = await Deno.open(`${g.gitObjectPath}/swamp-sync.lock`, {
    create: true,
    read: true,
    write: true,
  });
  try {
    if (deadlineMs) {
      while (!await lockFile.tryLock(true)) {
        const remaining = deadlineMs - Date.now();
        if (remaining <= 0) {
          throw new Error("sync budget exhausted while waiting for git lock");
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(50, remaining))
        );
      }
    } else {
      await lockFile.lock(true);
    }
    const remoteBranchPrefix = g.gitRemote === "pull" ||
        g.gitRemote.startsWith("pull/")
      ? `refs/swamp/remotes/${g.gitRemote}/`
      : `refs/remotes/${g.gitRemote}/`;
    await ensureGitRepo(g, deadlineMs);
    await runGitOk(g.gitObjectPath, [
      "config",
      "--replace-all",
      `remote.${g.gitRemote}.fetch`,
      `+refs/heads/*:${remoteBranchPrefix}*`,
    ], deadlineMs);
    await runGitOk(g.gitObjectPath, [
      "fetch",
      "--prune",
      g.gitRemote,
      `+refs/heads/*:${remoteBranchPrefix}*`,
      "+refs/tags/*:refs/tags/*",
      "+refs/pull/*/head:refs/remotes/pull/*/head",
      "+refs/pull/*/merge:refs/remotes/pull/*/merge",
    ], deadlineMs);
    const fetchedRemoteBranches = new Map<
      string,
      { ref: string; sha: string }
    >();
    const remoteRefs = await runGitOk(g.gitObjectPath, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      remoteBranchPrefix,
    ], deadlineMs);
    for (const line of remoteRefs.split("\n")) {
      const [ref, sha] = line.split(" ");
      if (!ref || !sha) continue;
      const branch = ref.slice(remoteBranchPrefix.length);
      if (branch && branch !== "HEAD") {
        fetchedRemoteBranches.set(branch, { ref, sha });
      }
    }
    const localBranches = new Map<string, { ref: string; sha: string }>();
    const localRefs = await runGitOk(g.gitObjectPath, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads/",
    ], deadlineMs);
    for (const line of localRefs.split("\n")) {
      const [ref, sha] = line.split(" ");
      if (!ref || !sha) continue;
      localBranches.set(ref.slice("refs/heads/".length), { ref, sha });
    }
    const localReviewBranches = [...localBranches.keys()].filter(
      (branch) => branch.startsWith("review/"),
    );
    const remoteBranches = new Map(
      [...fetchedRemoteBranches].filter(([branch]) =>
        branch !== "review" && !isManagedWorktreeBranch(branch) &&
        !localReviewBranches.some((local) => refsConflict(branch, local))
      ),
    );
    const remoteHead = await runGitOk(
      g.gitObjectPath,
      ["ls-remote", "--symref", g.gitRemote, "HEAD"],
      deadlineMs,
    );
    const defaultBranchMatch = remoteHead.match(
      /^ref: refs\/heads\/(.+)\tHEAD$/m,
    );
    const defaultBranch = defaultBranchMatch &&
        remoteBranches.has(defaultBranchMatch[1])
      ? defaultBranchMatch[1]
      : undefined;
    const currentHead = (await runGit(
      g.gitObjectPath,
      ["symbolic-ref", "--quiet", "HEAD"],
      deadlineMs,
    )).stdout.trim();
    const zeroOid = "0".repeat(40);
    const verificationCommands = [...remoteBranches.values()].map((
      { ref, sha },
    ) => `verify ${ref} ${sha}`);
    const staleBranches = [...localBranches].filter(([branch]) =>
      !branch.startsWith("review/") &&
      !remoteBranches.has(branch) &&
      (defaultBranch !== undefined || currentHead !== `refs/heads/${branch}`)
    );
    const pathConflictDeletes = staleBranches.filter(([branch]) =>
      [...remoteBranches.keys()].some((remote) => refsConflict(branch, remote))
    );
    if (pathConflictDeletes.length > 0) {
      await runGitOk(
        g.gitObjectPath,
        ["update-ref", "--stdin"],
        deadlineMs,
        `${
          [
            ...verificationCommands,
            ...pathConflictDeletes.map(([, { ref, sha }]) =>
              `delete ${ref} ${sha}`
            ),
          ].join("\n")
        }\n`,
      );
    }
    const updateCommands = [...remoteBranches].map(([branch, { sha }]) => {
      const oldSha = localBranches.get(branch)?.sha ?? zeroOid;
      return `update refs/heads/${branch} ${sha} ${oldSha}`;
    });
    if (updateCommands.length > 0) {
      await runGitOk(
        g.gitObjectPath,
        ["update-ref", "--stdin"],
        deadlineMs,
        `${[...verificationCommands, ...updateCommands].join("\n")}\n`,
      );
    }
    if (defaultBranch) {
      await runGitOk(
        g.gitObjectPath,
        ["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`],
        deadlineMs,
      );
    }
    const pathConflictRefs = new Set(
      pathConflictDeletes.map(([, { ref }]) => ref),
    );
    const deleteCommands = staleBranches
      .filter(([, { ref }]) => !pathConflictRefs.has(ref))
      .map(([, { ref, sha }]) => `delete ${ref} ${sha}`);
    if (deleteCommands.length > 0) {
      await runGitOk(
        g.gitObjectPath,
        ["update-ref", "--stdin"],
        deadlineMs,
        `${[...verificationCommands, ...deleteCommands].join("\n")}\n`,
      );
    }
  } finally {
    await lockFile.unlock().catch(() => {});
    lockFile.close();
  }
}

async function listMirroredPrHeads(
  g: ParsedGlobalArgs,
  deadlineMs?: number,
): Promise<Array<{ prNumber: number; headSha: string }>> {
  const output = await runGitOk(g.gitObjectPath, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/remotes/pull/*/head",
  ], deadlineMs);
  const heads: Array<{ prNumber: number; headSha: string }> = [];
  for (const line of output.split("\n")) {
    const match = line.match(
      /^refs\/remotes\/pull\/(\d+)\/head ([0-9a-f]{40,64})$/i,
    );
    if (!match) continue;
    heads.push({ prNumber: Number(match[1]), headSha: match[2] });
  }
  return heads;
}

async function exportPatch(
  g: GlobalArgs,
  prNumber: number,
  baseSha: string | undefined,
  headSha: string | undefined,
  deadlineMs?: number,
): Promise<string | undefined> {
  if (!baseSha || !headSha) return undefined;
  const dir = `${g.artifactRoot}/prs/${prNumber}/revisions/${headSha}`;
  const patchPath = `${dir}/pr.patch`;
  if (await exists(patchPath)) return patchPath;
  const diff = await runGit(g.gitObjectPath, [
    "diff",
    `${baseSha}...${headSha}`,
  ], deadlineMs);
  if (diff.code !== 0) {
    throw new Error(
      `git diff ${baseSha}...${headSha} failed: ${diff.stderr.trim()}`,
    );
  }
  await ensureDir(dir);
  await Deno.writeTextFile(patchPath, diff.stdout);
  return patchPath;
}

async function exportFilePatch(
  g: GlobalArgs,
  prNumber: number,
  headSha: string | undefined,
  filename: string,
  patch: string | undefined,
): Promise<string | undefined> {
  if (!headSha || !patch) return undefined;
  const fileName = safeName("file", [filename]) + ".patch";
  const path =
    `${g.artifactRoot}/prs/${prNumber}/revisions/${headSha}/files/${fileName}`;
  if (await exists(path)) return path;
  await ensureDir(path.split("/").slice(0, -1).join("/"));
  await Deno.writeTextFile(path, patch);
  return path;
}

function eventName(
  subjectType: "issue" | "pr",
  number: number,
  kind: string,
  id: unknown,
): string {
  return safeName("event", [
    subjectType,
    number,
    kind,
    String(id ?? "unknown"),
  ]);
}

type SubjectKind = "issue" | "pr";

async function writeTextReferences(
  ctx: Context,
  sourceType: SubjectKind,
  sourceNumber: number,
  text: string | null | undefined,
  createdAt: string | undefined,
  syncedAt: string,
  seen: Set<string>,
  relationshipOverride?: "cross-reference",
): Promise<unknown[]> {
  if (!text) return [];
  const repo = repoFullName(ctx.globalArgs);
  const candidates: Array<{
    targetRepo: string;
    targetType: SubjectKind | "unknown";
    targetNumber: number;
    url?: string;
    index: number;
  }> = [];
  const occupied: Array<[number, number]> = [];
  const urlPattern =
    /https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(issues|pull)\/(\d+)/gi;
  for (const match of text.matchAll(urlPattern)) {
    const index = match.index ?? 0;
    occupied.push([index, index + match[0].length]);
    candidates.push({
      targetRepo: `${match[1]}/${match[2]}`,
      targetType: match[3].toLowerCase() === "pull" ? "pr" : "issue",
      targetNumber: Number(match[4]),
      url: match[0],
      index,
    });
  }
  const qualifiedPattern = /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/g;
  for (const match of text.matchAll(qualifiedPattern)) {
    const index = match.index ?? 0;
    if (occupied.some(([start, end]) => index >= start && index < end)) {
      continue;
    }
    occupied.push([index, index + match[0].length]);
    candidates.push({
      targetRepo: `${match[1]}/${match[2]}`,
      targetType: "unknown",
      targetNumber: Number(match[3]),
      index,
    });
  }
  for (const match of text.matchAll(/(^|[^A-Za-z0-9_./-])#(\d+)\b/g)) {
    const index = (match.index ?? 0) + match[1].length;
    if (occupied.some(([start, end]) => index >= start && index < end)) {
      continue;
    }
    candidates.push({
      targetRepo: repo,
      targetType: relationshipOverride ? "issue" : "unknown",
      targetNumber: Number(match[2]),
      index,
    });
  }
  const handles: unknown[] = [];
  for (const candidate of candidates) {
    const prefix = text.slice(
      Math.max(0, candidate.index - 24),
      candidate.index,
    );
    const relationship = relationshipOverride ??
      (/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*$/i.test(prefix)
        ? "closing"
        : "text");
    if (relationship === "closing") candidate.targetType = "issue";
    const key = [
      sourceType,
      sourceNumber,
      candidate.targetRepo.toLowerCase(),
      candidate.targetType,
      candidate.targetNumber,
      relationship,
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    handles.push(
      await ctx.writeResource(
        "subjectReference",
        safeName("reference", [
          sourceType,
          sourceNumber,
          await hashPrefix(key),
        ]),
        {
          repo,
          sourceType,
          sourceNumber,
          targetRepo: candidate.targetRepo,
          targetType: candidate.targetType,
          targetNumber: candidate.targetNumber,
          url: candidate.url,
          relationship,
          external: candidate.targetRepo.toLowerCase() !== repo.toLowerCase(),
          createdAt,
          syncedAt,
        },
      ),
    );
  }
  return handles;
}

async function syncIssueDetails(
  ctx: Context,
  issue: GhIssue,
  eventCount: { value: number },
  deadlineMs?: number,
): Promise<{ handles: unknown[]; errors: SyncError[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const repo = repoFullName(g);
  const handles: unknown[] = [];
  const syncedAt = nowIso();
  const errors: SyncError[] = [];
  const referenceKeys = new Set<string>();
  const labels = (issue.labels ?? []).map((l) =>
    typeof l === "string" ? l : l.name
  ).filter(Boolean);
  handles.push(
    await ctx.writeResource(
      "issueSnapshot",
      safeName("issue", [issue.number]),
      {
        repo,
        number: issue.number,
        title: issue.title,
        state: issue.state,
        author: issue.user?.login,
        body: issue.body ?? undefined,
        url: issue.html_url,
        labels,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        closedAt: issue.closed_at,
        syncedAt,
      },
    ),
  );
  await writeJsonFile(issueRecordPath(g, issue.number), {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    body: issue.body ?? undefined,
    url: issue.html_url,
    updatedAt: issue.updated_at,
    observedAt: syncedAt,
  });
  handles.push(
    ...await writeTextReferences(
      ctx,
      "issue",
      issue.number,
      issue.body,
      issue.created_at,
      syncedAt,
      referenceKeys,
    ),
  );
  const commentsResult = await ghPages<GhComment>(
    g,
    `/repos/${g.owner}/${g.repo}/issues/${issue.number}/comments`,
    {},
    undefined,
    deadlineMs,
  );
  for (const c of commentsResult.items) {
    eventCount.value++;
    handles.push(
      await ctx.writeResource(
        "activityEvent",
        eventName("issue", issue.number, "comment", c.id),
        {
          repo,
          subjectType: "issue",
          subjectNumber: issue.number,
          eventType: "issue_comment",
          githubId: String(c.id),
          actor: c.user?.login,
          summary: `Issue #${issue.number} comment by ${
            c.user?.login ?? "unknown"
          }`,
          body: c.body,
          url: c.html_url,
          createdAt: c.created_at,
          syncedAt,
        },
      ),
    );
    handles.push(
      ...await writeTextReferences(
        ctx,
        "issue",
        issue.number,
        c.body,
        c.created_at,
        syncedAt,
        referenceKeys,
      ),
    );
  }
  const timelineResult = await ghPages<GhTimelineEvent>(
    g,
    `/repos/${g.owner}/${g.repo}/issues/${issue.number}/timeline`,
    {},
    undefined,
    deadlineMs,
  );
  for (const [index, e] of timelineResult.items.entries()) {
    if (!e.created_at) continue;
    eventCount.value++;
    handles.push(
      await ctx.writeResource(
        "activityEvent",
        eventName(
          "issue",
          issue.number,
          e.event ?? "timeline",
          e.id ?? `${e.event ?? "timeline"}-${e.created_at}-${index}`,
        ),
        {
          repo,
          subjectType: "issue",
          subjectNumber: issue.number,
          eventType: `github_${e.event ?? "timeline"}`,
          githubId: String(e.id ?? `${e.event}-${e.created_at}`),
          actor: e.actor?.login,
          summary: `${e.event ?? "timeline event"} on issue #${issue.number}`,
          url: e.html_url,
          state: e.state,
          payload: e,
          createdAt: e.created_at,
          syncedAt,
        },
      ),
    );
    if (e.event === "cross-referenced") {
      handles.push(
        ...await writeTextReferences(
          ctx,
          "issue",
          issue.number,
          JSON.stringify(e),
          e.created_at,
          syncedAt,
          referenceKeys,
          "cross-reference",
        ),
      );
    }
  }
  const collectionErrors = [commentsResult, timelineResult]
    .filter((result) => !result.complete)
    .map((result) => result.error ?? "incomplete GitHub activity collection");
  const error = collectionErrors.join("; ") || undefined;
  if (error) {
    errors.push({
      component: "activityEvent",
      subjectType: "issue",
      subjectNumber: issue.number,
      error,
    });
  }
  handles.push(
    await writeCollectionStatus(
      ctx,
      "activityEvent",
      !error,
      commentsResult.items.length + timelineResult.items.length,
      syncedAt,
      "issue",
      issue.number,
      error,
    ),
  );
  return { handles, errors };
}

async function syncPrDetails(
  ctx: Context,
  listPr: GhPr,
  counters: { eventCount: number; checkRunCount: number },
  deadlineMs?: number,
): Promise<{ handles: unknown[]; errors: SyncError[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const repo = repoFullName(g);
  const handles: unknown[] = [];
  const errors: SyncError[] = [];
  const referenceKeys = new Set<string>();
  const eventIds = new Set<string>();
  const previous = await readJsonFile<PrRecord | null>(
    prRecordPath(g, listPr.number),
    null,
  );
  const pr = await gh<GhPr>(
    g,
    `/repos/${g.owner}/${g.repo}/pulls/${listPr.number}`,
    deadlineMs,
  );
  if (deadlineMs && Date.now() > deadlineMs) {
    throw new Error(
      `sync budget exhausted while collecting PR #${listPr.number}`,
    );
  }
  const syncedAt = nowIso();
  const headOwner = pr.head?.repo?.owner?.login;
  const remoteName = headOwner ? remoteNameForOwner(headOwner) : undefined;
  if (remoteName && pr.head?.repo?.ssh_url) {
    await ensureRemote(g, remoteName, pr.head.repo.ssh_url, deadlineMs);
  }
  const prRecord: PrRecord = {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft,
    merged: Boolean(pr.merged_at),
    author: pr.user?.login,
    baseRef: pr.base?.ref,
    baseSha: pr.base?.sha,
    headOwner,
    headRepo: pr.head?.repo?.name,
    headFullName: pr.head?.repo?.full_name,
    headRef: pr.head?.ref,
    headSha: pr.head?.sha,
    maintainerCanModify: pr.maintainer_can_modify,
    headSshUrl: pr.head?.repo?.ssh_url,
    headHttpsUrl: pr.head?.repo?.clone_url,
    remoteName,
    updatedAt: pr.updated_at,
    observedAt: syncedAt,
    body: pr.body ?? undefined,
    url: pr.html_url,
  };
  const isNewHead = Boolean(pr.head?.sha && pr.head.sha !== previous?.headSha);
  const filesCompletePath = pr.head?.sha
    ? prFilesCompletePath(g, pr.number, pr.head.sha)
    : undefined;
  const needsFileSync = Boolean(
    pr.head?.sha &&
      (isNewHead || !filesCompletePath || !await exists(filesCompletePath)),
  );
  if (isNewHead && filesCompletePath) {
    await removeFileIfPresent(filesCompletePath);
  }
  const filesResult = needsFileSync
    ? await ghPages<GhFile>(
      g,
      `/repos/${g.owner}/${g.repo}/pulls/${pr.number}/files`,
      {},
      undefined,
      deadlineMs,
    )
    : { items: [], complete: true };
  const patchPath = isNewHead
    ? await exportPatch(
      g,
      pr.number,
      pr.base?.sha,
      pr.head?.sha,
      deadlineMs,
    )
    : undefined;
  const filesPath = needsFileSync
    ? `${g.artifactRoot}/prs/${pr.number}/revisions/${pr.head?.sha}/files.json`
    : undefined;
  if (filesPath && filesResult.complete) {
    await writeJsonFileAtomically(filesPath, filesResult.items);
  }
  if (isNewHead && pr.head?.sha) {
    const comparisonBase = previous?.headSha ??
      (pr.base?.sha
        ? await gitMergeBase(
          g.gitObjectPath,
          pr.base.sha,
          pr.head.sha,
          deadlineMs,
        )
        : undefined);
    const changedFiles = await changedFilesBetween(
      g.gitObjectPath,
      comparisonBase,
      pr.head.sha,
      deadlineMs,
    );
    handles.push(
      await ctx.writeResource(
        "prRevision",
        safeName("pr-revision", [pr.number, pr.head.sha]),
        {
          repo,
          prNumber: pr.number,
          baseSha: pr.base?.sha,
          headSha: pr.head.sha,
          previousHeadSha: previous?.headSha,
          patchHeadShort: shortSha(pr.head.sha),
          observedAt: syncedAt,
          gitObjectPath: g.gitObjectPath,
          patchPath,
          filesPath,
          changedFiles,
        },
      ),
    );
  }
  for (const f of filesResult.items) {
    const filePatchPath = await exportFilePatch(
      g,
      pr.number,
      pr.head?.sha,
      f.filename,
      f.patch,
    );
    handles.push(
      await ctx.writeResource(
        "prFileSnapshot",
        safeName("pr-file", [pr.number, pr.head?.sha, f.filename, f.sha]),
        {
          repo,
          prNumber: pr.number,
          headSha: pr.head?.sha,
          path: f.filename,
          previousFilename: f.previous_filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          blobSha: f.sha,
          rawUrl: f.raw_url,
          patchPath: filePatchPath,
          syncedAt,
        },
      ),
    );
  }
  if (needsFileSync && filesResult.complete && filesCompletePath) {
    await writeJsonFile(filesCompletePath, {
      headSha: pr.head?.sha,
      itemCount: filesResult.items.length,
      completedAt: syncedAt,
    });
  }
  const reviewsResult = await ghPages<GhReview>(
    g,
    `/repos/${g.owner}/${g.repo}/pulls/${pr.number}/reviews`,
    {},
    undefined,
    deadlineMs,
  );
  const latestReviewByUser = new Map<string, string>();
  for (const review of reviewsResult.items) {
    const state = review.state?.toLowerCase();
    const login = review.user?.login;
    if (!login) continue;
    if (state === "dismissed") {
      latestReviewByUser.delete(login);
    } else if (state === "approved" || state === "changes_requested") {
      latestReviewByUser.set(login, state);
    }
  }
  const latestReviewStates = [...latestReviewByUser.values()];
  const reviewDecision = !reviewsResult.complete
    ? undefined
    : latestReviewStates.includes("changes_requested")
    ? "CHANGES_REQUESTED"
    : latestReviewStates.includes("approved")
    ? "APPROVED"
    : undefined;
  handles.push(
    await ctx.writeResource("prSnapshot", safeName("pr", [pr.number]), {
      repo,
      number: pr.number,
      title: pr.title,
      body: pr.body ?? undefined,
      url: pr.html_url,
      labels: (pr.labels ?? []).map((label) =>
        typeof label === "string" ? label : label.name
      ).filter(Boolean),
      requestedReviewers: (pr.requested_reviewers ?? []).map((user) =>
        user.login
      ).filter(Boolean),
      reviewDecision,
      mergeable: pr.mergeable,
      mergeableState: pr.mergeable_state,
      state: pr.state,
      draft: pr.draft,
      merged: Boolean(pr.merged_at),
      author: pr.user?.login,
      baseRef: pr.base?.ref,
      baseSha: pr.base?.sha,
      headOwner,
      headRepo: pr.head?.repo?.name,
      headFullName: pr.head?.repo?.full_name,
      headRef: pr.head?.ref,
      headSha: pr.head?.sha,
      maintainerCanModify: pr.maintainer_can_modify,
      remoteName,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      closedAt: pr.closed_at,
      mergedAt: pr.merged_at,
      syncedAt,
    }),
  );
  handles.push(
    ...await writeTextReferences(
      ctx,
      "pr",
      pr.number,
      pr.body,
      pr.created_at,
      syncedAt,
      referenceKeys,
    ),
  );
  for (const r of reviewsResult.items) {
    if (r.id != null) eventIds.add(`review:${r.id}`);
    counters.eventCount++;
    handles.push(
      await ctx.writeResource(
        "activityEvent",
        eventName("pr", pr.number, "review", r.id),
        {
          repo,
          subjectType: "pr",
          subjectNumber: pr.number,
          eventType: "review_submitted",
          githubId: String(r.id),
          actor: r.user?.login,
          summary: `${r.state} review on PR #${pr.number}`,
          body: r.body,
          url: r.html_url,
          state: r.state,
          commitSha: r.commit_id,
          createdAt: r.submitted_at ?? pr.updated_at,
          syncedAt,
        },
      ),
    );
    handles.push(
      ...await writeTextReferences(
        ctx,
        "pr",
        pr.number,
        r.body,
        r.submitted_at,
        syncedAt,
        referenceKeys,
      ),
    );
  }
  const reviewCommentsResult = await ghPages<GhComment>(
    g,
    `/repos/${g.owner}/${g.repo}/pulls/${pr.number}/comments`,
    {},
    undefined,
    deadlineMs,
  );
  for (const c of reviewCommentsResult.items) {
    if (c.id != null) eventIds.add(`comment:${c.id}`);
    counters.eventCount++;
    handles.push(
      await ctx.writeResource(
        "activityEvent",
        eventName("pr", pr.number, "review-comment", c.id),
        {
          repo,
          subjectType: "pr",
          subjectNumber: pr.number,
          eventType: "review_comment",
          githubId: String(c.id),
          actor: c.user?.login,
          summary: `Review comment on ${c.path}`,
          body: c.body,
          url: c.html_url,
          filePath: c.path,
          line: c.line ?? undefined,
          side: c.side ?? undefined,
          commitSha: c.commit_id,
          createdAt: c.created_at,
          syncedAt,
        },
      ),
    );
    handles.push(
      ...await writeTextReferences(
        ctx,
        "pr",
        pr.number,
        c.body,
        c.created_at,
        syncedAt,
        referenceKeys,
      ),
    );
  }
  const issueCommentsResult = await ghPages<GhComment>(
    g,
    `/repos/${g.owner}/${g.repo}/issues/${pr.number}/comments`,
    {},
    undefined,
    deadlineMs,
  );
  for (const c of issueCommentsResult.items) {
    if (c.id != null) eventIds.add(`comment:${c.id}`);
    counters.eventCount++;
    handles.push(
      await ctx.writeResource(
        "activityEvent",
        eventName("pr", pr.number, "issue-comment", c.id),
        {
          repo,
          subjectType: "pr",
          subjectNumber: pr.number,
          eventType: "pr_conversation_comment",
          githubId: String(c.id),
          actor: c.user?.login,
          summary: `PR #${pr.number} conversation comment by ${
            c.user?.login ?? "unknown"
          }`,
          body: c.body,
          url: c.html_url,
          createdAt: c.created_at,
          syncedAt,
        },
      ),
    );
    handles.push(
      ...await writeTextReferences(
        ctx,
        "pr",
        pr.number,
        c.body,
        c.created_at,
        syncedAt,
        referenceKeys,
      ),
    );
  }
  const timelineResult = await ghPages<GhTimelineEvent>(
    g,
    `/repos/${g.owner}/${g.repo}/issues/${pr.number}/timeline`,
    {},
    undefined,
    deadlineMs,
  );
  for (const [index, e] of timelineResult.items.entries()) {
    if (!e.created_at) continue;
    const duplicateFamily = e.event === "reviewed"
      ? "review"
      : e.event === "commented"
      ? "comment"
      : undefined;
    if (
      duplicateFamily && e.id != null &&
      eventIds.has(`${duplicateFamily}:${e.id}`)
    ) continue;
    counters.eventCount++;
    handles.push(
      await ctx.writeResource(
        "activityEvent",
        eventName(
          "pr",
          pr.number,
          e.event ?? "timeline",
          e.id ?? `${e.event ?? "timeline"}-${e.created_at}-${index}`,
        ),
        {
          repo,
          subjectType: "pr",
          subjectNumber: pr.number,
          eventType: `github_${e.event ?? "timeline"}`,
          githubId: String(e.id ?? `${e.event}-${e.created_at}`),
          actor: e.actor?.login,
          summary: `${e.event ?? "timeline event"} on PR #${pr.number}`,
          url: e.html_url,
          state: e.state,
          commitSha: typeof e.commit_id === "string"
            ? e.commit_id
            : typeof e.sha === "string"
            ? e.sha
            : undefined,
          payload: e,
          createdAt: e.created_at,
          syncedAt,
        },
      ),
    );
    if (e.event === "cross-referenced") {
      handles.push(
        ...await writeTextReferences(
          ctx,
          "pr",
          pr.number,
          JSON.stringify(e),
          e.created_at,
          syncedAt,
          referenceKeys,
          "cross-reference",
        ),
      );
    }
  }
  let checksResult: PageResult<GhCheckRun> = { items: [], complete: true };
  if (pr.head?.sha) {
    checksResult = await ghPages<GhCheckRun>(
      g,
      `/repos/${g.owner}/${g.repo}/commits/${pr.head.sha}/check-runs`,
      {},
      (value) => (value as GhCheckRuns).check_runs ?? [],
      deadlineMs,
    );
    for (const check of checksResult.items) {
      counters.checkRunCount++;
      handles.push(
        await ctx.writeResource(
          "checkRunSnapshot",
          safeName("check", [pr.number, pr.head.sha, check.id]),
          {
            repo,
            prNumber: pr.number,
            headSha: pr.head.sha,
            name: check.name,
            status: check.status,
            conclusion: check.conclusion,
            url: check.html_url,
            startedAt: check.started_at,
            completedAt: check.completed_at,
            syncedAt,
          },
        ),
      );
    }
  }
  const commitsResult = await ghPages<GhCommit>(
    g,
    `/repos/${g.owner}/${g.repo}/pulls/${pr.number}/commits`,
    {},
    undefined,
    deadlineMs,
  );
  for (const commit of commitsResult.items) {
    if (deadlineMs && Date.now() > deadlineMs) {
      commitsResult.complete = false;
      commitsResult.error =
        `sync budget exhausted while processing commits for PR #${pr.number}`;
      break;
    }
    const changedFiles = await changedFilesBetween(
      g.gitObjectPath,
      commit.parents?.[0]?.sha,
      commit.sha,
      deadlineMs,
    );
    handles.push(
      await ctx.writeResource(
        "prCommit",
        safeName("pr-commit", [pr.number, commit.sha]),
        {
          repo,
          prNumber: pr.number,
          headSha: pr.head?.sha,
          sha: commit.sha,
          parentShas: (commit.parents ?? []).map((parent) => parent.sha).filter(
            Boolean,
          ),
          message: commit.commit?.message,
          authorName: commit.commit?.author?.name,
          authorEmail: commit.commit?.author?.email,
          authoredAt: commit.commit?.author?.date,
          committedAt: commit.commit?.committer?.date,
          url: commit.html_url,
          changedFiles,
          syncedAt,
        },
      ),
    );
  }
  const activityResults = [
    reviewsResult,
    reviewCommentsResult,
    issueCommentsResult,
    timelineResult,
  ];
  const activityError = activityResults.filter((result) => !result.complete)
    .map((result) => result.error ?? "incomplete GitHub activity collection")
    .join("; ") || undefined;
  const statuses: Array<{
    component: "prSnapshot" | "checkRunSnapshot" | "activityEvent" | "prCommit";
    complete: boolean;
    itemCount: number;
    error?: string;
  }> = [
    {
      component: "prSnapshot",
      complete: filesResult.complete,
      itemCount: 1,
      error: filesResult.error,
    },
    {
      component: "activityEvent",
      complete: !activityError,
      itemCount: activityResults.reduce(
        (sum, result) => sum + result.items.length,
        0,
      ),
      error: activityError,
    },
    {
      component: "checkRunSnapshot",
      complete: checksResult.complete,
      itemCount: checksResult.items.length,
      error: checksResult.error,
    },
    {
      component: "prCommit",
      complete: commitsResult.complete,
      itemCount: commitsResult.items.length,
      error: commitsResult.error,
    },
  ];
  for (const status of statuses) {
    handles.push(
      await writeCollectionStatus(
        ctx,
        status.component,
        status.complete,
        status.itemCount,
        syncedAt,
        "pr",
        pr.number,
        status.error,
      ),
    );
    if (!status.complete) {
      errors.push({
        component: status.component,
        subjectType: "pr",
        subjectNumber: pr.number,
        error: status.error ?? "incomplete collection",
      });
    }
  }
  await writeJsonFile(prRecordPath(g, pr.number), prRecord);
  return { handles, errors };
}

function cursorSince(
  value: string | undefined,
  overlapMinutes: number,
): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return value;
  return new Date(t - overlapMinutes * 60_000).toISOString();
}

async function syncMirror(args: { budgetSeconds?: number }, ctx: Context) {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const normalizedContext = { ...ctx, globalArgs: g };
  const startedAt = nowIso();
  const deadlineMs = args.budgetSeconds
    ? Date.parse(startedAt) + args.budgetSeconds * 1000
    : undefined;
  await ensureDir(g.artifactRoot);
  await ensureDir(g.workspaceRoot);
  const state = await readState(g);
  state.syncInProgress = true;
  state.updatedAt = nowIso();
  await writeState(g, state);
  const handles: unknown[] = [];
  let gitFetched = false;
  let prCount = 0;
  let issueCount = 0;
  const issueEventCount = { value: 0 };
  const counters = { eventCount: 0, checkRunCount: 0 };
  const errors: SyncError[] = [];
  let gitFetchStartedAt: string | undefined;
  let gitFetchFinishedAt: string | undefined;
  let githubStartedAt: string | undefined;
  let githubFinishedAt: string | undefined;
  let budgetExhausted = false;
  try {
    gitFetchStartedAt = nowIso();
    await fetchGit(g, deadlineMs);
    gitFetchFinishedAt = nowIso();
    gitFetched = true;
    for (const head of await listMirroredPrHeads(g, deadlineMs)) {
      handles.push(
        await ctx.writeResource(
          "prHeadState",
          safeName("pr-head", [head.prNumber]),
          {
            repo: repoFullName(g),
            prNumber: head.prNumber,
            headSha: head.headSha,
            fetchedAt: gitFetchFinishedAt,
          },
        ),
      );
    }
    githubStartedAt = nowIso();
    const repo = await gh<GhRepo>(
      g,
      `/repos/${g.owner}/${g.repo}`,
      deadlineMs,
    );
    handles.push(
      await ctx.writeResource("repoSnapshot", "repo-current", {
        repo: repoFullName(g),
        owner: g.owner,
        name: g.repo,
        defaultBranch: repo.default_branch,
        private: repo.private,
        archived: repo.archived,
        pushedAt: repo.pushed_at,
        updatedAt: repo.updated_at,
        syncedAt: nowIso(),
      }),
    );
    const since = g.firstSyncSince ?? cursorSince(
      state.cursor.lastSuccessfulSyncAt,
      g.syncOverlapMinutes,
    );
    const prsResult = await ghPages<GhPr>(
      g,
      `/repos/${g.owner}/${g.repo}/pulls`,
      {
        state: "all",
        sort: "updated",
        direction: "desc",
      },
      undefined,
      deadlineMs,
      since
        ? (items) => (items.at(-1)?.updated_at ?? since) < since
        : undefined,
    );
    if (!prsResult.complete) {
      errors.push({
        component: "prSnapshot",
        subjectType: "repo",
        error: prsResult.error ?? "incomplete PR collection",
      });
    }
    const selectedPrs = since
      ? prsResult.items.filter((p) => (p.updated_at ?? "") >= since)
      : prsResult.items;
    let maxPrUpdated = state.cursor.lastPrUpdatedAt;
    let prBudgetError: string | undefined;
    for (const pr of selectedPrs) {
      if (
        args.budgetSeconds &&
        Date.now() - Date.parse(startedAt) > args.budgetSeconds * 1000
      ) {
        budgetExhausted = true;
        break;
      }
      prCount++;
      if (pr.updated_at && (!maxPrUpdated || pr.updated_at > maxPrUpdated)) {
        maxPrUpdated = pr.updated_at;
      }
      try {
        const result = await syncPrDetails(
          normalizedContext,
          pr,
          counters,
          deadlineMs,
        );
        handles.push(...result.handles);
        errors.push(...result.errors);
      } catch (err) {
        const message = errorMessage(err);
        for (
          const component of [
            "prSnapshot",
            "checkRunSnapshot",
            "activityEvent",
            "prCommit",
          ] as const
        ) {
          errors.push({
            component,
            subjectType: "pr",
            subjectNumber: pr.number,
            error: message,
          });
          handles.push(
            await writeCollectionStatus(
              normalizedContext,
              component,
              false,
              0,
              nowIso(),
              "pr",
              pr.number,
              message,
            ),
          );
        }
      }
      if (
        args.budgetSeconds &&
        Date.now() - Date.parse(startedAt) > args.budgetSeconds * 1000
      ) {
        budgetExhausted = true;
        const error = "sync budget exhausted before all PRs were processed";
        prBudgetError = error;
        errors.push({
          component: "prSnapshot",
          error,
        });
        break;
      }
    }
    if (budgetExhausted && !prBudgetError) {
      const error = "sync budget exhausted before all PRs were processed";
      prBudgetError = error;
      errors.push({ component: "prSnapshot", error });
    }
    const prCollectionError = [prsResult.error, prBudgetError]
      .filter((error): error is string => Boolean(error)).join("; ") ||
      undefined;
    handles.push(
      await writeCollectionStatus(
        normalizedContext,
        "prSnapshot",
        prsResult.complete && !prBudgetError,
        prBudgetError ? prCount : prsResult.items.length,
        nowIso(),
        "repo",
        undefined,
        prCollectionError,
      ),
    );
    const issuesResult = budgetExhausted
      ? {
        items: [] as GhIssue[],
        complete: false,
        error: "issue collection skipped because the sync budget was exhausted",
      }
      : await ghPages<GhIssue>(
        g,
        `/repos/${g.owner}/${g.repo}/issues`,
        {
          state: "all",
          since,
        },
        undefined,
        deadlineMs,
      );
    if (!issuesResult.complete) {
      errors.push({
        component: "activityEvent",
        subjectType: "repo",
        error: issuesResult.error ?? "incomplete issue collection",
      });
    }
    const issues = issuesResult.items.filter((i) => !i.pull_request);
    let maxIssueUpdated = state.cursor.lastIssueUpdatedAt;
    let issueBudgetError: string | undefined;
    for (const issue of issues) {
      if (
        args.budgetSeconds &&
        Date.now() - Date.parse(startedAt) > args.budgetSeconds * 1000
      ) {
        budgetExhausted = true;
        break;
      }
      issueCount++;
      if (
        issue.updated_at &&
        (!maxIssueUpdated || issue.updated_at > maxIssueUpdated)
      ) {
        maxIssueUpdated = issue.updated_at;
      }
      try {
        const result = await syncIssueDetails(
          normalizedContext,
          issue,
          issueEventCount,
          deadlineMs,
        );
        handles.push(...result.handles);
        errors.push(...result.errors);
      } catch (err) {
        const message = errorMessage(err);
        errors.push({
          component: "activityEvent",
          subjectType: "issue",
          subjectNumber: issue.number,
          error: message,
        });
        handles.push(
          await writeCollectionStatus(
            normalizedContext,
            "activityEvent",
            false,
            0,
            nowIso(),
            "issue",
            issue.number,
            message,
          ),
        );
      }
      if (
        args.budgetSeconds &&
        Date.now() - Date.parse(startedAt) > args.budgetSeconds * 1000
      ) {
        budgetExhausted = true;
        const error = "sync budget exhausted before all issues were processed";
        issueBudgetError = error;
        errors.push({
          component: "activityEvent",
          error,
        });
        break;
      }
    }
    if (
      budgetExhausted && issues.length > issueCount &&
      !issueBudgetError
    ) {
      const error = "sync budget exhausted before all issues were processed";
      issueBudgetError = error;
      errors.push({ component: "activityEvent", error });
    }
    const issueCollectionError = [issuesResult.error, issueBudgetError]
      .filter((error): error is string => Boolean(error)).join("; ") ||
      undefined;
    handles.push(
      await writeCollectionStatus(
        normalizedContext,
        "activityEvent",
        issuesResult.complete && !issueBudgetError,
        issueBudgetError ? issueCount : issuesResult.items.length,
        nowIso(),
        "repo",
        undefined,
        issueCollectionError,
      ),
    );
    githubFinishedAt = nowIso();
    const finishedAt = nowIso();
    const complete = errors.length === 0;
    if (complete) {
      state.cursor.lastSuccessfulSyncAt = finishedAt;
      state.cursor.lastPrUpdatedAt = maxPrUpdated;
      state.cursor.lastIssueUpdatedAt = maxIssueUpdated;
    }
    state.syncInProgress = false;
    state.updatedAt = finishedAt;
    await writeState(g, state);
    handles.push(
      await ctx.writeResource("mirrorState", "mirror-state-current", state),
    );
    handles.push(
      await ctx.writeResource("syncRunSummary", `sync-${finishedAt}`, {
        repo: repoFullName(g),
        startedAt,
        finishedAt,
        prCount,
        issueCount,
        eventCount: counters.eventCount + issueEventCount.value,
        checkRunCount: counters.checkRunCount,
        gitFetched,
        githubStartedAt,
        githubFinishedAt,
        gitFetchStartedAt,
        gitFetchFinishedAt,
        errors,
        complete,
        cursorPrUpdatedAt: state.cursor.lastPrUpdatedAt,
        cursorIssueUpdatedAt: state.cursor.lastIssueUpdatedAt,
      }),
    );
    return { dataHandles: handles, errors, complete };
  } catch (err) {
    state.syncInProgress = false;
    state.updatedAt = nowIso();
    await writeState(g, state);
    throw err;
  }
}

async function readPrRecord(
  g: GlobalArgs,
  prNumber: number,
): Promise<PrRecord> {
  const record = await readJsonFile<PrRecord | null>(
    prRecordPath(g, prNumber),
    null,
  );
  if (!record?.headSha) {
    throw new Error(
      `PR ${prNumber} is not present in the local mirror; run sync first`,
    );
  }
  return record;
}

async function readMirroredPrHead(
  g: GlobalArgs,
  prNumber: number,
): Promise<string> {
  const ref = `refs/remotes/pull/${prNumber}/head`;
  const result = await runGit(g.gitObjectPath, ["rev-parse", "--verify", ref]);
  const headSha = result.stdout.trim();
  if (result.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(headSha)) {
    throw new Error(
      `PR ${prNumber} head is not present in the local git mirror; run sync first`,
    );
  }
  return headSha;
}

async function readWorktrees(g: GlobalArgs): Promise<WorktreeRecord[]> {
  return await readJsonFile<WorktreeRecord[]>(worktreeIndexPath(g), []);
}

async function writeWorktrees(
  g: GlobalArgs,
  records: WorktreeRecord[],
): Promise<void> {
  await writeJsonFileAtomically(worktreeIndexPath(g), records);
}

function identitySuffix(identity?: string): string {
  return identity ? `-${safeName("", [identity])}` : "";
}

async function prepareWorktree(
  args: { prNumber: number; identity?: string },
  ctx: Context,
) {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const pr = await readPrRecord(g, args.prNumber);
  const headSha = await readMirroredPrHead(g, args.prNumber);
  const suffix = `pr-${args.prNumber}-patchhead-${shortSha(headSha)}${
    identitySuffix(args.identity)
  }`;
  const branch = `review/${suffix}`;
  const path = `${g.workspaceRoot}/${suffix}`;
  if (!await exists(path)) {
    await runGitOk(g.gitObjectPath, ["branch", branch, headSha]).catch(
      async (err) => {
        const branches = await runGit(g.gitObjectPath, [
          "rev-parse",
          "--verify",
          branch,
        ]);
        if (branches.code !== 0) throw err;
      },
    );
    await runGitOk(g.gitObjectPath, ["worktree", "add", path, branch]);
  }
  const record: WorktreeRecord = {
    id: safeName("worktree", [
      repoFullName(g),
      args.prNumber,
      shortSha(headSha),
      args.identity,
    ]),
    repo: repoFullName(g),
    prNumber: args.prNumber,
    identity: args.identity,
    path,
    branch,
    baseHeadSha: headSha,
    createdAt: nowIso(),
    status: "active",
  };
  const records = (await readWorktrees(g)).filter((r) => r.id !== record.id);
  records.push(record);
  await writeWorktrees(g, records);
  const handle = await ctx.writeResource("worktreeSnapshot", record.id, record);
  return {
    dataHandles: [handle],
    path,
    branch,
    baseHeadSha: headSha,
    contributorRemote: pr.remoteName,
    contributorHeadRef: pr.headRef,
    maintainerCanModify: pr.maintainerCanModify,
    suggestedContributorPush: pr.remoteName && pr.headRef
      ? `git push ${pr.remoteName} HEAD:${pr.headRef}`
      : undefined,
  };
}

async function gitInWorktree(path: string, args: string[]): Promise<RunResult> {
  const out = await new Deno.Command("git", {
    cwd: path,
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function verifyGitWorktreeRemoved(
  g: GlobalArgs,
  path: string,
  branch: string,
): Promise<void> {
  const listed = await runGit(g.gitObjectPath, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  if (listed.code !== 0) {
    throw new Error(
      listed.stderr.trim() || `git worktree list exited ${listed.code}`,
    );
  }
  const fields = listed.stdout.split("\0");
  if (
    fields.includes(`worktree ${path}`) ||
    fields.includes(`branch refs/heads/${branch}`)
  ) {
    throw new Error(
      `missing worktree remains registered with Git: ${path}; inspect it before pruning Git metadata`,
    );
  }
}

async function analyzeWorktrees(_args: Record<string, never>, ctx: Context) {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const records = (await readWorktrees(g)).filter((record) =>
    record.status === "active"
  );
  const handles: unknown[] = [];
  const analyzedAt = nowIso();
  for (const record of records) {
    const missing = !await exists(record.path);
    let isDirty = false;
    let aheadCommitCount = 0;
    let analysisComplete = true;
    const errors: string[] = [];
    let latest: string | undefined;
    try {
      latest = await readMirroredPrHead(g, record.prNumber);
    } catch (err) {
      analysisComplete = false;
      errors.push(errorMessage(err));
    }
    if (!missing) {
      const status = await gitInWorktree(record.path, [
        "status",
        "--porcelain",
      ]);
      if (status.code === 0) {
        isDirty = status.stdout.trim().length > 0;
      } else {
        analysisComplete = false;
        errors.push(`git status failed: ${status.stderr.trim()}`);
      }
      const ahead = await gitInWorktree(record.path, [
        "rev-list",
        "--count",
        `${record.baseHeadSha}..HEAD`,
      ]);
      if (ahead.code === 0) {
        aheadCommitCount = Number(ahead.stdout.trim() || "0");
      } else {
        analysisComplete = false;
        errors.push(`git rev-list failed: ${ahead.stderr.trim()}`);
      }
    }
    const isPrHeadStale = Boolean(latest && latest !== record.baseHeadSha);
    const recommendedAction = missing
      ? "remove-or-recreate-worktree-record"
      : !analysisComplete
      ? "inspect-worktree-analysis-errors"
      : isPrHeadStale && aheadCommitCount > 0
      ? "rebase-or-recreate-after-saving-local-commits"
      : isPrHeadStale
      ? "recreate-from-latest-pr-head"
      : isDirty
      ? "commit-or-stash-local-changes"
      : aheadCommitCount > 0
      ? "push-or-record-local-commits"
      : "none";
    handles.push(
      await ctx.writeResource("worktreeAnalysis", record.id, {
        worktreeId: record.id,
        repo: repoFullName(g),
        prNumber: record.prNumber,
        identity: record.identity,
        path: record.path,
        branch: record.branch,
        baseHeadSha: record.baseHeadSha,
        latestMirrorHeadSha: latest,
        isPrHeadStale,
        isDirty,
        aheadCommitCount,
        missing,
        analysisComplete,
        errors,
        recommendedAction,
        analyzedAt,
      }),
    );
  }
  return { dataHandles: handles };
}

async function closeMergedWorktrees(
  _args: Record<string, never>,
  ctx: Context,
) {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const startedAt = nowIso();
  const records = await readWorktrees(g);
  const activeRecords = records.filter((record) => record.status === "active");
  const handles: unknown[] = [];
  const results: Array<{
    worktreeId: string;
    prNumber: number;
    path: string;
    branch: string;
    outcome: "removed" | "failed" | "skipped";
    reason?: string;
    error?: string;
    branchRetained: boolean;
    stateRecorded: boolean;
  }> = [];
  let candidateCount = 0;
  let removedCount = 0;
  let failedCount = 0;

  for (const record of activeRecords) {
    let pr: PrRecord | null;
    try {
      pr = await readJsonFile<PrRecord | null>(
        prRecordPath(g, record.prNumber),
        null,
      );
    } catch (err) {
      failedCount++;
      results.push({
        worktreeId: record.id,
        prNumber: record.prNumber,
        path: record.path,
        branch: record.branch,
        outcome: "failed",
        reason: "pr-state-unavailable",
        error: errorMessage(err).slice(0, 2000),
        branchRetained: true,
        stateRecorded: true,
      });
      continue;
    }
    if (!pr) {
      failedCount++;
      results.push({
        worktreeId: record.id,
        prNumber: record.prNumber,
        path: record.path,
        branch: record.branch,
        outcome: "failed",
        reason: "pr-state-unavailable",
        error:
          `PR ${record.prNumber} is not present in the local mirror; run sync first`,
        branchRetained: true,
        stateRecorded: true,
      });
      continue;
    }
    if (pr.state !== "closed" || pr.merged !== true) {
      results.push({
        worktreeId: record.id,
        prNumber: record.prNumber,
        path: record.path,
        branch: record.branch,
        outcome: "skipped",
        reason: "pr-not-merged",
        branchRetained: true,
        stateRecorded: true,
      });
      continue;
    }

    candidateCount++;
    let missing = false;
    try {
      missing = !await exists(record.path);
      if (missing) {
        await verifyGitWorktreeRemoved(g, record.path, record.branch);
      } else {
        const status = await gitInWorktree(record.path, [
          "status",
          "--porcelain",
          "--ignored",
        ]);
        if (status.code !== 0) {
          throw new Error(
            status.stderr.trim() || `git status exited ${status.code}`,
          );
        }
        const ignoredPaths = status.stdout.split("\n").filter((line) =>
          line.startsWith("!! ")
        );
        if (ignoredPaths.length > 0) {
          throw new Error(
            `worktree contains ignored files: ${
              ignoredPaths.slice(0, 10).map((line) => line.slice(3)).join(", ")
            }`,
          );
        }
        const symbolicHead = await gitInWorktree(record.path, [
          "symbolic-ref",
          "--quiet",
          "--short",
          "HEAD",
        ]);
        if (symbolicHead.code !== 0) {
          const retained = await gitInWorktree(record.path, [
            "merge-base",
            "--is-ancestor",
            "HEAD",
            record.branch,
          ]);
          if (retained.code === 1) {
            throw new Error(
              `detached HEAD contains commits not retained by ${record.branch}`,
            );
          }
          if (retained.code !== 0) {
            throw new Error(
              retained.stderr.trim() ||
                `git merge-base --is-ancestor exited ${retained.code}`,
            );
          }
        }
        const removal = await runGit(g.gitObjectPath, [
          "worktree",
          "remove",
          record.path,
        ]);
        if (removal.code !== 0) {
          throw new Error(
            removal.stderr.trim() ||
              `git worktree remove exited ${removal.code}`,
          );
        }
      }
    } catch (err) {
      failedCount++;
      results.push({
        worktreeId: record.id,
        prNumber: record.prNumber,
        path: record.path,
        branch: record.branch,
        outcome: "failed",
        reason: "git-worktree-remove-failed",
        error: errorMessage(err).slice(0, 2000),
        branchRetained: true,
        stateRecorded: true,
      });
      continue;
    }

    const removedAt = nowIso();
    const index = records.findIndex((candidate) => candidate.id === record.id);
    const removedRecord: WorktreeRecord = {
      ...record,
      status: "removed",
      removedAt,
    };
    removedCount++;
    let stateRecorded = true;
    let persistenceError: string | undefined;
    try {
      handles.push(
        await ctx.writeResource(
          "worktreeSnapshot",
          record.id,
          removedRecord,
        ),
      );
      records[index] = removedRecord;
      await writeWorktrees(g, records);
    } catch (err) {
      stateRecorded = false;
      persistenceError = `worktree removed but state recording failed: ${
        errorMessage(err).slice(0, 1900)
      }`;
    }
    results.push({
      worktreeId: record.id,
      prNumber: record.prNumber,
      path: record.path,
      branch: record.branch,
      outcome: "removed",
      reason: missing ? "worktree-already-missing" : "pr-merged",
      error: persistenceError,
      branchRetained: true,
      stateRecorded,
    });
  }

  const finishedAt = nowIso();
  const summary = {
    repo: repoFullName(g),
    startedAt,
    finishedAt,
    activeCount: activeRecords.length,
    candidateCount,
    removedCount,
    failedCount,
    skippedCount: results.filter((result) => result.outcome === "skipped")
      .length,
    complete: failedCount === 0 &&
      results.every((result) => result.stateRecorded),
    results,
  };
  handles.push(
    await ctx.writeResource(
      "worktreeCleanupRun",
      `cleanup-${finishedAt}`,
      summary,
    ),
  );
  return { dataHandles: handles, ...summary };
}

async function status(_args: Record<string, never>, ctx: Context) {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const state = await readState(g);
  const worktrees = (await readWorktrees(g)).filter((record) =>
    record.status === "active"
  );
  const handle = await ctx.writeResource(
    "mirrorStatus",
    "mirror-status-current",
    {
      repo: repoFullName(g),
      modelName: modelName(ctx),
      state,
      worktreeCount: worktrees.length,
      artifactRoot: g.artifactRoot,
      workspaceRoot: g.workspaceRoot,
      gitObjectPath: g.gitObjectPath,
      generatedAt: nowIso(),
    },
  );
  return { dataHandles: [handle], state, worktreeCount: worktrees.length };
}

const PrepareReviewContextArgsSchema = z.object({
  subjectType: z.enum(["pr", "issue"]),
  number: z.number().int().positive(),
});

async function prepareReviewContext(args: unknown, ctx: Context) {
  const parsed = PrepareReviewContextArgsSchema.parse(args);
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const worktreeResult = await analyzeWorktrees({}, ctx);
  let headSha: string | undefined;
  let baseSha: string | undefined;
  if (parsed.subjectType === "pr") {
    const pr = await readPrRecord(g, parsed.number);
    headSha = await readMirroredPrHead(g, parsed.number);
    baseSha = pr.baseSha;
  } else {
    const issue = await readJsonFile<Record<string, unknown> | null>(
      issueRecordPath(g, parsed.number),
      null,
    );
    if (!issue) {
      throw new Error(
        `Issue ${parsed.number} is not present in the local mirror; run sync first`,
      );
    }
  }
  const selectedAt = nowIso();
  const selection = {
    repo: repoFullName(g),
    subjectType: parsed.subjectType,
    subjectNumber: parsed.number,
    headSha,
    selectedAt,
  };
  const selectionHandle = await ctx.writeResource(
    "reviewSelection",
    "review-selection-current",
    selection,
  );
  return {
    dataHandles: [...worktreeResult.dataHandles, selectionHandle],
    subject: {
      repo: selection.repo,
      subjectType: parsed.subjectType,
      number: parsed.number,
      headSha,
      baseSha,
    },
  };
}

const RecordPrAnalysisArgsSchema = z.object({
  prNumber: z.number().int().positive(),
  headSha: z.string().min(1),
  generatedAt: IsoDateTime.optional(),
  generator: z.string().min(1),
  codePathWalkthrough: z.string().min(1),
  reviewAttentionMap: z.string().min(1),
  evidenceRefs: z.array(z.string()).default([]),
});

async function recordPrAnalysis(args: unknown, ctx: Context) {
  const parsed = RecordPrAnalysisArgsSchema.parse(args);
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const pr = await readPrRecord(g, parsed.prNumber);
  const currentHeadSha = await readMirroredPrHead(g, parsed.prNumber);
  if (parsed.headSha !== currentHeadSha) {
    throw new Error(
      `stale PR analysis for #${parsed.prNumber}: requested head ${parsed.headSha} does not match current mirrored head ${currentHeadSha}`,
    );
  }
  const data = {
    repo: repoFullName(g),
    prNumber: parsed.prNumber,
    baseSha: pr.baseSha,
    headSha: parsed.headSha,
    generatedAt: parsed.generatedAt ?? nowIso(),
    generator: parsed.generator,
    sections: {
      codePathWalkthrough: parsed.codePathWalkthrough,
      reviewAttentionMap: parsed.reviewAttentionMap,
    },
    evidenceRefs: parsed.evidenceRefs,
  };
  const handle = await ctx.writeResource(
    "prAnalysisEvidence",
    safeName("pr-analysis", [parsed.prNumber, parsed.headSha]),
    data,
  );
  return { dataHandles: [handle], analysis: data };
}

/** Swamp-backed local GitHub mirror model. */
export const model = {
  type: "@evrardjp/github-local-mirror",
  version: "2026.07.23.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.17.1",
      description:
        "Initial published version with no global argument schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.07.20.1",
      description:
        "Add bounded collection metadata and pull request review context resources",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.07.21.1",
      description:
        "Correct PR review state, revision, pagination, and report selection behavior",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.07.22.1",
      description:
        "Emit one repository collection status when a bounded sync exhausts its budget",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.07.22.2",
      description:
        "Add observable cleanup for worktrees belonging to merged pull requests",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.07.23.1",
      description:
        "Keep canonical branches current when synchronizing the managed bare repository",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    mirrorState: {
      description: "Durable mirror cursors and sync state",
      schema: MirrorStateSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
    repoSnapshot: {
      description: "GitHub repository metadata snapshot",
      schema: RepoSnapshotSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    prSnapshot: {
      description:
        "Pull request snapshot with branch, state, and remote metadata",
      schema: PrSnapshotSchema,
      lifetime: "infinite",
      garbageCollection: 500,
    },
    prRevision: {
      description:
        "Observed PR head revision and local patch artifact references",
      schema: PrRevisionSchema,
      lifetime: "infinite",
      garbageCollection: 500,
    },
    prHeadState: {
      description: "Current PR head read from the fetched local Git ref",
      schema: PrHeadStateSchema,
      lifetime: "infinite",
      garbageCollection: 500,
    },
    prFileSnapshot: {
      description: "Changed file metadata for one PR revision",
      schema: PrFileSnapshotSchema,
      lifetime: "infinite",
      garbageCollection: 2000,
    },
    issueSnapshot: {
      description: "Issue snapshot",
      schema: IssueSnapshotSchema,
      lifetime: "infinite",
      garbageCollection: 1000,
    },
    activityEvent: {
      description:
        "Issue/PR comments, reviews, review comments, and timeline events",
      schema: ActivityEventSchema,
      lifetime: "infinite",
      garbageCollection: 5000,
    },
    subjectReference: {
      description: "References between mirrored GitHub subjects",
      schema: SubjectReferenceSchema,
      lifetime: "infinite",
      garbageCollection: 5000,
    },
    prCommit: {
      description: "Commit belonging to a pull request",
      schema: PrCommitSchema,
      lifetime: "infinite",
      garbageCollection: 5000,
    },
    collectionStatus: {
      description: "Completeness status for a GitHub API subcollection",
      schema: CollectionStatusSchema,
      lifetime: "infinite",
      garbageCollection: 2000,
    },
    prAnalysisEvidence: {
      description: "Generated review context tied to an exact PR head",
      schema: PrAnalysisEvidenceSchema,
      lifetime: "infinite",
      garbageCollection: 500,
    },
    reviewSelection: {
      description: "PR or issue selected for the current context report",
      schema: ReviewSelectionSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    checkRunSnapshot: {
      description: "GitHub check run status for PR heads",
      schema: CheckRunSchema,
      lifetime: "infinite",
      garbageCollection: 2000,
    },
    worktreeSnapshot: {
      description: "Registered local review worktree",
      schema: WorktreeSnapshotSchema,
      lifetime: "infinite",
      garbageCollection: 500,
    },
    worktreeAnalysis: {
      description:
        "Automated analysis of local review worktree freshness and state",
      schema: WorktreeAnalysisSchema,
      lifetime: "infinite",
      garbageCollection: 500,
    },
    worktreeCleanupRun: {
      description: "Results from one merged pull request worktree cleanup run",
      schema: WorktreeCleanupRunSchema,
      lifetime: "infinite",
      garbageCollection: 500,
    },
    syncRunSummary: {
      description: "One sync run summary",
      schema: SyncRunSummarySchema,
      lifetime: "infinite",
      garbageCollection: 500,
    },
    mirrorStatus: {
      description: "Current mirror status summary",
      schema: MirrorStatusSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    sync: {
      description:
        "Fetch GitHub refs plus full PR/issue metadata into the local mirror and Swamp index",
      arguments: z.object({
        budgetSeconds: z.number().int().positive().optional(),
      }),
      execute: syncMirror,
    },
    prepare_worktree: {
      description:
        "Create an editable local worktree for the latest mirrored PR head without calling GitHub",
      arguments: z.object({
        prNumber: z.number().int().positive(),
        identity: z.string().min(1).optional(),
      }),
      execute: prepareWorktree,
    },
    prepare_review_context: {
      description:
        "Validate a mirrored review subject and refresh local worktree evidence",
      arguments: PrepareReviewContextArgsSchema,
      execute: prepareReviewContext,
    },
    record_pr_analysis: {
      description: "Record generated review evidence for the current PR head",
      arguments: RecordPrAnalysisArgsSchema,
      execute: recordPrAnalysis,
    },
    analyze_worktrees: {
      description:
        "Analyze registered worktrees for stale PR heads, dirty state, missing paths, and local commits",
      arguments: z.object({}),
      execute: analyzeWorktrees,
    },
    close_merged_worktrees: {
      description:
        "Remove non-dirty worktrees for merged pull requests while retaining their review branches",
      arguments: z.object({}),
      execute: closeMergedWorktrees,
    },
    status: {
      description: "Write and return the current local mirror status summary",
      arguments: z.object({}),
      execute: status,
    },
  },
};
