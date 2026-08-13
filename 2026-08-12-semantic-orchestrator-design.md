# Semantic Orchestrator

## Status

This specification supersedes
`2026-08-11-capability-based-workflow-generator-design.md` and its implementation
plan. The previous design treated capability orchestration too narrowly as task
copying plus dependency edges and retained a runtime shim input contract.

## Goal

Create a new extension, `@evrardjp/semantic-orchestrator`, that compiles desired
capabilities and arbitrary facts into a standalone swamp workflow. The compiler
preserves semantic dependencies, folds compatible contributions into aggregate
operations, and serializes operations that are semantically independent but
unsafe to execute concurrently.

The existing `@evrardjp/capability-orchestrator` extension remains unchanged
during migration and can be deprecated separately after successful adoption.

## Inputs

The model receives four global arguments:

```yaml
globalArguments:
  targetWorkflowName: lab-generated-apply

  facts:
    development-vm:
      vm:
        ipAddress: 192.168.164.40
        sshUser: admin
      ssh:
        reachable: true

  requests:
    development-vm:
      - developer-workstation

  capabilities: {}
```

`facts` and `requests` are keyed maps. Each fact key identifies one compilation
target and one `scope: fact` coordination boundary. Fact payloads are arbitrary,
namespaced data assembled through CEL before model invocation. The compiler does
not know what VM, SSH, or any other source means and does not fetch data itself.

Every request key must exist in `facts`. A fact may have no requests. Facts do
not require an embedded `name` or `capabilities` field.

Templates can reference:

- `@{factKey}`
- `@{facts.<namespace>.<field>}`
- `@{aggregate.<input>}` within aggregate implementations

Exact templates retain the source value type. Templates embedded in larger
strings convert values to strings. Unknown paths fail compilation.

## Capability Kinds

### Executable Capability

An executable capability describes one normal swamp task:

```yaml
developer-mise-setup:
  description: Configure user-scoped mise tools.
  requires:
    - developer-packages
  implementation:
    type: workflow
    workflowIdOrName: lab-capability-mise
    inputs:
      username: admin
      home: /home/admin
      nodeHost: '@{facts.vm.ipAddress}'
      nodeUser: '@{facts.vm.sshUser}'
```

Implementations support literal `workflow` and `model_method` swamp tasks.
Rendered implementation fields become the generated task directly. The compiler
does not inject `host`, `capability`, `vm`, `facts`, or `implementationInputs`.
Referenced workflows must define and receive ordinary explicit swamp inputs.

### Aggregate Capability

An aggregate capability is executable and declares which contribution values it
accepts:

```yaml
packages-installation:
  description: Install all requested packages in one transaction.
  requires:
    - arch-pacman-refresh
  aggregate:
    inputs:
      packages:
        merge: unique-sorted
  coordination:
    group: pacman
    scope: fact
  implementation:
    type: model_method
    modelType: '@adam/cfgmgmt/pacman'
    modelName: lab-@{factKey}-packages
    methodName: apply
    globalArgs:
      packages: '@{aggregate.packages}'
      ensure: present
      nodeHost: '@{facts.vm.ipAddress}'
      nodeUser: '@{facts.vm.sshUser}'
    inputs: {}
```

Version one supports one merge operation: `unique-sorted`. It accepts arrays,
concatenates them, removes duplicate values, and sorts them deterministically.
Incompatible values fail compilation.

### Contribution Capability

A contribution capability is a real requested semantic capability whose
execution is absorbed by a named aggregate:

```yaml
docker-packages:
  description: Add Docker to the fact's package transaction.
  requires:
    - packages-installation
  contributes:
    to: packages-installation
    values:
      packages:
        - docker
```

A contribution has no implementation and emits no job. It is satisfied when its
aggregate job succeeds. A capability cannot define both `contributes` and
`implementation`. Contributions to missing or non-aggregate capabilities,
unknown aggregate inputs, and incompatible value types fail compilation.

Contribution dependencies are still semantic. The compiler resolves them and
rewrites effective edges after folding. Requirements on a contribution point to
its aggregate job. A contribution's non-aggregate prerequisites become
prerequisites of the aggregate job. A contribution requiring its own aggregate
does not create an aggregate self-edge.

## Relation Types

The source manifest represents two different classes of relation.

### Semantic Dependencies

`requires` means the required capability must be satisfied first. These edges
express intent and participate in transitive request resolution.

### Operational Coordination

`coordination` means effective jobs are semantically independent but must not
overlap:

```yaml
coordination:
  group: pacman
  scope: fact
```

Supported scopes:

- `fact`: serialize group members only within the same fact key.
- `global`: serialize group members across all fact keys.

Coordination applies only to effective executable jobs after contribution
folding. The compiler first computes a stable semantic topological order. For
each coordination bucket, jobs already ordered by semantic reachability retain
that direction; otherwise stable effective job keys determine their order. The
compiler sorts the bucket by that combined order and adds an edge between each
adjacent pair unless the earlier job already reaches the later job. This creates
one serial chain without adding every possible pairwise edge. The compiler
rejects any final cycle.

