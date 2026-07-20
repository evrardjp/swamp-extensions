type DataEntry = {
  name: string;
  version?: number;
  tags?: Record<string, string>;
  metadata?: { tags?: Record<string, string> };
};

type ReportContext = {
  modelType?: { normalized?: string } | string;
  modelId?: string;
  definition?: { id?: string; name?: string };
  globalArgs?: Record<string, unknown>;
  methodArgs?: Record<string, unknown>;
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

type SubjectType = "pr" | "issue";
type Subject = { type: SubjectType; number: number };
type Value = Record<string, unknown>;
type StoredValue = Value & { _dataName: string; _dataVersion: number };
type TriState = "yes" | "no" | "unknown";

const EXPECTED_SPECS = new Set([
  "prSnapshot",
  "issueSnapshot",
  "activityEvent",
  "subjectReference",
  "prRevision",
  "prHeadState",
  "prCommit",
  "prFileSnapshot",
  "checkRunSnapshot",
  "collectionStatus",
  "worktreeAnalysis",
  "prAnalysisEvidence",
  "mirrorState",
  "syncRunSummary",
]);

function normalizedType(value: ReportContext["modelType"]): string {
  if (typeof value === "string") return value;
  return value?.normalized ?? "";
}

function tagsOf(entry: DataEntry): Record<string, string> {
  return entry.tags ?? entry.metadata?.tags ?? {};
}

function numberField(value: Value, field: string): number | undefined {
  const number = Number(value[field]);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function stringField(value: Value, field: string): string {
  return typeof value[field] === "string" ? value[field] as string : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function subjectKey(type: SubjectType, number: number): string {
  return `${type}:${number}`;
}

function subjectOf(value: Value): Subject | undefined {
  const type = value.subjectType;
  const number = numberField(value, "subjectNumber");
  return (type === "pr" || type === "issue") && number
    ? { type, number }
    : undefined;
}

function repoName(context: ReportContext): string {
  const owner = String(context.globalArgs?.owner ?? "").trim();
  const repo = String(context.globalArgs?.repo ?? "").trim();
  return owner && repo ? `${owner}/${repo}` : "";
}

function md(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function inlineCode(value: unknown): string {
  const text = String(value ?? "").replace(/\r?\n/g, " ");
  const runs = text.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(1, ...runs.map((run) => run.length + 1)));
  return `${fence}${text}${fence}`;
}

function shellQuote(value: unknown): string {
  return `'${String(value ?? "").replace(/'/g, `'"'"'`)}'`;
}

function isGitOid(value: string): boolean {
  return /^[0-9a-f]{40,64}$/i.test(value);
}

function fencedBody(body: unknown): string {
  const text = String(body ?? "");
  const runs = text.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${fence}text\n${text}\n${fence}`;
}

function iso(value: unknown): string {
  return typeof value === "string" && value ? value : "unknown";
}

function collectionComplete(
  statuses: StoredValue[],
  subject: Subject,
  aliases: string[],
): boolean | undefined {
  const matching = statuses.filter((status) => {
    const statusType = status.subjectType;
    const statusNumber = numberField(status, "subjectNumber");
    if (statusType && statusType !== subject.type) return false;
    if (statusNumber && statusNumber !== subject.number) return false;
    const scope = stringField(status, "scope").toLowerCase();
    if (
      scope && ![
        "all",
        "repo",
        subject.type,
        `${subject.type}:${subject.number}`,
        `${subject.type}-${subject.number}`,
      ].includes(scope)
    ) return false;
    return aliases.includes(stringField(status, "component").toLowerCase());
  });
  if (!matching.length) return undefined;
  return matching.every((status) => status.complete === true);
}

function aggregate(values: TriState[]): TriState {
  if (values.includes("yes")) return "yes";
  if (values.length && values.every((value) => value === "no")) return "no";
  return "unknown";
}

function readinessForPr(
  prNumber: number,
  pr: StoredValue | undefined,
  checks: StoredValue[],
  events: StoredValue[],
  statuses: StoredValue[],
  clarificationLabels: string[],
): Record<string, TriState> {
  const subject: Subject = { type: "pr", number: prNumber };
  const snapshotComplete = collectionComplete(
    statuses,
    subject,
    ["pr", "prs", "snapshot", "prsnapshot", "metadata"],
  );
  const checksComplete = collectionComplete(
    statuses,
    subject,
    ["check", "checks", "checkrun", "checkruns", "checkrunsnapshot", "ci"],
  );
  const activityComplete = collectionComplete(
    statuses,
    subject,
    ["activity", "events", "activityevent", "reviews", "timeline"],
  );
  const snapshotKnown = Boolean(pr) && snapshotComplete === true;
  const isDraft: TriState = snapshotKnown
    ? (pr?.draft === true ? "yes" : pr?.draft === false ? "no" : "unknown")
    : "unknown";
  const currentHead = stringField(pr ?? {}, "headSha");
  const currentChecks = checks.filter((check) =>
    numberField(check, "prNumber") === prNumber &&
    (!currentHead || !check.headSha || check.headSha === currentHead)
  );
  const badConclusions = new Set([
    "failure",
    "cancelled",
    "timed_out",
    "action_required",
    "startup_failure",
    "stale",
  ]);
  const ci: TriState = checksComplete !== true || !snapshotKnown
    ? "unknown"
    : currentChecks.some((check) =>
        badConclusions.has(stringField(check, "conclusion").toLowerCase())
      )
    ? "yes"
    : currentChecks.some((check) =>
        stringField(check, "status").toLowerCase() !== "completed" ||
        !stringField(check, "conclusion")
      )
    ? "unknown"
    : "no";
  const prEvents = events.filter((event) =>
    event.subjectType === "pr" &&
    numberField(event, "subjectNumber") === prNumber
  );
  const latestReviews = new Map<string, StoredValue>();
  const reviewActors = new Map<string, string>();
  for (
    const event of prEvents.filter((candidate) =>
      stringField(candidate, "eventType").toLowerCase().includes("review")
    ).sort((a, b) => iso(a.createdAt).localeCompare(iso(b.createdAt)))
  ) {
    const eventType = stringField(event, "eventType").toLowerCase();
    const actor = stringField(event, "actor") || event._dataName;
    const reviewId = stringField(event, "githubId");
    if (eventType.includes("dismissed")) {
      const payload = event.payload as Value | undefined;
      const dismissed = payload?.dismissed_review as Value | undefined;
      const dismissedId = String(dismissed?.review_id ?? "");
      const dismissedActor = reviewActors.get(dismissedId);
      if (
        dismissedActor &&
        stringField(latestReviews.get(dismissedActor) ?? {}, "githubId") ===
          dismissedId
      ) {
        latestReviews.delete(dismissedActor);
      }
      continue;
    }
    if (!stringField(event, "state")) continue;
    latestReviews.set(actor, event);
    if (reviewId) reviewActors.set(reviewId, actor);
  }
  const changeRequest = activityComplete !== true
    ? "unknown"
    : stringArray(pr?.reviewersRequestingChanges).length > 0 ||
        stringField(pr ?? {}, "reviewDecision").toLowerCase() ===
          "changes_requested" ||
        [...latestReviews.values()].some((event) => {
          const state = stringField(event, "state").toLowerCase();
          const eventType = stringField(event, "eventType").toLowerCase();
          return state === "changes_requested" ||
            eventType.includes("changes_requested");
        })
    ? "yes"
    : "no";
  const labels = stringArray(pr?.labels).map((label) => label.toLowerCase());
  const clarification = !snapshotKnown
    ? "unknown"
    : labels.some((label) => clarificationLabels.includes(label))
    ? "yes"
    : "no";
  return {
    "Is Draft": isDraft,
    "Needs CI fixes": ci,
    "Changes requested by reviewer": changeRequest,
    "Needs clarification": clarification,
  };
}

function overallReadiness(signals: Record<string, TriState>): string {
  const values = Object.values(signals);
  if (values.includes("yes")) return "Not Ready";
  if (values.length && values.every((value) => value === "no")) return "Ready";
  return "Unknown";
}

function referenceEndpoint(
  reference: Value,
  side: "source" | "target",
): Subject | undefined {
  const type = reference[`${side}Type`];
  const number = numberField(reference, `${side}Number`);
  return (type === "pr" || type === "issue") && number
    ? { type, number }
    : undefined;
}

function isLocalReference(reference: Value, localRepo: string): boolean {
  return reference.external !== true &&
    (!reference.targetRepo || reference.targetRepo === localRepo);
}

function buildCluster(
  primary: Subject,
  references: StoredValue[],
  localRepo: string,
): Set<string> {
  const cluster = new Set([subjectKey(primary.type, primary.number)]);
  const local = references.filter((reference) =>
    isLocalReference(reference, localRepo)
  );
  const addOther = (reference: Value, key: string, wanted: SubjectType) => {
    const source = referenceEndpoint(reference, "source");
    const target = referenceEndpoint(reference, "target");
    if (
      source && subjectKey(source.type, source.number) === key &&
      target?.type === wanted
    ) {
      cluster.add(subjectKey(target.type, target.number));
    }
    if (
      target && subjectKey(target.type, target.number) === key &&
      source?.type === wanted
    ) {
      cluster.add(subjectKey(source.type, source.number));
    }
  };
  if (primary.type === "pr") {
    const primaryKey = subjectKey("pr", primary.number);
    for (const reference of local) addOther(reference, primaryKey, "issue");
    const issueKeys = [...cluster].filter((key) => key.startsWith("issue:"));
    for (const issueKey of issueKeys) {
      for (const reference of local) addOther(reference, issueKey, "pr");
    }
  } else {
    const issueKey = subjectKey("issue", primary.number);
    for (const reference of local) addOther(reference, issueKey, "pr");
  }
  return cluster;
}

function gitCommand(gitObjectPath: string, args: string): string {
  return `git --git-dir=${shellQuote(gitObjectPath)} ${args}`;
}

function timelineItems(
  cluster: Set<string>,
  prs: StoredValue[],
  issues: StoredValue[],
  events: StoredValue[],
  revisions: StoredValue[],
  commits: StoredValue[],
  granularity: "observed-push" | "commit",
  gitObjectPath: string,
): Value[] {
  const items: Value[] = [];
  for (const snapshot of [...prs, ...issues]) {
    const type: SubjectType = numberField(snapshot, "prNumber")
      ? "pr"
      : prs.includes(snapshot)
      ? "pr"
      : "issue";
    const number = numberField(snapshot, "number");
    if (!number || !cluster.has(subjectKey(type, number))) continue;
    items.push({
      kind: "opening",
      subjectType: type,
      subjectNumber: number,
      createdAt: snapshot.createdAt,
      title: snapshot.title,
      body: snapshot.body,
      url: snapshot.url,
      actor: snapshot.author,
    });
  }
  for (const event of events) {
    const subject = subjectOf(event);
    if (subject && cluster.has(subjectKey(subject.type, subject.number))) {
      const commitSha = stringField(event, "commitSha");
      const filePath = stringField(event, "filePath");
      items.push({
        kind: "activity",
        ...event,
        command: isGitOid(commitSha)
          ? gitCommand(
            gitObjectPath,
            `show ${shellQuote(commitSha)}${
              filePath ? ` -- ${shellQuote(filePath)}` : ""
            }`,
          )
          : undefined,
      });
    }
  }
  if (granularity === "commit") {
    for (const commit of commits) {
      const number = numberField(commit, "prNumber");
      const sha = stringField(commit, "sha");
      if (!number || !cluster.has(subjectKey("pr", number))) continue;
      items.push({
        kind: "commit",
        subjectType: "pr",
        subjectNumber: number,
        createdAt: commit.committedAt ?? commit.authoredAt,
        command: isGitOid(sha)
          ? gitCommand(gitObjectPath, `show ${shellQuote(sha)}`)
          : undefined,
        ...commit,
      });
    }
  } else {
    for (const revision of revisions) {
      const number = numberField(revision, "prNumber");
      const head = stringField(revision, "headSha");
      const previous = stringField(revision, "previousHeadSha");
      const base = stringField(revision, "baseSha");
      if (!number || !cluster.has(subjectKey("pr", number))) continue;
      items.push({
        kind: "revision",
        subjectType: "pr",
        subjectNumber: number,
        createdAt: revision.observedAt,
        command: isGitOid(head) && (!previous || isGitOid(previous)) &&
            (!base || isGitOid(base))
          ? gitCommand(
            gitObjectPath,
            previous || base
              ? `diff ${shellQuote(`${previous || base}..${head}`)}`
              : `show ${shellQuote(head)}`,
          )
          : undefined,
        ...revision,
      });
    }
  }
  return items.sort((a, b) => iso(a.createdAt).localeCompare(iso(b.createdAt)));
}

function renderTimeline(items: Value[]): string[] {
  const lines: string[] = [];
  for (const item of items) {
    lines.push(
      `### ${iso(item.createdAt)} - ${md(item.subjectType)} #${
        md(item.subjectNumber)
      } - ${md(item.kind)}`,
      "",
    );
    if (item.title) lines.push(`**${md(item.title)}**`, "");
    if (item.summary) lines.push(fencedBody(item.summary), "");
    if (item.message) lines.push(fencedBody(item.message), "");
    if (item.url) lines.push(`URL: ${md(item.url)}`, "");
    if (item.filePath) {
      lines.push(
        `Location: ${inlineCode(item.filePath)}${
          item.line ? `:${item.line}` : ""
        }`,
        "",
      );
    }
    if (item.body !== undefined) lines.push(fencedBody(item.body), "");
    if (item.payload && typeof item.payload === "object") {
      lines.push(fencedBody(JSON.stringify(item.payload, null, 2)), "");
    }
    const changedFiles = Array.isArray(item.changedFiles)
      ? item.changedFiles.filter((file): file is Value =>
        Boolean(file) && typeof file === "object" && !Array.isArray(file)
      )
      : [];
    if (changedFiles.length) {
      lines.push(
        "| Status | Path | Previous path | + | - |",
        "| --- | --- | --- | ---: | ---: |",
      );
      for (const file of changedFiles) {
        lines.push(
          `| ${md(file.status)} | ${inlineCode(file.path)} | ${
            file.previousPath ? inlineCode(file.previousPath) : ""
          } | ${md(file.additions ?? "")} | ${md(file.deletions ?? "")} |`,
        );
      }
      lines.push("");
    }
    if (item.command) lines.push("```sh", String(item.command), "```", "");
  }
  if (!items.length) lines.push("_No timeline entries were collected._", "");
  return lines;
}

/** Model-scope report for an issue-centered GitHub PR/issue context dossier. */
export const report = {
  name: "@evrardjp/github-pr-context",
  description:
    "Render a complete local-mirror PR or issue context cluster, readiness, timeline, worktree state, and analysis evidence.",
  scope: "model" as const,
  execute: async (context: ReportContext) => {
    if (normalizedType(context.modelType) !== "@evrardjp/github-local-mirror") {
      return { markdown: "", json: {} };
    }
    const subjectType = context.methodArgs?.subjectType;
    const number = Number(context.methodArgs?.number);
    if (
      (subjectType !== "pr" && subjectType !== "issue") ||
      !Number.isInteger(number) || number <= 0
    ) {
      return {
        markdown:
          "# GitHub PR Context\n\n`methodArgs.subjectType` (`pr` or `issue`) and a positive `methodArgs.number` are required.\n",
        json: { error: "invalid-subject" },
      };
    }
    const modelId = context.modelId ?? context.definition?.id;
    if (!modelId || !context.dataRepository) {
      return {
        markdown:
          "# GitHub PR Context\n\nNo Swamp data repository is available.\n",
        json: { error: "missing-data-repository" },
      };
    }

    const allEntries = await context.dataRepository.findAllForModel(
      context.modelType,
      modelId,
    );
    const latestEntries = new Map<string, DataEntry>();
    for (const entry of allEntries) {
      const current = latestEntries.get(entry.name);
      if (!current || (entry.version ?? 0) > (current.version ?? 0)) {
        latestEntries.set(entry.name, entry);
      }
    }
    const bySpec = new Map<string, StoredValue[]>();
    const dataErrors: Value[] = [];
    for (const entry of latestEntries.values()) {
      const specName = tagsOf(entry).specName;
      if (!specName || !EXPECTED_SPECS.has(specName)) continue;
      try {
        const bytes = await context.dataRepository.getContent(
          context.modelType,
          modelId,
          entry.name,
          entry.version,
        );
        if (!bytes) throw new Error("content is missing");
        const value = JSON.parse(new TextDecoder().decode(bytes));
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("content is not an object");
        }
        const stored = {
          ...value as Value,
          _dataName: entry.name,
          _dataVersion: entry.version ?? 0,
        };
        bySpec.set(specName, [...(bySpec.get(specName) ?? []), stored]);
      } catch (error) {
        dataErrors.push({
          dataName: entry.name,
          version: entry.version,
          specName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const values = (spec: string) => bySpec.get(spec) ?? [];
    const repo = repoName(context) ||
      stringField(values("mirrorState")[0] ?? {}, "repo");
    const primary: Subject = { type: subjectType, number };
    const headStates = values("prHeadState");
    const headByPr = new Map<number, StoredValue>();
    for (const head of headStates) {
      const prNumber = numberField(head, "prNumber");
      if (prNumber) headByPr.set(prNumber, head);
    }
    const allPrs = values("prSnapshot").map((pr) => {
      const prNumber = numberField(pr, "number");
      const authoritativeHead = prNumber ? headByPr.get(prNumber) : undefined;
      return authoritativeHead
        ? { ...pr, headSha: authoritativeHead.headSha }
        : pr;
    });
    const allIssues = values("issueSnapshot");
    const snapshots = new Map<string, StoredValue>();
    for (const snapshot of allPrs) {
      const snapshotNumber = numberField(snapshot, "number");
      if (snapshotNumber) {
        snapshots.set(subjectKey("pr", snapshotNumber), snapshot);
      }
    }
    for (const snapshot of allIssues) {
      const snapshotNumber = numberField(snapshot, "number");
      if (snapshotNumber) {
        snapshots.set(subjectKey("issue", snapshotNumber), snapshot);
      }
    }
    const references = values("subjectReference").filter((reference) => {
      const source = referenceEndpoint(reference, "source");
      if (!source) return false;
      const sourceSnapshot = snapshots.get(
        subjectKey(source.type, source.number),
      );
      if (!sourceSnapshot) return false;
      const referenceSync = stringField(reference, "syncedAt");
      const snapshotSync = stringField(sourceSnapshot ?? {}, "syncedAt");
      return !referenceSync || !snapshotSync || referenceSync === snapshotSync;
    }).map((reference) => {
      if (reference.targetType !== "unknown") return reference;
      const targetNumber = numberField(reference, "targetNumber");
      if (!targetNumber || reference.targetRepo !== repo) return reference;
      const issueExists = snapshots.has(subjectKey("issue", targetNumber));
      const prExists = snapshots.has(subjectKey("pr", targetNumber));
      if (issueExists === prExists) return reference;
      return { ...reference, targetType: issueExists ? "issue" : "pr" };
    });
    const cluster = buildCluster(primary, references, repo);
    const prs = allPrs.filter((pr) => {
      const prNumber = numberField(pr, "number");
      return prNumber && cluster.has(subjectKey("pr", prNumber));
    });
    const issues = allIssues.filter((issue) => {
      const issueNumber = numberField(issue, "number");
      return issueNumber && cluster.has(subjectKey("issue", issueNumber));
    });
    const events = values("activityEvent").filter((event) => {
      const subject = subjectOf(event);
      return subject && cluster.has(subjectKey(subject.type, subject.number));
    });
    const revisions = values("prRevision").filter((revision) => {
      const prNumber = numberField(revision, "prNumber");
      return prNumber && cluster.has(subjectKey("pr", prNumber));
    });
    const commits = values("prCommit").filter((commit) => {
      const prNumber = numberField(commit, "prNumber");
      return prNumber && cluster.has(subjectKey("pr", prNumber));
    });
    const files = values("prFileSnapshot").filter((file) => {
      const prNumber = numberField(file, "prNumber");
      const pr = prs.find((candidate) =>
        numberField(candidate, "number") === prNumber
      );
      return prNumber && cluster.has(subjectKey("pr", prNumber)) &&
        (!pr?.headSha || !file.headSha || file.headSha === pr.headSha);
    });
    const checks = values("checkRunSnapshot").filter((check) => {
      const prNumber = numberField(check, "prNumber");
      return prNumber && cluster.has(subjectKey("pr", prNumber));
    });
    const worktrees = values("worktreeAnalysis").filter((worktree) => {
      const prNumber = numberField(worktree, "prNumber");
      return prNumber && cluster.has(subjectKey("pr", prNumber));
    });
    const statuses = values("collectionStatus").filter((status) => {
      const statusSubject = subjectOf(status);
      return !statusSubject ||
        cluster.has(subjectKey(statusSubject.type, statusSubject.number));
    });
    const clarificationLabels = stringArray(
      context.globalArgs?.needsClarificationLabels,
    ).map((label) => label.toLowerCase());
    const perPrReadiness = Object.fromEntries(prs.map((pr) => {
      const prNumber = numberField(pr, "number")!;
      return [
        String(prNumber),
        readinessForPr(
          prNumber,
          pr,
          checks,
          events,
          statuses,
          clarificationLabels,
        ),
      ];
    }));
    if (primary.type === "pr" && !perPrReadiness[String(primary.number)]) {
      perPrReadiness[String(primary.number)] = readinessForPr(
        primary.number,
        undefined,
        checks,
        events,
        statuses,
        clarificationLabels,
      );
    }
    const aggregatedReadinessSignals = Object.fromEntries([
      "Is Draft",
      "Needs CI fixes",
      "Changes requested by reviewer",
      "Needs clarification",
    ].map((signal) => [
      signal,
      aggregate(
        Object.values(perPrReadiness).map((entry) =>
          (entry as Record<string, TriState>)[signal]
        ),
      ),
    ])) as Record<string, TriState>;
    let readinessSignals = primary.type === "pr"
      ? perPrReadiness[String(primary.number)] ?? aggregatedReadinessSignals
      : aggregatedReadinessSignals;
    const granularity = context.globalArgs?.timelineCodeGranularity === "commit"
      ? "commit"
      : "observed-push";
    const mirrorState = values("mirrorState")[0];
    const latestSync =
      values("syncRunSummary").sort((a, b) =>
        iso(b.finishedAt).localeCompare(iso(a.finishedAt))
      )[0];
    if (latestSync && latestSync.complete !== true) {
      readinessSignals = Object.fromEntries(
        Object.entries(readinessSignals).map(([signal, state]) => [
          signal,
          state === "no" ? "unknown" : state,
        ]),
      ) as Record<string, TriState>;
    }
    const readiness = overallReadiness(readinessSignals);
    const gitObjectPath = stringField(mirrorState ?? {}, "gitObjectPath") ||
      String(context.globalArgs?.gitObjectPath ?? "<git-object-path>");
    const timeline = timelineItems(
      cluster,
      prs,
      issues,
      events,
      revisions,
      commits,
      granularity,
      gitObjectPath,
    );
    const primaryPr = primary.type === "pr"
      ? prs.find((pr) => numberField(pr, "number") === primary.number)
      : undefined;
    const evidence = primaryPr
      ? values("prAnalysisEvidence").find((item) =>
        numberField(item, "prNumber") === primary.number &&
        stringField(item, "headSha") === stringField(primaryPr, "headSha")
      )
      : undefined;
    const staleEvidence = primary.type === "pr"
      ? values("prAnalysisEvidence").filter((item) =>
        numberField(item, "prNumber") === primary.number && item !== evidence
      )
      : [];
    const externalReferences = references.filter((reference) =>
      reference.external === true ||
      (reference.targetRepo && reference.targetRepo !== repo)
    ).filter((reference) => {
      const source = referenceEndpoint(reference, "source");
      return source && cluster.has(subjectKey(source.type, source.number));
    });
    const relevantReferences = references.filter((reference) => {
      const source = referenceEndpoint(reference, "source");
      const target = referenceEndpoint(reference, "target");
      return Boolean(
        source && cluster.has(subjectKey(source.type, source.number)) ||
          target && cluster.has(subjectKey(target.type, target.number)),
      );
    });
    const collectionErrors = statuses.filter((status) =>
      status.complete !== true || Boolean(status.error)
    ).map((status) => ({
      component: status.component,
      subjectType: status.subjectType,
      subjectNumber: status.subjectNumber,
      error: status.error ?? "collection is incomplete",
    }));
    const latestSyncErrors = Array.isArray(latestSync?.errors)
      ? latestSync.errors.filter((error): error is Value =>
        Boolean(error) && typeof error === "object" && !Array.isArray(error)
      )
      : [];
    const timelineCompleteness = [...cluster].map((key) => {
      const [type, rawNumber] = key.split(":");
      const subject = { type: type as SubjectType, number: Number(rawNumber) };
      const activity = collectionComplete(
        statuses,
        subject,
        ["activity", "events", "activityevent", "reviews", "timeline"],
      );
      if (subject.type !== "pr" || granularity !== "commit") return activity;
      const commit = collectionComplete(
        statuses,
        subject,
        ["prcommit", "commits"],
      );
      return activity === false || commit === false
        ? false
        : activity === true && commit === true
        ? true
        : undefined;
    });
    const timelineComplete = latestSync && latestSync.complete !== true ||
        timelineCompleteness.includes(false)
      ? false
      : timelineCompleteness.length > 0 &&
          timelineCompleteness.every((value) => value === true)
      ? true
      : null;
    const freshness = {
      mirrorUpdatedAt: mirrorState?.updatedAt ?? null,
      lastSuccessfulGithubSync: (mirrorState?.cursor as Value | undefined)
        ?.lastSuccessfulSyncAt ?? null,
      lastGithubAttemptFinishedAt: latestSync?.githubFinishedAt ?? null,
      lastGitFetchFinishedAt: latestSync?.gitFetchFinishedAt ?? null,
      subjectSyncedAt: primaryPr?.syncedAt ??
        issues.find((issue) => numberField(issue, "number") === primary.number)
          ?.syncedAt ??
        null,
      collectionStatuses: statuses,
      timelineComplete,
      errors: [...latestSyncErrors, ...collectionErrors, ...dataErrors],
    };

    const lines: string[] = [
      `# GitHub ${
        primary.type === "pr" ? "PR" : "Issue"
      } Context: ${repo}#${primary.number}`,
      "",
      `Readiness: **${readiness}**`,
      "",
      "## Readiness",
      "",
      "| Signal | State |",
      "| --- | --- |",
      ...Object.entries(readinessSignals).map(([signal, state]) =>
        `| ${signal} | ${state} |`
      ),
      "",
      "## Subject Cluster",
      "",
      "| Type | Number | Title | State | URL |",
      "| --- | ---: | --- | --- | --- |",
      ...[
        ...prs.map((value) => ({ type: "pr", value })),
        ...issues.map((value) => ({ type: "issue", value })),
      ]
        .sort((a, b) =>
          String(a.type).localeCompare(String(b.type)) ||
          Number(a.value.number) - Number(b.value.number)
        ).map(({ type, value }) =>
          `| ${type} | ${md(value.number)} | ${md(value.title)} | ${
            md(value.state)
          } | ${md(value.url)} |`
        ),
      "",
    ];
    for (
      const { type, value } of [
        ...prs.map((value) => ({ type: "PR", value })),
        ...issues.map((value) => ({ type: "Issue", value })),
      ]
    ) {
      lines.push(
        `### ${type} #${md(value.number)} body`,
        "",
        fencedBody(value.body),
        "",
      );
    }
    lines.push("## External References", "");
    if (!externalReferences.length) lines.push("_None._", "");
    for (const reference of externalReferences) {
      lines.push(
        `- Unresolved external reference: ${
          String(reference.url ?? "URL unavailable")
        }`,
      );
    }
    if (externalReferences.length) lines.push("");
    lines.push(
      "## Changed Files",
      "",
      "| PR | Head | Path | Status | + | - |",
      "| ---: | --- | --- | --- | ---: | ---: |",
    );
    if (!files.length) {
      lines.push("|  |  | _No current changed-file snapshots._ |  |  |  |");
    }
    for (
      const file of files.sort((a, b) =>
        Number(a.prNumber) - Number(b.prNumber) ||
        stringField(a, "path").localeCompare(stringField(b, "path"))
      )
    ) {
      lines.push(
        `| ${md(file.prNumber)} | ${md(file.headSha)} | ${
          inlineCode(file.path)
        } | ${md(file.status)} | ${md(file.additions ?? 0)} | ${
          md(file.deletions ?? 0)
        } |`,
      );
    }
    lines.push("", "## Timeline", "", ...renderTimeline(timeline));
    lines.push("## Local Worktree State", "");
    if (!worktrees.length) {
      lines.push("_No local worktree analysis is available._", "");
    }
    for (const worktree of worktrees) {
      const complete = worktree.analysisComplete !== false;
      lines.push(
        `- PR #${md(worktree.prNumber)}: ${inlineCode(worktree.path)}; dirty=${
          md(complete ? worktree.isDirty : "unknown")
        }; stale=${md(worktree.isPrHeadStale)}; ahead=${
          md(complete ? worktree.aheadCommitCount : "unknown")
        }; action=${md(worktree.recommendedAction)}`,
      );
      for (const error of stringArray(worktree.errors)) {
        lines.push(`  - Error: ${md(error)}`);
      }
    }
    lines.push("## Code-Path Walkthrough", "");
    if (primary.type !== "pr") {
      lines.push(
        "_Analysis evidence applies only when the primary subject is a PR._",
        "",
      );
    } else if (!evidence) {
      const modelName = context.definition?.name ?? modelId;
      lines.push(
        `_Code-Path walkthrough not analysed through LLM yet for HEAD ${
          inlineCode(primaryPr?.headSha)
        }._`,
        staleEvidence.length
          ? `_Stored analysis exists for ${staleEvidence.length} older head(s) and is not shown as current._`
          : "",
        "",
        "Generate it with:",
        "",
        "```sh",
        `swamp model method run ${
          JSON.stringify(modelName)
        } record_pr_analysis --input-file <approved-yaml-path>`,
        "```",
        "",
      );
    } else {
      const sections = evidence.sections as Value | undefined;
      lines.push(
        `Generated by ${md(evidence.generator)} at ${
          md(evidence.generatedAt)
        } for ${inlineCode(evidence.headSha)}.`,
        "",
        String(sections?.codePathWalkthrough ?? "_Not provided._"),
        "",
        "Evidence references: " +
          (stringArray(evidence.evidenceRefs).map(inlineCode).join(", ") ||
            "none"),
        "",
      );
    }
    lines.push("## Review Attention Map", "");
    if (primary.type !== "pr") {
      lines.push("_Analysis evidence applies only to a primary PR._", "");
    } else if (!evidence) {
      lines.push(
        `_Review attention not analysed through LLM yet for HEAD ${
          inlineCode(primaryPr?.headSha)
        }._`,
        "",
      );
    } else {
      const sections = evidence.sections as Value | undefined;
      lines.push(
        String(sections?.reviewAttentionMap ?? "_Not provided._"),
        "",
      );
    }
    lines.push(
      "## Data Freshness and Errors",
      "",
      `- Last successful GitHub sync: ${
        md(freshness.lastSuccessfulGithubSync ?? "unknown")
      }`,
      `- Last GitHub sync attempt: ${
        md(freshness.lastGithubAttemptFinishedAt ?? "unknown")
      }`,
      `- Last filesystem/git sync: ${
        md(freshness.lastGitFetchFinishedAt ?? "unknown")
      }`,
      `- Mirror state updated: ${md(freshness.mirrorUpdatedAt ?? "unknown")}`,
      `- Primary subject synced: ${md(freshness.subjectSyncedAt ?? "unknown")}`,
      `- Timeline complete: ${
        freshness.timelineComplete == null
          ? "Unknown"
          : freshness.timelineComplete
          ? "Yes"
          : "No"
      }`,
      `- Relevant collection statuses: ${statuses.length}`,
      `- Errors: ${freshness.errors.length}`,
      "",
    );
    for (const error of freshness.errors as Value[]) {
      const location = error.dataName ?? [
        error.subjectType,
        error.subjectNumber,
        error.component,
      ].filter(Boolean).join(" #");
      lines.push(`- ${inlineCode(location)}: ${md(error.error)}`);
    }

    return {
      markdown: lines.join("\n"),
      json: {
        repo,
        primary,
        cluster: [...cluster].sort(),
        readiness: {
          result: readiness,
          signals: readinessSignals,
          byPr: perPrReadiness,
        },
        timelineCodeGranularity: granularity,
        subjects: { prs, issues },
        references: relevantReferences,
        externalReferences,
        activityEvents: events,
        revisions,
        commits,
        changedFiles: files,
        checkRuns: checks,
        collectionStatuses: statuses,
        worktreeAnalyses: worktrees,
        analysisEvidence: evidence ?? null,
        llmEvidence: { current: evidence ?? null, stale: staleEvidence },
        currentHead: stringField(primaryPr ?? {}, "headSha") || null,
        analysisInput: primaryPr
          ? {
            prNumber: primary.number,
            headSha: stringField(primaryPr, "headSha"),
            generator: "<agent-name>",
            codePathWalkthrough: "<markdown>",
            reviewAttentionMap: "<markdown>",
            evidenceRefs: [],
          }
          : null,
        mirrorState: mirrorState ?? null,
        prHeadStates: headStates,
        timeline,
        freshness,
      },
    };
  },
};
