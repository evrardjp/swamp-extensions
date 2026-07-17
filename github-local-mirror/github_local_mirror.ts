import { z } from "npm:zod@4";

const IsoDateTime = z.string().datetime({ offset: true });

const GlobalArgsSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  githubToken: z.string().min(1).optional(),
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
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
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
};
type GhComment = {
  id?: string | number;
  user?: GhUser;
  body?: string;
  html_url?: string;
  created_at?: string;
  path?: string;
};
type GhTimelineEvent = {
  id?: string | number;
  event?: string;
  actor?: GhUser;
  html_url?: string;
  state?: string;
  created_at?: string;
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
  patchHeadShort: z.string(),
  observedAt: IsoDateTime,
  gitObjectPath: z.string(),
  patchPath: z.string().optional(),
  filesPath: z.string().optional(),
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
  state: z.string().optional(),
  createdAt: z.string(),
  syncedAt: IsoDateTime,
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
  recommendedAction: z.string(),
  analyzedAt: IsoDateTime,
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
  cursorPrUpdatedAt: z.string().optional(),
  cursorIssueUpdatedAt: z.string().optional(),
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

function remoteNameForOwner(owner: string): string {
  return safeName("fork", [owner]);
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

async function gh<T>(g: GlobalArgs, path: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: githubApiHeaders(g),
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

async function ghPages<T>(
  g: GlobalArgs,
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T[]> {
  const url = new URL(`https://api.github.com${path}`);
  url.searchParams.set("per_page", "100");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const out: T[] = [];
  let next: string | undefined = url.toString();
  while (next) {
    const res = await fetch(next, { headers: githubApiHeaders(g) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `GitHub ${res.status} for ${new URL(next).pathname}: ${
          body.slice(0, 500)
        }`,
      );
    }
    out.push(...(await res.json() as T[]));
    next = parseNext(res.headers.get("link"));
  }
  return out;
}

async function runGit(
  gitObjectPath: string,
  args: string[],
): Promise<RunResult> {
  const cmd = new Deno.Command("git", {
    args: ["--git-dir", gitObjectPath, ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function runGitOk(
  gitObjectPath: string,
  args: string[],
): Promise<string> {
  const res = await runGit(gitObjectPath, args);
  if (res.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.trim()}`);
  }
  return res.stdout;
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

function statePath(g: GlobalArgs): string {
  return `${g.artifactRoot}/state.json`;
}

function prRecordPath(g: GlobalArgs, pr: number): string {
  return `${g.artifactRoot}/prs/${pr}/current.json`;
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
): Promise<void> {
  const remotes = (await runGit(g.gitObjectPath, ["remote"])).stdout.split("\n")
    .map((s) => s.trim()).filter(Boolean);
  if (remotes.includes(name)) {
    await runGitOk(g.gitObjectPath, ["remote", "set-url", name, url]);
    return;
  }
  await runGitOk(g.gitObjectPath, ["remote", "add", name, url]);
}

async function ensureGitRepo(g: GlobalArgs): Promise<void> {
  if (!await exists(g.gitObjectPath)) {
    throw new Error(
      `gitObjectPath ${g.gitObjectPath} does not exist; create it with git init --bare or provide an existing bare repo`,
    );
  }
  const originUrl = g.gitRemoteUrl ??
    `https://github.com/${g.owner}/${g.repo}.git`;
  await ensureRemote(g, g.gitRemote, originUrl);
  for (const [name, url] of Object.entries(g.knownRemotes)) {
    await ensureRemote(g, name, url);
  }
}

async function fetchGit(g: GlobalArgs): Promise<void> {
  await ensureGitRepo(g);
  await runGitOk(g.gitObjectPath, [
    "fetch",
    "--prune",
    g.gitRemote,
    "+refs/heads/*:refs/remotes/origin/*",
    "+refs/tags/*:refs/tags/*",
    "+refs/pull/*/head:refs/remotes/pull/*/head",
    "+refs/pull/*/merge:refs/remotes/pull/*/merge",
  ]);
}

async function exportPatch(
  g: GlobalArgs,
  prNumber: number,
  baseSha: string | undefined,
  headSha: string | undefined,
): Promise<string | undefined> {
  if (!baseSha || !headSha) return undefined;
  const dir = `${g.artifactRoot}/prs/${prNumber}/revisions/${headSha}`;
  const patchPath = `${dir}/pr.patch`;
  if (await exists(patchPath)) return patchPath;
  const diff = await runGit(g.gitObjectPath, [
    "diff",
    `${baseSha}...${headSha}`,
  ]);
  if (diff.code !== 0) return undefined;
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

async function syncIssueDetails(
  ctx: Context,
  issue: GhIssue,
  eventCount: { value: number },
): Promise<unknown[]> {
  const g = ctx.globalArgs;
  const repo = repoFullName(g);
  const handles: unknown[] = [];
  const syncedAt = nowIso();
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
        labels,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        closedAt: issue.closed_at,
        syncedAt,
      },
    ),
  );
  const comments = await ghPages<GhComment>(
    g,
    `/repos/${g.owner}/${g.repo}/issues/${issue.number}/comments`,
  );
  for (const c of comments) {
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
  }
  const timeline = await ghPages<GhTimelineEvent>(
    g,
    `/repos/${g.owner}/${g.repo}/issues/${issue.number}/timeline`,
  ).catch(() => []);
  for (const [index, e] of timeline.entries()) {
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
          createdAt: e.created_at,
          syncedAt,
        },
      ),
    );
  }
  return handles;
}

async function syncPrDetails(
  ctx: Context,
  listPr: GhPr,
  counters: { eventCount: number; checkRunCount: number },
): Promise<unknown[]> {
  const g = ctx.globalArgs;
  const repo = repoFullName(g);
  const handles: unknown[] = [];
  const pr = await gh<GhPr>(
    g,
    `/repos/${g.owner}/${g.repo}/pulls/${listPr.number}`,
  );
  const syncedAt = nowIso();
  const headOwner = pr.head?.repo?.owner?.login;
  const remoteName = headOwner ? remoteNameForOwner(headOwner) : undefined;
  if (remoteName && pr.head?.repo?.ssh_url) {
    await ensureRemote(g, remoteName, pr.head.repo.ssh_url).catch(() =>
      undefined
    );
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
  };
  await writeJsonFile(prRecordPath(g, pr.number), prRecord);
  handles.push(
    await ctx.writeResource("prSnapshot", safeName("pr", [pr.number]), {
      repo,
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
  const patchPath = await exportPatch(g, pr.number, pr.base?.sha, pr.head?.sha);
  const files = await ghPages<GhFile>(
    g,
    `/repos/${g.owner}/${g.repo}/pulls/${pr.number}/files`,
  );
  const filesPath = `${g.artifactRoot}/prs/${pr.number}/revisions/${
    pr.head?.sha ?? "unknown"
  }/files.json`;
  await writeJsonFile(filesPath, files);
  if (pr.head?.sha) {
    handles.push(
      await ctx.writeResource(
        "prRevision",
        safeName("pr-revision", [pr.number, pr.head.sha]),
        {
          repo,
          prNumber: pr.number,
          baseSha: pr.base?.sha,
          headSha: pr.head.sha,
          patchHeadShort: shortSha(pr.head.sha),
          observedAt: syncedAt,
          gitObjectPath: g.gitObjectPath,
          patchPath,
          filesPath,
        },
      ),
    );
  }
  for (const f of files) {
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
  const reviews = await ghPages<GhReview>(
    g,
    `/repos/${g.owner}/${g.repo}/pulls/${pr.number}/reviews`,
  );
  for (const r of reviews) {
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
          createdAt: r.submitted_at ?? pr.updated_at,
          syncedAt,
        },
      ),
    );
  }
  const reviewComments = await ghPages<GhComment>(
    g,
    `/repos/${g.owner}/${g.repo}/pulls/${pr.number}/comments`,
  );
  for (const c of reviewComments) {
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
          createdAt: c.created_at,
          syncedAt,
        },
      ),
    );
  }
  const issueComments = await ghPages<GhComment>(
    g,
    `/repos/${g.owner}/${g.repo}/issues/${pr.number}/comments`,
  );
  for (const c of issueComments) {
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
  }
  const timeline = await ghPages<GhTimelineEvent>(
    g,
    `/repos/${g.owner}/${g.repo}/issues/${pr.number}/timeline`,
  ).catch(() => []);
  for (const [index, e] of timeline.entries()) {
    if (!e.created_at) continue;
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
          createdAt: e.created_at,
          syncedAt,
        },
      ),
    );
  }
  if (pr.head?.sha) {
    const checks = await gh<GhCheckRuns>(
      g,
      `/repos/${g.owner}/${g.repo}/commits/${pr.head.sha}/check-runs?per_page=100`,
    ).catch(() => ({ check_runs: [] }));
    for (const check of checks.check_runs ?? []) {
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
  return handles;
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
  const startedAt = nowIso();
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
  try {
    await fetchGit(g);
    gitFetched = true;
    const repo = await gh<GhRepo>(g, `/repos/${g.owner}/${g.repo}`);
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
    const prs = await ghPages<GhPr>(g, `/repos/${g.owner}/${g.repo}/pulls`, {
      state: "all",
      sort: "updated",
      direction: "desc",
    });
    const selectedPrs = since
      ? prs.filter((p) => (p.updated_at ?? "") >= since)
      : prs;
    let maxPrUpdated = state.cursor.lastPrUpdatedAt;
    for (const pr of selectedPrs) {
      prCount++;
      if (pr.updated_at && (!maxPrUpdated || pr.updated_at > maxPrUpdated)) {
        maxPrUpdated = pr.updated_at;
      }
      handles.push(...await syncPrDetails(ctx, pr, counters));
      if (
        args.budgetSeconds &&
        Date.now() - Date.parse(startedAt) > args.budgetSeconds * 1000
      ) break;
    }
    const issues =
      (await ghPages<GhIssue>(g, `/repos/${g.owner}/${g.repo}/issues`, {
        state: "all",
        since,
      })).filter((i) => !i.pull_request);
    let maxIssueUpdated = state.cursor.lastIssueUpdatedAt;
    for (const issue of issues) {
      issueCount++;
      if (
        issue.updated_at &&
        (!maxIssueUpdated || issue.updated_at > maxIssueUpdated)
      ) {
        maxIssueUpdated = issue.updated_at;
      }
      handles.push(...await syncIssueDetails(ctx, issue, issueEventCount));
      if (
        args.budgetSeconds &&
        Date.now() - Date.parse(startedAt) > args.budgetSeconds * 1000
      ) break;
    }
    const finishedAt = nowIso();
    state.cursor.lastSuccessfulSyncAt = finishedAt;
    state.cursor.lastPrUpdatedAt = maxPrUpdated;
    state.cursor.lastIssueUpdatedAt = maxIssueUpdated;
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
        cursorPrUpdatedAt: state.cursor.lastPrUpdatedAt,
        cursorIssueUpdatedAt: state.cursor.lastIssueUpdatedAt,
      }),
    );
    return { dataHandles: handles };
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

