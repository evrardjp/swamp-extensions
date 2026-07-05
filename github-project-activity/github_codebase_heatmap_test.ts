import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./github_codebase_heatmap.ts";

type Entry = {
  name: string;
  version: number;
  tags?: Record<string, string>;
  metadata?: { tags?: Record<string, string> };
  value: unknown;
};

function repository(entries: Entry[]) {
  const encoder = new TextEncoder();
  const contentByName = new Map(
    entries.map((entry) => [
      `${entry.name}:${entry.version}`,
      encoder.encode(JSON.stringify(entry.value)),
    ]),
  );
  return {
    findAllForModel: async () =>
      entries.map(({ name, version, tags, metadata }) => ({
        name,
        version,
        tags,
        metadata,
      })),
    getContent: async (
      _modelType: unknown,
      _modelId: string,
      dataName: string,
      version?: number,
    ) => contentByName.get(`${dataName}:${version}`) ?? null,
  };
}

Deno.test("codebase heatmap matches PR-file touches by repo and PR number", async () => {
  const result = await report.execute({
    modelType: "@evrardjp/github-project-activity",
    modelId: "model-id",
    globalArgs: { owner: "owner", repo: "repo" },
    dataRepository: repository([
      {
        name: "file-a",
        version: 1,
        tags: { specName: "repoFileSnapshot" },
        value: {
          repo: "owner/repo",
          path: "src/a.ts",
          type: "file",
          syncedAt: "2026-07-01T00:00:00.000Z",
        },
      },
      {
        name: "pr-file-a",
        version: 1,
        tags: { specName: "prFileSnapshot" },
        value: {
          repo: "owner/repo",
          prNumber: 42,
          path: "src/a.ts",
          status: "modified",
          statusShort: "M",
          landedAt: null,
          syncedAt: "2026-07-01T00:00:00.000Z",
        },
      },
      {
        name: "other-pr-file-42",
        version: 1,
        tags: { specName: "prFileSnapshot" },
        value: {
          repo: "other/repo",
          prNumber: 42,
          path: "src/other.ts",
          status: "modified",
          statusShort: "M",
          syncedAt: "2026-07-01T00:00:00.000Z",
        },
      },
      {
        name: "other-pr-42",
        version: 1,
        tags: { specName: "prSnapshot" },
        value: {
          repo: "other/repo",
          number: 42,
          title: "Merged elsewhere",
          state: "closed",
          merged: true,
          mergedAt: "2026-07-01T00:00:00.000Z",
          syncedAt: "2026-07-01T00:00:00.000Z",
        },
      },
    ]),
  });

  const counts = result.json.counts as Record<string, number>;
  assertEquals(counts.currentFilesWithLandedTouches, 0);
  assertEquals(counts.prFileSnapshots, 1);
  assertEquals(counts.landedPrFileSnapshots, 0);
  assertStringIncludes(result.markdown, "Landed PR-file snapshots: **0** / 1");
});

Deno.test("codebase heatmap ignores unclassified PR-file touches without retained PR snapshots", async () => {
  const result = await report.execute({
    modelType: "@evrardjp/github-project-activity",
    modelId: "model-id",
    globalArgs: { owner: "owner", repo: "repo" },
    dataRepository: repository([
      {
        name: "file-b",
        version: 1,
        tags: { specName: "repoFileSnapshot" },
        value: {
          repo: "owner/repo",
          path: "src/b.ts",
          type: "file",
          syncedAt: "2026-07-01T00:00:00.000Z",
        },
      },
      {
        name: "legacy-pr-file-b",
        version: 1,
        tags: { specName: "prFileSnapshot" },
        value: {
          repo: "owner/repo",
          prNumber: 7,
          path: "src/b.ts",
          status: "modified",
          statusShort: "M",
          changes: 3,
          syncedAt: "2026-07-01T00:00:00.000Z",
        },
      },
    ]),
  });

  const counts = result.json.counts as Record<string, number>;
  assertEquals(counts.currentFilesWithTouches, 0);
  assertEquals(counts.currentFilesWithLandedTouches, 0);
  assertEquals(counts.landedPrFileSnapshots, 0);
});

