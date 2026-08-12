# Caddy Content-Addressed Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Caddy's mutable validation/apply receipts with content-addressed config artifacts consumed by name.

**Architecture:** Keep all behavior in the existing Caddy model. Rendered JSON is named by its full SHA-256 digest; validation and apply read that exact resource, while swamp's method output records execution status and errors.

**Tech Stack:** TypeScript strict mode, Deno Web Crypto, Zod 4, `@systeminit/swamp-testing`, swamp CLI.

## Global Constraints

- `validateConfig` and `applyConfig` accept only `{ configName: string }`; this is intentionally breaking.
- Declare only the `config` resource and remove its redundant `timestamp` field.
- Do not add an arbitrary JSON import method or a new dependency.
- Use the full lowercase hexadecimal SHA-256 digest of exact `configJson` as the instance name.
- Set model and manifest versions to `2026.08.12.1`.
- Overwrite `caddy/RELEASE_NOTES.md` with user-facing notes for `2026.08.12.1`.
- Do not commit unless the user explicitly requests it.

---

### Task 1: Content-Addressed Config Flow

**Files:**
- Modify: `caddy/caddy_test.ts`
- Modify: `caddy/caddy.ts`

**Interfaces:**
- Produces: `sha256(value: string): Promise<string>` returning 64 lowercase hex characters.
- Produces: `readConfigResource(context, configName): Promise<string>` returning stored `configJson` or throwing `Config artifact '<name>' not found` / `Config artifact '<name>' is malformed`.
- Changes: `validateConfig` arguments to `{ configName: string }` and result to `{ dataHandles: [] }`.
- Changes: `applyConfig` arguments to `{ configName: string }` and result to `{ dataHandles: [] }`.
- Preserves: `applyReverseProxy({ sites })` returns only its rendered config handle after applying the same JSON.

- [ ] **Step 1: Make the test context store names and readable resources**

Change the helper to record `name`, persist written data in a map, expose `readResource`, and return handles containing the instance name:

```ts
type WriteCall = {
  specName: string;
  name: string;
  data: Record<string, unknown>;
};

function context(
  globalArgs: Record<string, unknown> = {},
  stored = new Map<string, Record<string, unknown>>(),
) {
  const writes: WriteCall[] = [];
  return {
    writes,
    context: {
      globalArgs,
      writeResource: async (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ specName, name, data });
        stored.set(name, data);
        return { specName, name, version: 1 };
      },
      readResource: async (name: string) => stored.get(name) ?? null,
    },
  };
}
```

- [ ] **Step 2: Add failing tests for deterministic artifact identity**

Render the same parsed arguments twice and changed arguments once. Assert the first two names match `/^[0-9a-f]{64}$/`, the changed name differs, each write uses `specName === "config"`, and config data has no `timestamp` property.

Also assert `Object.keys(model.resources)` equals `["config"]`. The production change that makes these pass is hashing `configJson` and removing receipt specs.

- [ ] **Step 3: Add failing tests for artifact consumers**

Seed a map with:

```ts
const configName = "stored-config";
const configJson = JSON.stringify({
  apps: { http: { servers: { srv0: { listen: [":8080"] } } } },
});
const stored = new Map([[configName, { configJson }]]);
```

Assert:

```ts
const validateResult = await withMockedCommand(
  () => ({ stdout: "valid", code: 0 }),
  () => model.methods.validateConfig.execute({ configName }, testContext.context),
);
assertEquals(validateResult.result, { dataHandles: [] });
assertEquals(testContext.writes, []);
```

Adapt the existing apply tests to call `{ configName }`, assert `{ dataHandles: [] }`, and assert no resources were written. Add a missing-artifact test that expects `Config artifact 'missing' not found` and confirms `withMockedCommand` captured no commands.

- [ ] **Step 4: Add a failing compound-method regression test**

Execute `applyReverseProxy` with one site under successful command mocks. Assert it returns exactly one handle, that handle's `name` matches the sole config write, and all returned names are unique:

