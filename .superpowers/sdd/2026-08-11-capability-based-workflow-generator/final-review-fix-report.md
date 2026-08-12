# Final Review P2 Fix Report

## Status

Implemented exactly the three P2 findings in the final review brief. No Minor
findings were addressed, and nothing was published or pushed.

## Findings And Fixes

### 1. Same-collector package self-dependency

- Finding: a package-only capability requiring another package-only capability
  assigned to the same collector caused the effective collector node to depend
  on itself.
- Exact fix: after translating package-only requirements to effective collector
  keys, filter out only the current graph node key. Dependencies on a different
  collector remain intact.
- Covering test: `capability-orchestrator/capability_plan_test.ts`, `graph
  collapses same-collector package dependencies`.

### 2. Ambiguous colon-delimited graph keys

- Finding: `${host}:${capability}` graph keys collided when a VM or capability
  name contained `:`.
- Exact fix: reject VM and capability names containing `:` in the existing name
  validation before catalogs, records, or graph keys are constructed. Errors
  identify the kind and rejected name.
- Covering test: `capability-orchestrator/capability_plan_test.ts`, `graph
  rejects names that make host capability keys ambiguous`, with separate VM and
  capability collision cases.

### 3. Locale-dependent deterministic ordering

- Finding: `localeCompare` did not provide a total environment-independent
  comparator for graph summaries, nodes, dependencies, generated YAML, and
  hashes.
- Exact fix: export and reuse one code-unit comparator,
  `(a, b) => a < b ? -1 : a > b ? 1 : 0`, for unique dependency/package
  sorting, VM order, requested/resolved arrays, graph nodes, wave nodes,
  generator VM capability normalization, and recursive object-key
  canonicalization.
- Covering test:
  `capability-orchestrator/capability_workflow_generator_test.ts`, `compiler
  orders Unicode names and nested keys by code unit`. It shuffles `é` and
  `e\u0301` capability names, VM capability order, capability input order, and
  nested object insertion order, then asserts byte-identical YAML and hashes.

## TDD Evidence

### RED

Planner command:

```bash
~/.swamp/deno/deno test capability-orchestrator/capability_plan_test.ts
```

Expected result:

```text
graph rejects names that make host capability keys ambiguous ... FAILED
AssertionError: Expected function to throw.

graph collapses same-collector package dependencies ... FAILED
Actual dependsOn: ["node1:packages"]
Expected dependsOn: []

FAILED | 7 passed | 2 failed
```

Generator command:

```bash
~/.swamp/deno/deno test capability-orchestrator/capability_workflow_generator_test.ts
```

Expected result:

```text
compiler orders Unicode names and nested keys by code unit ... FAILED
AssertionError: Values are not equal.
The YAML diff showed reversed composed/decomposed capability jobs, VM
capability arrays, and nested implementation input keys.

FAILED | 4 passed | 1 failed
```

These failures directly reproduced all three findings before production code
changed.

### GREEN

Focused command:

```bash
~/.swamp/deno/deno test capability-orchestrator/capability_plan_test.ts capability-orchestrator/capability_workflow_generator_test.ts
```

Result:

```text
ok | 14 passed | 0 failed (129ms)
```

One intermediate planner run had 8 passing tests and one assertion-message
failure because the test expected `Capability` while the existing error kind is
`capability`; correcting only the expected capitalization produced the focused
GREEN result above.

## Full Verification

Full suite:

```bash
~/.swamp/deno/deno test capability-orchestrator
```

```text
ok | 17 passed | 0 failed (178ms)
```

Formatting:

```bash
~/.swamp/deno/deno fmt --check capability-orchestrator/*.ts
```

```text
Checked 6 files
```

Lint:

```bash
~/.swamp/deno/deno lint capability-orchestrator
```

```text
Checked 6 files
```

Type check:

```bash
~/.swamp/deno/deno check capability-orchestrator/*.ts
```

```text
Check capability-orchestrator/capability_catalog_test.ts
Check capability-orchestrator/capability_catalog.ts
Check capability-orchestrator/capability_plan_test.ts
Check capability-orchestrator/capability_plan.ts
Check capability-orchestrator/capability_workflow_generator_test.ts
Check capability-orchestrator/capability_workflow_generator.ts
```

Whitespace validation:

```bash
git diff --check
```

Result: exit 0 with no output.

An initial directory-wide `deno fmt --check capability-orchestrator` also
reported pre-existing wrapping in `capability-orchestrator/RELEASE_NOTES.md` in
addition to two touched TypeScript files. The touched files were formatted; the
unrelated release notes were deliberately not changed. The complete extension
TypeScript format check above passes.

## Files Changed

- `capability-orchestrator/capability_plan.ts`
- `capability-orchestrator/capability_plan_test.ts`
- `capability-orchestrator/capability_workflow_generator.ts`
- `capability-orchestrator/capability_workflow_generator_test.ts`
- `.superpowers/sdd/2026-08-11-capability-based-workflow-generator/final-review-fix-report.md`

## Self-Review

- Verified colon validation runs before graph construction and covers both VM
  and capability names.
- Verified the collector self-edge filter compares the fully qualified current
  node key, preserving ordinary dependencies and dependencies on other package
  collectors.
- Verified all `localeCompare` and default graph/generator sorts affecting
  summaries, nodes, dependencies, waves, YAML, or hashes were replaced by the
  shared comparator.
- Verified recursive canonicalization uses the same comparator while retaining
  array semantics.
- Verified the old graph/planner output shape is unchanged for accepted inputs.
- Verified no Minor review findings, release metadata, publication, or push was
  included.

## Concerns

- Directory-wide formatting remains blocked only by pre-existing Markdown
  wrapping in `capability-orchestrator/RELEASE_NOTES.md`; all extension
  TypeScript files pass format checking.