Deno.test("codebase heatmap ignores unclassified PR-file touches with retained merged PR snapshots", async () => {
  const result = await report.execute({
    modelType: "@evrardjp/github-project-activity",
    modelId: "model-id",
    globalArgs: { owner: "owner", repo: "repo" },
    dataRepository: repository([
      {
        name: "file-c",
        version: 1,
        tags: { specName: "repoFileSnapshot" },
        value: {
          repo: "owner/repo",
          path: "src/c.ts",
          type: "file",
          syncedAt: "2026-07-01T00:00:00.000Z",
        },
      },
      {
        name: "legacy-pr-file-c",
        version: 1,
        tags: { specName: "prFileSnapshot" },
        value: {
          repo: "owner/repo",
          prNumber: 9,
          path: "src/c.ts",
          status: "modified",
          statusShort: "M",
          changes: 2,
          syncedAt: "2026-07-01T00:00:00.000Z",
        },
      },
      {
        name: "merged-pr-9",
        version: 1,
        tags: { specName: "prSnapshot" },
        value: {
          repo: "owner/repo",
          number: 9,
          title: "Merged before landedAt existed",
          state: "closed",
          merged: true,
          mergedAt: "2026-07-02T00:00:00.000Z",
          syncedAt: "2026-07-02T00:00:00.000Z",
        },
      },
    ]),
  });

  const counts = result.json.counts as Record<string, number>;
  assertEquals(counts.currentFilesWithTouches, 0);
  assertEquals(counts.currentFilesWithLandedTouches, 0);
  assertEquals(counts.landedPrFileSnapshots, 0);
});

Deno.test("codebase heatmap keeps explicit merged PR-file rows without retained PR snapshots", async () => {
  const result = await report.execute({
    modelType: "@evrardjp/github-project-activity",
    modelId: "model-id",
    globalArgs: { owner: "owner", repo: "repo" },
    dataRepository: repository([
      {
        name: "file-d",
        version: 1,
        tags: { specName: "repoFileSnapshot" },
        value: {
          repo: "owner/repo",
          path: "src/d.ts",
          type: "file",
          syncedAt: "2026-07-01T00:00:00.000Z",
        },
      },
      {
        name: "merged-pr-file-d",
        version: 1,
        tags: { specName: "prFileSnapshot" },
        value: {
          repo: "owner/repo",
          prNumber: 10,
          path: "src/d.ts",
          status: "modified",
          statusShort: "M",
          changes: 4,
          merged: true,
          prState: "closed",
          landedAt: "2026-07-02T00:00:00.000Z",
          syncedAt: "2026-07-02T00:00:00.000Z",
        },
      },
    ]),
  });

  const counts = result.json.counts as Record<string, number>;
  assertEquals(counts.currentFilesWithTouches, 1);
  assertEquals(counts.currentFilesWithLandedTouches, 1);
  assertEquals(counts.landedPrFileSnapshots, 1);
});

Deno.test("codebase heatmap ignores stale PR-file rows missing a merged-file landing", async () => {
  const result = await report.execute({
    modelType: "@evrardjp/github-project-activity",
    modelId: "model-id",
    globalArgs: { owner: "owner", repo: "repo" },
    dataRepository: repository([
      {
        name: "file-a",
        version: 1,
        tags: { specName: "repoFileSnapshot" },
        value: {
          repo: "owner/repo",
          path: "src/a.ts",
          type: "file",
          syncedAt: "2026-07-01T00:00:00.000Z",
        },
      },
      {
        name: "stale-pr-file-a",
        version: 1,
        tags: { specName: "prFileSnapshot" },
        value: {
          repo: "owner/repo",
          prNumber: 8,
          path: "src/a.ts",
          status: "modified",
          statusShort: "M",
          changes: 5,
          landedAt: null,
          syncedAt: "2026-07-01T00:00:00.000Z",
        },
      },
      {
        name: "merged-pr-8",
        version: 1,
        tags: { specName: "prSnapshot" },
        value: {
          repo: "owner/repo",
          number: 8,
          title: "Merged without stale file",
          state: "closed",
          merged: true,
          mergedAt: "2026-07-02T00:00:00.000Z",
          syncedAt: "2026-07-02T00:00:00.000Z",
        },
      },
    ]),
  });

  const counts = result.json.counts as Record<string, number>;
  assertEquals(counts.currentFilesWithLandedTouches, 0);
  assertEquals(counts.landedPrFileSnapshots, 0);
  assertStringIncludes(result.markdown, "Landed PR-file snapshots: **0** / 1");
});
