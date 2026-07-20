import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@systeminit/swamp-testing@0.20260518.13";
import {
  forEachWithConcurrency,
  model,
  parseKindClustersResult,
} from "./kind_cluster_pool.ts";

const globalArgs = model.globalArguments.parse({
  n: 2,
  kindConfig: "kind: Cluster",
});

const existingState = {
  clusters: {
    "cluster-id": {
      clusterName: "swamp-pool-existing",
      state: "ready" as const,
      kubeconfig: "a3ViZWNvbmZpZw==",
      createdAt: "2026-07-20T00:00:00.000Z",
    },
  },
};

Deno.test("kind-cluster-pool exposes its lifecycle methods", () => {
  assertEquals(model.type, "@evrardjp/kind-cluster-pool");
  for (const method of ["initialize", "reserve", "release", "sync", "status"]) {
    assert(method in model.methods);
  }
});

Deno.test("kind-cluster-pool applies safe naming defaults", () => {
  assertEquals(globalArgs.clusterNamePrefix, "swamp-pool");
  assertEquals(globalArgs.kindBinary, "kind");
});

Deno.test("kind-cluster-pool bounds its target pool size", () => {
  assert(
    model.globalArguments.safeParse({ n: 20, kindConfig: "kind" }).success,
  );
  assertEquals(
    model.globalArguments.safeParse({ n: 21, kindConfig: "kind" }).success,
    false,
  );
});

Deno.test("initialize rejects force when tracked state exists", async () => {
  const { context } = createModelTestContext({
    globalArgs,
    storedResources: { "state-current": existingState },
  });

  await assertRejects(
    () =>
      model.methods.initialize.execute(
        { force: true },
        context as Parameters<typeof model.methods.initialize.execute>[1],
      ),
    Error,
    "would leak tracked clusters",
  );
});

Deno.test("reserve records one claim under the documented model lock", async () => {
  assertStringIncludes(
    model.methods.reserve.description,
    "exclusive per-model method lock",
  );
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    storedResources: { "state-current": existingState },
  });

  await model.methods.reserve.execute(
    { testId: "test-42" },
    context as Parameters<typeof model.methods.reserve.execute>[1],
  );

  const state = getWrittenResources().find((entry) =>
    entry.specName === "state"
  );
  const clusters = state?.data.clusters as Record<
    string,
    { state: string; testId?: string }
  >;
  assertEquals(clusters["cluster-id"].state, "in_use");
  assertEquals(clusters["cluster-id"].testId, "test-42");
});

Deno.test("kind cluster discovery rejects command failures", () => {
  assertThrows(
    () =>
      parseKindClustersResult({
        stdout: "",
        stderr: "container runtime unavailable",
        code: 1,
      }),
    Error,
    "kind get clusters failed: container runtime unavailable",
  );
});

Deno.test("cluster operations use bounded concurrency", async () => {
  let active = 0;
  let maximumActive = 0;
  await forEachWithConcurrency(
    Array.from({ length: 12 }),
    4,
    async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
    },
  );
  assertEquals(maximumActive, 4);
});