```ts
const names = result.dataHandles.map((handle) => handle.name);
assertEquals(names.length, 1);
assertEquals(new Set(names).size, names.length);
assertEquals(testContext.writes.map(({ specName }) => specName), ["config"]);
```

- [ ] **Step 5: Run the regression tests and verify RED**

Run: `deno task test`

Expected: failures show current names remain `current`, receipt resources still exist, `configName` is not read, and apply/validation still write handles. Fix test typing/setup errors until failures are behavioral.

- [ ] **Step 6: Implement the minimal model change**

In `caddy/caddy.ts`:

1. Replace `ValidateConfigArgs` with `z.object({ configName: z.string().min(1) })`; keep `ApplyConfigArgs = ValidateConfigArgs`.
2. Remove `ValidationOutput`, `ApplyOutput`, and `timestamp` from `ConfigOutput`.
3. Extend local `MethodContext` with required `readResource(name): Promise<Record<string, unknown> | null>`.
4. Add the native Web Crypto helper:

```ts
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
```

5. Make `writeConfigResource` call `writeResource("config", await sha256(configJson), ...)` and omit `timestamp`.
6. Replace `validateAndWrite` with validation-only logic returning `Promise<void>`.
7. Add a resource reader that verifies both resource existence and `typeof resource.configJson === "string"` before returning it.
8. Make the internal apply function validate/apply raw JSON and return `Promise<void>` without writing resources.
9. Make standalone validation/apply read `args.configName`, execute their operation, and return `{ dataHandles: [] }`.
10. Make `applyReverseProxy` return `{ dataHandles: [configHandle] }` after applying its in-memory `configJson`.
11. Remove `validation` and `apply` from `model.resources`.

- [ ] **Step 7: Run focused verification and verify GREEN**

Run: `deno task test && deno task check && deno task lint && deno task fmt`

Expected: all Caddy tests pass with no type, lint, or formatting errors.

---

### Task 2: Breaking Release Metadata and Documentation

**Files:**
- Modify: `caddy/caddy.ts`
- Modify: `caddy/manifest.yaml`
- Modify: `caddy/README.md`
- Modify: `caddy/RELEASE_NOTES.md`

**Interfaces:**
- Consumes: content-addressed `config` names and `{ configName }` API from Task 1.
- Produces: published extension/model version `2026.08.12.1` and explicit migration instructions.

- [ ] **Step 1: Update versions**

Set both `model.version` in `caddy/caddy.ts` and `version` in `caddy/manifest.yaml` to `2026.08.12.1`, the value returned by `swamp extension version --manifest manifest.yaml --json`.

- [ ] **Step 2: Update the README contract**

Replace language implying raw JSON validation/apply with the actual flow: render creates a SHA-256-named config artifact; `validateConfig` and `applyConfig` accept its `configName`; method outputs carry success/failure metadata; `applyReverseProxy` remains the combined operation.

- [ ] **Step 3: Overwrite release notes**

Use this release-focused content:

```markdown
## 2026.08.12.1

**Changed:** Rendered Caddy configurations now use their SHA-256 digest as the
artifact name, so validation and deployment refer to exact configuration
content instead of mutable `current` outputs.

**Changed:** Validation and apply results are recorded by swamp method outputs;
the redundant `validation` and `apply` data resources are no longer produced.

**Fixed:** Compound apply methods no longer return duplicate data instance names
after successfully updating the remote Caddy service.

**Upgrade note:** `validateConfig` and `applyConfig` now require `configName`
instead of `configJson`. Run `renderReverseProxy` first and pass its config
artifact name. Replace consumers of `validation/current` and `apply/current`
with the corresponding swamp method output or `@swamp/method-summary` report.
```

- [ ] **Step 4: Run complete extension verification**

Run: `deno task check && deno task lint && deno task fmt && deno task test && deno task swampfmt && deno task swampquality`

Expected: all commands exit 0; quality reports 10/10 or no actionable defect.

- [ ] **Step 5: Inspect the final diff**

Run: `git diff --check && git status --short && git diff -- caddy docs/superpowers`

Expected: only the approved Caddy implementation, tests, release metadata, README, design, and plan are changed; no generated or unrelated files appear.
