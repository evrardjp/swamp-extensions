import { assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1";
import { parse } from "jsr:@std/yaml@1";
import { createModelTestContext } from "jsr:@systeminit/swamp-testing@0.20260518.13";
import { model } from "./semantic_orchestrator.ts";

function recorder(globalArgs: Record<string, unknown>) {
  const test = createModelTestContext({ globalArgs });
  return {
    get writes() {
      return test.getWrittenResources();
    },
    context: test.context,
  };
}

function compile(
  _globalArgs: Record<string, unknown>,
  context: ReturnType<typeof recorder>["context"],
) {
  return model.methods.compile.execute({}, context as never);
}

function executable(
  requires: string[] = [],
  implementation: Record<string, unknown> = {
    type: "workflow",
    workflowIdOrName: "run",
    inputs: {},
  },
) {
  return { requires, implementation };
}

Deno.test("compile resolves a diamond and renders arbitrary typed facts", async () => {
  const args = {
    targetWorkflowName: "generated",
    facts: JSON.parse(
      '{"__proto__":{"vm":{"ip":"192.0.2.1","enabled":true,"port":22}}}',
    ),
    requests: JSON.parse('{"__proto__":["app"]}'),
    capabilities: {
      base: executable(),
      left: executable(["base"]),
      right: executable(["base"]),
      app: executable(["left", "right"], {
        type: "model_method",
        modelType: "@example/app",
        modelName: "@{factKey}-app",
        methodName: "apply",
        globalArgs: {
          host: "@{facts.vm.ip}",
          enabled: "@{facts.vm.enabled}",
          label: "port-@{facts.vm.port}",
        },
        inputs: { retries: 2 },
      }),
    },
  };
  const test = recorder(args);
  const result = await compile(args, test.context);
  const writes = test.writes;

  assertEquals(result.dataHandles.length, 2);
  assertEquals(writes.map((write) => write.specName), [
    "compilationReport",
    "workflowDraft",
  ]);
  const draft = writes[1].data as Record<string, unknown>;
  const workflow = parse(draft.workflowYaml as string) as Record<
    string,
    unknown
  >;
  assertEquals("id" in workflow, false);
  assertEquals(workflow.name, "generated");
  const jobs = workflow.jobs as Array<Record<string, unknown>>;
  assertEquals(jobs.map((job) => job.name), [
    "__proto__:app",
    "__proto__:base",
    "__proto__:left",
    "__proto__:right",
  ]);
  const app = jobs[0];
  assertEquals(app.dependsOn, [
    { condition: { type: "succeeded" }, job: "__proto__:left" },
    { condition: { type: "succeeded" }, job: "__proto__:right" },
  ]);
  const step = (app.steps as Array<Record<string, unknown>>)[0];
  assertEquals(step.task, {
    globalArgs: { enabled: true, host: "192.0.2.1", label: "port-22" },
    inputs: { retries: 2 },
    methodName: "apply",
    modelName: "__proto__-app",
    modelType: "@example/app",
    type: "model_method",
  });
});

Deno.test("compile rejects unknown templates and recursive workflows without writes", async () => {
  for (
    const [implementation, message] of [
      [
        { type: "workflow", workflowIdOrName: "@{facts.missing}", inputs: {} },
        "Unknown template path",
      ],
      [
        { type: "workflow", workflowIdOrName: "generated", inputs: {} },
        "recursion",
      ],
    ] as const
  ) {
    const args = {
      targetWorkflowName: "generated",
      facts: { node: {} },
      requests: { node: ["app"] },
      capabilities: { app: executable([], implementation) },
    };
    const test = recorder(args);
    await assertRejects(
      () => compile(args, test.context),
      Error,
      message,
    );
    assertEquals(test.writes, []);
  }
});

Deno.test("compile rejects unknown requests and semantic cycles without writes", async () => {
  for (
    const capabilities of [
      {},
      { a: executable(["b"]), b: executable(["a"]) },
    ]
  ) {
    const args = {
      targetWorkflowName: "generated",
      facts: { node: {} },
      requests: { node: [Object.keys(capabilities).length ? "a" : "missing"] },
      capabilities,
    };
    const test = recorder(args);
    await assertRejects(
      () => compile(args, test.context),
      Error,
    );
    assertEquals(test.writes, []);
  }
});

Deno.test("compile validates references in unrequested capabilities", async () => {
  for (
    const invalid of [
      { requires: ["missing"], implementation: executable().implementation },
      { contributes: { to: "missing", values: {} } },
    ]
  ) {
    const args = {
      targetWorkflowName: "generated",
      facts: { node: {} },
      requests: { node: ["app"] },
      capabilities: { app: executable(), invalid },
    };
    const test = recorder(args);
    await assertRejects(() => compile(args, test.context), Error);
    assertEquals(test.writes, []);
  }
});

Deno.test("compile rejects a workflow with no effective jobs clearly", async () => {
  const args = {
    targetWorkflowName: "generated",
    facts: { node: {} },
    requests: { node: [] },
    capabilities: {},
  };
  const result = recorder(args);
  await assertRejects(
    () => compile(args, result.context),
    Error,
    "at least one effective job",
  );
  assertEquals(result.writes, []);
});

Deno.test("compile handles deep dependency chains without recursion overflow", async () => {
  const capabilities: Record<string, unknown> = {};
  for (let index = 0; index < 2_000; index++) {
    capabilities[`cap-${index}`] = executable(
      index === 0 ? [] : [`cap-${index - 1}`],
    );
  }
  const args = {
    targetWorkflowName: "generated",
    facts: { node: {} },
    requests: { node: ["cap-1999"] },
    capabilities,
  };
  const result = recorder(args);
  await compile(args, result.context);
  const report = result.writes[0].data as Record<string, unknown>;
  assertEquals(
    (report.summary as Record<string, number>).effectiveJobCount,
    2_000,
  );
});

Deno.test("compile folds contributions and preserves rewritten prerequisites", async () => {
  const args = {
    targetWorkflowName: "generated",
    facts: { node: {} },
    requests: { node: ["docker", "tools"] },
    capabilities: {
      refresh: executable(),
      packages: {
        requires: [],
        aggregate: { inputs: { packages: { merge: "unique-sorted" } } },
        implementation: {
          type: "model_method",
          modelType: "@example/packages",
          modelName: "packages",
          methodName: "apply",
          globalArgs: { packages: "@{aggregate.packages}" },
          inputs: {},
        },
      },
      docker: {
        requires: ["packages", "refresh"],
        contributes: { to: "packages", values: { packages: ["z", "docker"] } },
      },
      tools: {
        requires: ["packages"],
        contributes: { to: "packages", values: { packages: ["docker", "a"] } },
      },
    },
  };
  const test = recorder(args);
  await compile(args, test.context);
  const writes = test.writes;

  const workflow = parse(
    (writes[1].data as Record<string, string>).workflowYaml,
  ) as { jobs: Array<Record<string, unknown>> };
  assertEquals(workflow.jobs.map((job) => job.name), [
    "node:packages",
    "node:refresh",
  ]);
  assertEquals(workflow.jobs[0].dependsOn, [
    { condition: { type: "succeeded" }, job: "node:refresh" },
  ]);
  const task = ((workflow.jobs[0].steps as Array<Record<string, unknown>>)[0]
    .task) as Record<string, unknown>;
  assertEquals(task.globalArgs, { packages: ["a", "docker", "z"] });
  const report = writes[0].data as Record<string, unknown>;
  assertEquals(report.mergedAggregates, [{
    aggregate: "packages",
    factKey: "node",
    values: { packages: ["a", "docker", "z"] },
  }]);
});

Deno.test("a requested contribution implicitly includes its aggregate", async () => {
  const args = {
    targetWorkflowName: "generated",
    facts: { node: {} },
    requests: { node: ["item"] },
    capabilities: {
      aggregate: {
        aggregate: { inputs: { values: { merge: "unique-sorted" } } },
        implementation: {
          type: "workflow",
          workflowIdOrName: "child",
          inputs: { values: "@{aggregate.values}" },
        },
      },
      item: {
        contributes: { to: "aggregate", values: { values: ["x"] } },
      },
    },
  };
  const test = recorder(args);
  await compile(args, test.context);
  const writes = test.writes;
  const workflow = parse(
    (writes[1].data as Record<string, string>).workflowYaml,
  ) as { jobs: Array<Record<string, unknown>> };
  assertEquals(workflow.jobs.map((job) => job.name), ["node:aggregate"]);
});

Deno.test("effective keys cannot collide when fact and capability names contain colons", async () => {
  const args = {
    targetWorkflowName: "generated",
    facts: { "a:b": {}, a: {} },
    requests: { "a:b": ["c"], a: ["b:c"] },
    capabilities: { c: executable(), "b:c": executable() },
  };
  const test = recorder(args);
  await compile(args, test.context);
  const writes = test.writes;
  const workflow = parse(
    (writes[1].data as Record<string, string>).workflowYaml,
  ) as { jobs: Array<Record<string, unknown>> };
  assertEquals(workflow.jobs.map((job) => job.name), ["a%3Ab:c", "a:b%3Ac"]);
});

Deno.test("compile rejects invalid contribution targets, inputs, and values", async () => {
  const cases = [
    { target: "missing", values: { packages: ["x"] } },
    { target: "plain", values: { packages: ["x"] } },
    { target: "packages", values: { unknown: ["x"] } },
    { target: "packages", values: { packages: "x" } },
  ];
  for (const testCase of cases) {
    const args = {
      targetWorkflowName: "generated",
      facts: { node: {} },
      requests: { node: ["item"] },
      capabilities: {
        plain: executable(),
        packages: {
          aggregate: { inputs: { packages: { merge: "unique-sorted" } } },
          implementation: {
            type: "workflow",
            workflowIdOrName: "packages",
            inputs: {},
          },
        },
        item: {
          contributes: { to: testCase.target, values: testCase.values },
        },
      },
    };
    const test = recorder(args);
    await assertRejects(
      () => compile(args, test.context),
      Error,
    );
    assertEquals(test.writes, []);
  }
});

Deno.test("compile rejects non-JSON aggregate values", async () => {
  for (const value of [NaN, Infinity, 1n]) {
    const args = {
      targetWorkflowName: "generated",
      facts: { node: {} },
      requests: { node: ["item"] },
      capabilities: {
        packages: {
          aggregate: { inputs: { values: { merge: "unique-sorted" } } },
          implementation: {
            type: "workflow",
            workflowIdOrName: "child",
            inputs: { values: "@{aggregate.values}" },
          },
        },
        item: {
          contributes: { to: "packages", values: { values: [value] } },
        },
      },
    };
    const result = recorder(args);
    await assertRejects(() => compile(args, result.context), Error);
    assertEquals(result.writes, []);
  }
});

Deno.test("compile applies fact and global coordination deterministically", async () => {
  const args = {
    targetWorkflowName: "generated",
    facts: { b: {}, a: {} },
    requests: { b: ["later", "free"], a: ["later", "free"] },
    capabilities: {
      first: {
        ...executable(),
        coordination: { group: "lock", scope: "global" },
      },
      later: {
        ...executable(["first"]),
        coordination: { group: "lock", scope: "global" },
      },
      free: {
        ...executable(),
        coordination: { group: "local", scope: "fact" },
      },
    },
  };
  const test = recorder(args);
  await compile(args, test.context);
  const writes = test.writes;
  const workflow = parse(
    (writes[1].data as Record<string, string>).workflowYaml,
  ) as { jobs: Array<Record<string, unknown>> };
  const dependencies = Object.fromEntries(
    workflow.jobs.map((job) => [job.name, job.dependsOn]),
  );
  assertEquals(dependencies["a:later"], [
    { condition: { type: "succeeded" }, job: "a:first" },
  ]);
  assertEquals(dependencies["b:first"], [
    { condition: { type: "completed" }, job: "a:later" },
  ]);
  assertEquals(dependencies["b:later"], [
    { condition: { type: "succeeded" }, job: "b:first" },
  ]);
});

Deno.test("coordination waits for completion without success-gating peers", async () => {
  const args = {
    targetWorkflowName: "generated",
    facts: { node: {} },
    requests: { node: ["a", "b"] },
    capabilities: {
      a: { ...executable(), coordination: { group: "lock", scope: "fact" } },
      b: { ...executable(), coordination: { group: "lock", scope: "fact" } },
    },
  };
  const test = recorder(args);
  await compile(args, test.context);
  const writes = test.writes;
  const workflow = parse(
    (writes[1].data as Record<string, string>).workflowYaml,
  ) as { jobs: Array<Record<string, unknown>> };
  const dependencies = Object.fromEntries(
    workflow.jobs.map((job) => [job.name, job.dependsOn]),
  );
  assertEquals(dependencies["node:b"], [
    { condition: { type: "completed" }, job: "node:a" },
  ]);
});

Deno.test("coordination uses a stable topological order when key order conflicts with reachability", async () => {
  const args = {
    targetWorkflowName: "generated",
    facts: { node: {} },
    requests: { node: ["a", "b", "c"] },
    capabilities: {
      a: {
        ...executable(["c"]),
        coordination: { group: "lock", scope: "fact" },
      },
      b: { ...executable(), coordination: { group: "lock", scope: "fact" } },
      c: { ...executable(), coordination: { group: "lock", scope: "fact" } },
    },
  };
  const test = recorder(args);
  await compile(args, test.context);
  const writes = test.writes;
  const workflow = parse(
    (writes[1].data as Record<string, string>).workflowYaml,
  ) as { jobs: Array<Record<string, unknown>> };
  const dependencies = Object.fromEntries(
    workflow.jobs.map((job) => [job.name, job.dependsOn]),
  );
  assertEquals(dependencies["node:b"], []);
  assertEquals(dependencies["node:c"], [
    { condition: { type: "completed" }, job: "node:b" },
  ]);
  assertEquals(dependencies["node:a"], [
    { condition: { type: "succeeded" }, job: "node:c" },
  ]);
});

Deno.test("coordination preserves semantic paths through jobs outside its bucket", async () => {
  const args = {
    targetWorkflowName: "generated",
    facts: { node: {} },
    requests: { node: ["a"] },
    capabilities: {
      z: { ...executable(), coordination: { group: "lock", scope: "fact" } },
      mid: executable(["z"]),
      a: {
        ...executable(["mid"]),
        coordination: { group: "lock", scope: "fact" },
      },
    },
  };
  const test = recorder(args);
  await compile(args, test.context);
  const writes = test.writes;
  const report = writes[0].data as Record<string, unknown>;
  assertEquals(report.operationalEdges, []);
});

Deno.test("fact coordination bucket keys cannot collide", async () => {
  const args = {
    targetWorkflowName: "generated",
    facts: { "a:b": {}, a: {} },
    requests: { "a:b": ["one"], a: ["two"] },
    capabilities: {
      one: { ...executable(), coordination: { group: "c", scope: "fact" } },
      two: { ...executable(), coordination: { group: "b:c", scope: "fact" } },
    },
  };
  const test = recorder(args);
  await compile(args, test.context);
  const writes = test.writes;
  const report = writes[0].data as Record<string, unknown>;
  assertEquals(report.operationalEdges, []);
});

Deno.test("report retains folded edge origins and complete model targets", async () => {
  const args = {
    targetWorkflowName: "generated",
    facts: { node: {} },
    requests: { node: ["item"] },
    capabilities: {
      base: executable(),
      packages: {
        requires: ["base"],
        aggregate: { inputs: { values: { merge: "unique-sorted" } } },
        implementation: {
          type: "model_method",
          modelType: "@example/packages",
          modelName: "node-packages",
          methodName: "apply",
          globalArgs: { values: "@{aggregate.values}" },
          inputs: {},
        },
      },
      item: {
        requires: ["packages", "base"],
        contributes: { to: "packages", values: { values: ["x"] } },
      },
    },
  };
  const test = recorder(args);
  await compile(args, test.context);
  const writes = test.writes;
  const report = writes[0].data as Record<string, unknown>;
  assertEquals((report.semanticEdges as unknown[]).length, 2);
  assertEquals(
    (report.effectiveJobs as Array<Record<string, unknown>>)[1].target,
    {
      methodName: "apply",
      modelName: "node-packages",
      modelType: "@example/packages",
    },
  );
});

Deno.test("equivalent shuffled inputs produce identical artifacts and reports", async () => {
  const run = async (
    facts: Record<string, unknown>,
    capabilities: Record<string, unknown>,
  ) => {
    const args = {
      targetWorkflowName: "generated",
      facts,
      requests: { "ä": ["z", "a"], Z: ["a", "z"] },
      capabilities,
    };
    const test = recorder(args);
    await compile(args, test.context);
    const writes = test.writes;
    const report = structuredClone(writes[0].data) as Record<string, unknown>;
    delete report.compiledAt;
    return { draft: writes[1].data as Record<string, unknown>, report };
  };
  const a = executable([], {
    type: "workflow",
    workflowIdOrName: "child",
    inputs: { value: "@{facts.value}" },
  });
  const first = await run({ "ä": { value: 1 }, Z: { value: 2 } }, {
    z: executable(),
    a,
  });
  const second = await run({ Z: { value: 2 }, "ä": { value: 1 } }, {
    a,
    z: executable(),
  });
  assertEquals(first.draft.workflowYaml, second.draft.workflowYaml);
  assertEquals(first.draft.contentHash, second.draft.contentHash);
  assertEquals(first.report, second.report);
  assertMatch(first.draft.contentHash as string, /^[0-9a-f]{64}$/);
  const workflow = parse(first.draft.workflowYaml as string) as Record<
    string,
    unknown
  >;
  assertEquals("id" in workflow, false);
  const temporaryValidationValue: Record<string, unknown> = {
    id: "00000000-0000-4000-8000-000000000000",
    ...workflow,
  };
  assertEquals(typeof temporaryValidationValue.id, "string");
  assertEquals(temporaryValidationValue.version, 1);
  assertEquals(Array.isArray(temporaryValidationValue.jobs), true);
});