Coordination edges are compiler output, not semantic `requires` relationships.
The compilation report distinguishes both kinds.

## Compilation

The `compile` method performs these phases:

1. Validate fact, request, capability, aggregate, contribution, and coordination
   schemas.
2. Validate unique capability names and all referenced capabilities.
3. Resolve each fact's requested capabilities and transitive semantic
   requirements; reject cycles.
4. Fold contribution capabilities into their target aggregates per fact.
5. Merge aggregate values with the declared merge operation.
6. Rewrite dependencies from virtual contribution nodes to effective aggregate
   nodes while preserving non-aggregate prerequisites.
7. Render each effective implementation from `factKey`, `facts`, and aggregate
   values.
8. Create one effective job per executable fact/capability pair.
9. Add exact semantic `succeeded` edges.
10. Add deterministic coordination edges for fact and global buckets.
11. Validate the final DAG and strict generated workflow shape.
12. Serialize canonical YAML and compute its SHA-256 content hash.

Equivalent effective inputs must produce byte-identical workflow YAML and
content hashes. Timestamps are resource metadata and are excluded from YAML and
hashing. All keys, arrays whose order is not semantic, jobs, dependencies,
contributions, and report records use a total code-unit ordering.

The generated workflow omits `id`; swamp assigns and preserves the materialized
workflow ID. Generated tasks are ordinary swamp `model_method` or `workflow`
tasks. The workflow has no runtime dependency on semantic-orchestrator.

## Outputs

### Workflow Draft

`workflowDraft/current` contains:

- `targetWorkflowName`
- `workflowYaml`
- `contentHash`
- `compiledAt`

### Compilation Report

`compilationReport/current` contains:

- requests and transitively resolved capabilities per fact;
- contribution capabilities and their target aggregates;
- merged aggregate values per fact;
- effective jobs and rendered task type/target;
- semantic edges with their originating capability requirement;
- coordination buckets and compiler-added operational edges;
- deterministic summary counts;
- `compiledAt`.

No output resource is written when compilation fails. Errors identify the fact
key, capability, and relation where applicable.

## Materialization

Materialization remains CLI composition outside the compiler:

1. Run the compiler model.
2. Read `workflowDraft/current`.
3. Create `targetWorkflowName` through swamp if it does not exist.
4. Pipe `workflowYaml` to `swamp workflow edit`.
5. Validate the materialized workflow.
6. Run it.

No custom workflow persistence API or shell integration model is added. The
repository may expose this composition through mise.

## Validation And Tests

Extension tests cover:

- semantic chains and diamonds;
- transitive request resolution per keyed fact;
- arbitrary namespaced fact rendering and exact-value type preservation;
- literal workflow and model-method task generation with no injected inputs;
- contribution folding into one aggregate job;
- requirements on contributions rewritten to aggregate jobs;
- contribution prerequisites preserved on aggregate jobs;
- duplicate package values removed and results sorted;
- missing aggregates, non-aggregate targets, unknown aggregate inputs, and
  incompatible contribution values rejected;
- semantic and contribution cycles rejected;
- fact-scoped coordination isolated by fact key;
- global coordination spanning fact keys;
- semantic order preserved within coordination buckets;
- deterministic ordering for otherwise independent coordinated jobs;
- final-cycle rejection;
- byte-identical YAML, hashes, and report structures excluding `compiledAt`
  under shuffled equivalent inputs and Unicode collation edge cases;
- prototype-sensitive fact keys preserved safely;
- direct generated-workflow recursion rejected;
- structured report provenance for semantic and operational edges;
- resource writes occur only after successful compilation.

Integration verification covers structural validation against the swamp workflow
schema, initial materialization, workflow ID preservation, and execution behavior
where failed jobs block semantic dependents while unrelated branches continue.

`workflowDraft/current.workflowYaml` omits `id`. Structural validation parses the
draft, adds a fixed fake ID to a temporary in-memory value because swamp's schema
requires one, and validates that value without creating, editing, or passing the
workflow back to swamp. The fake ID is never serialized, hashed, or stored.

## Migration

Migration is phased and does not modify the old extension in place:

1. Implement and publish `@evrardjp/semantic-orchestrator` as a separate package.
2. Convert local capability data to separate keyed `facts`, `requests`, and
   `capabilities` inputs.
3. Replace implicit pacman detection with explicit aggregate and contribution
   declarations.
4. Add fact/global coordination declarations where practical mutual exclusion
   is required.
5. Change referenced `lab-capability-*` workflows from the generic
   `{host, capability, vm, implementationInputs}` shim contract to ordinary
   explicit inputs. Catalog implementations provide every required input,
   including rendered facts where needed.
6. Generate, inspect, materialize, validate, and execute the standalone workflow.
7. Replace local planner/wave tasks and adapters with the semantic compiler path.
8. Update current documentation and the existing success-story blog to explain
   semantic dependencies, aggregation, and operational coordination.
9. Deprecate `@evrardjp/capability-orchestrator` separately only after migration
   succeeds and external-consumer impact is reviewed.

The abandoned capability-based workflow generator release must not be published.
Its pull request is closed as superseded by this design.
