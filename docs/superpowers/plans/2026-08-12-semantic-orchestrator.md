# Semantic Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@evrardjp/semantic-orchestrator`, which deterministically compiles keyed facts, requests, and capability definitions into an ID-free standalone Swamp workflow and a provenance report.

**Architecture:** One model source owns strict Zod input/output schemas and a pure compilation pipeline: resolve semantic nodes, fold contributions, render tasks, add semantic and coordination edges, validate the final DAG, canonicalize YAML, and hash it. One colocated test file exercises the public compile method and validates emitted workflow structure by temporarily adding a fixed fake ID in memory; no workflow is sent to Swamp.

**Tech Stack:** TypeScript strict mode, Deno, Zod 4, `@std/yaml`, `@std/assert`, Web Crypto SHA-256.

## Global Constraints

- The existing `@evrardjp/capability-orchestrator` remains unchanged.
- Generated YAML and content hashes exclude timestamps and workflow IDs.
- All non-semantic ordering uses total UTF-16 code-unit ordering, never locale collation.
- Only `workflow` and `model_method` tasks and `unique-sorted` aggregate merges are supported.
- Compilation failures write no resources.
- The manifest version is `2026.08.12.1` and requires matching `RELEASE_NOTES.md`.

---

### Task 1: Compiler Model And Core Semantics

**Files:**
- Create: `semantic-orchestrator/semantic_orchestrator.ts`
- Create: `semantic-orchestrator/semantic_orchestrator_test.ts`
- Create: `semantic-orchestrator/deno.json`

**Interfaces:**
- Consumes: compile arguments `{ targetWorkflowName, facts, requests, capabilities }`.
- Produces: exported `model` with `methods.compile.execute(...)`, writing `workflowDraft/current` and `compilationReport/current` only after successful compilation.

- [ ] **Step 1: Write failing public-method tests**

Cover chains, diamonds, transitive resolution, exact and embedded templates, arbitrary fact namespaces, prototype-sensitive keys, literal task generation, missing references, semantic cycles, and no writes on failure. Assert generated jobs have exactly one step and no injected shim inputs.

- [ ] **Step 2: Run tests and confirm failure**

Run: `deno test semantic_orchestrator_test.ts`
Expected: FAIL because `semantic_orchestrator.ts` does not exist.

- [ ] **Step 3: Implement strict schemas and semantic compilation**

Define discriminated capability schemas for executable, aggregate, and contribution forms. Parse keyed records safely, reject direct workflow recursion, resolve each fact independently with DFS cycle detection, map each effective capability to deterministic job key `${factKey}:${capability}`, render only `factKey`, `facts.*`, and aggregate templates, and construct exact job-level succeeded dependencies.

- [ ] **Step 4: Run tests and confirm pass**

Run: `deno test semantic_orchestrator_test.ts`
Expected: PASS.

### Task 2: Aggregation And Coordination

**Files:**
- Modify: `semantic-orchestrator/semantic_orchestrator.ts`
- Modify: `semantic-orchestrator/semantic_orchestrator_test.ts`

**Interfaces:**
- Consumes: resolved virtual capability graph from Task 1.
- Produces: folded aggregate jobs, rewritten semantic edges, merged aggregate values, and deterministic operational edges.

- [ ] **Step 1: Add failing aggregation tests**

Cover one aggregate job per fact, duplicate removal, code-unit sorting, contribution self-edge removal, contribution prerequisite preservation, requirements on contributions, missing/non-aggregate targets, unknown inputs, incompatible non-array values, and contribution cycles.

- [ ] **Step 2: Add failing coordination tests**

Cover fact bucket isolation, global buckets, semantic direction preservation, deterministic ordering of independent jobs, chain-only operational edges, and final cycle rejection.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `deno test semantic_orchestrator_test.ts`
Expected: FAIL on aggregation and coordination assertions.

- [ ] **Step 4: Implement folding and coordination**

Collect requested contributions by aggregate input, concatenate arrays, deduplicate by deterministic canonical value representation, sort by code-unit order, redirect virtual contribution endpoints to aggregate jobs, and discard aggregate self-edges. Compute semantic reachability before sorting each coordination bucket; preserve reachable direction and otherwise order by effective job key, adding only adjacent edges not already implied.