async function readWorktrees(g: GlobalArgs): Promise<WorktreeRecord[]> {
  return await readJsonFile<WorktreeRecord[]>(worktreeIndexPath(g), []);
}

async function writeWorktrees(
  g: GlobalArgs,
  records: WorktreeRecord[],
): Promise<void> {
  await writeJsonFile(worktreeIndexPath(g), records);
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
  const headSha = pr.headSha!;
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

async function analyzeWorktrees(_args: Record<string, never>, ctx: Context) {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const records = await readWorktrees(g);
  const handles: unknown[] = [];
  const analyzedAt = nowIso();
  for (const record of records) {
    const pr = await readJsonFile<PrRecord | null>(
      prRecordPath(g, record.prNumber),
      null,
    );
    const missing = !await exists(record.path);
    let isDirty = false;
    let aheadCommitCount = 0;
    if (!missing) {
      const status = await gitInWorktree(record.path, [
        "status",
        "--porcelain",
      ]);
      isDirty = status.stdout.trim().length > 0;
      const ahead = await gitInWorktree(record.path, [
        "rev-list",
        "--count",
        `${record.baseHeadSha}..HEAD`,
      ]);
      aheadCommitCount = ahead.code === 0
        ? Number(ahead.stdout.trim() || "0")
        : 0;
    }
    const latest = pr?.headSha;
    const isPrHeadStale = Boolean(latest && latest !== record.baseHeadSha);
    const recommendedAction = missing
      ? "remove-or-recreate-worktree-record"
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
        recommendedAction,
        analyzedAt,
      }),
    );
  }
  return { dataHandles: handles };
}

async function status(_args: Record<string, never>, ctx: Context) {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const state = await readState(g);
  const worktrees = await readWorktrees(g);
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

/** Swamp-backed local GitHub mirror model. */
export const model = {
  type: "@evrardjp/github-local-mirror",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.17.1",
      description:
        "Initial published version with no global argument schema changes",
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
    syncRunSummary: {
      description: "One sync run summary",
      schema: SyncRunSummarySchema,
      lifetime: "infinite",
      garbageCollection: 500,
    },
    mirrorStatus: {
      description: "Current mirror status summary",
      schema: z.object({}).passthrough(),
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
    analyze_worktrees: {
      description:
        "Analyze registered worktrees for stale PR heads, dirty state, missing paths, and local commits",
      arguments: z.object({}),
      execute: analyzeWorktrees,
    },
    status: {
      description: "Write and return the current local mirror status summary",
      arguments: z.object({}),
      execute: status,
    },
  },
};