- [ ] **Step 5: Run tests and confirm pass**

Run: `deno test semantic_orchestrator_test.ts`
Expected: PASS.

### Task 3: Canonical Artifact And Report

**Files:**
- Modify: `semantic-orchestrator/semantic_orchestrator.ts`
- Modify: `semantic-orchestrator/semantic_orchestrator_test.ts`

**Interfaces:**
- Consumes: final jobs and classified edges from Task 2.
- Produces: canonical `workflowYaml`, SHA-256 `contentHash`, and deterministic report records plus `compiledAt`.

- [ ] **Step 1: Add failing determinism and provenance tests**

Compile shuffled equivalent inputs including Unicode keys, compare YAML and hashes byte-for-byte, compare reports after deleting `compiledAt`, verify semantic requirement provenance and coordination bucket provenance, and assert summary counts.

- [ ] **Step 2: Add failing structural validation test**

Parse `workflowYaml`, assert `id` is absent, add fixed fake ID `00000000-0000-4000-8000-000000000000` only to the temporary object, and validate its strict shape against a local Zod schema matching the installed Swamp workflow schema. Do not call workflow create/edit/validate.

- [ ] **Step 3: Run tests and confirm failure**

Run: `deno test semantic_orchestrator_test.ts`
Expected: FAIL on missing canonical serialization/report output.

- [ ] **Step 4: Implement canonical output**

Recursively sort object keys by `(a < b ? -1 : a > b ? 1 : 0)`, explicitly sort all report arrays whose order is non-semantic, serialize with `@std/yaml`, hash the exact UTF-8 YAML bytes using `crypto.subtle.digest("SHA-256", ...)`, and append one shared `compiledAt` only to stored resources.

- [ ] **Step 5: Run tests and confirm pass**

Run: `deno test semantic_orchestrator_test.ts`
Expected: PASS.

### Task 4: Extension Packaging And Repository Registration

**Files:**
- Create: `semantic-orchestrator/.swamp.yaml`
- Create: `semantic-orchestrator/.gitignore`
- Create: `semantic-orchestrator/manifest.yaml`
- Create: `semantic-orchestrator/README.md`
- Create: `semantic-orchestrator/RELEASE_NOTES.md`
- Create: `semantic-orchestrator/LICENSE.txt`
- Modify: `README.md`
- Modify: `.github/workflows/daily-extension-testing.yml`
- Modify: `.github/workflows/extension-testing.yml`
- Modify: `.github/workflows/extension-publish.yml`
- Create: `.github/workflows/extension-testing-semantic-orchestrator.yml`

**Interfaces:**
- Consumes: exported model from Task 1.
- Produces: publishable extension package and CI coverage consistent with existing extension registrations.

- [ ] **Step 1: Add extension metadata**

Create manifest `@evrardjp/semantic-orchestrator` version `2026.08.12.1`, register `semantic_orchestrator.ts`, include README and license, pin `@std/yaml` and test dependencies in `deno.json`, and document compile inputs, output resources, supported templates, aggregation, coordination, and ID-free materialization.

- [ ] **Step 2: Register repository and CI entries**

Add the extension to root README layout/catalog and each extension matrix/list following `capability-orchestrator`; add its dedicated reusable test workflow.

- [ ] **Step 3: Run complete verification**

Run from `semantic-orchestrator/`: `deno task check`, `deno task lint`, `deno fmt --check`, `deno task test`, `swamp extension fmt manifest.yaml --check`, and `swamp extension quality manifest.yaml`.
Expected: all commands pass and quality reports 10/10.

- [ ] **Step 4: Inspect final diff**

Run: `git status --short && git diff --check && git diff -- semantic-orchestrator README.md .github/workflows 2026-08-12-semantic-orchestrator-design.md docs/superpowers/plans/2026-08-12-semantic-orchestrator.md`
Expected: only intended new extension, registration, design clarification, and plan changes; no whitespace errors.
