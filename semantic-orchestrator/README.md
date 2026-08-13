# @evrardjp/semantic-orchestrator

Compile keyed facts and requested semantic capabilities into a deterministic,
standalone Swamp workflow. Generated tasks have no runtime dependency on this
extension.

Create a model using type `@evrardjp/semantic-orchestrator` with global arguments
`targetWorkflowName`, `facts`, `requests`, and `capabilities`, then run `compile`
without method arguments.

The method writes `workflowDraft/current` with ID-free canonical YAML and its
SHA-256 hash, plus `compilationReport/current` with resolution, aggregation, and
edge provenance.

Templates support `@{factKey}`, `@{facts.<path>}`, and aggregate implementations
support `@{aggregate.<input>}`. Exact templates preserve types. Embedded templates
stringify values. Unknown paths fail compilation.

Aggregates support `unique-sorted` array merging. Coordination groups serialize
effective jobs per fact or globally while preserving semantic dependencies.

The YAML intentionally omits `id`. Create the target workflow first, then edit it
with the draft while preserving Swamp's assigned ID.

## Example

```yaml
targetWorkflowName: lab-generated-apply
facts:
  development-vm:
    vm:
      ipAddress: 192.168.164.40
requests:
  development-vm: [developer-workstation]
capabilities:
  developer-workstation:
    implementation:
      type: workflow
      workflowIdOrName: lab-capability-workstation
      inputs:
        nodeHost: '@{facts.vm.ipAddress}'
```

An aggregate and contribution make package installation one effective job:

```yaml
packages-installation:
  aggregate:
    inputs:
      packages: { merge: unique-sorted }
  implementation:
    type: model_method
    modelType: '@adam/cfgmgmt/pacman'
    modelName: lab-@{factKey}-packages
    methodName: apply
    globalArgs:
      packages: '@{aggregate.packages}'
    inputs: {}
docker-packages:
  contributes:
    to: packages-installation
    values:
      packages: [docker]
```

Compilation performs all schema, graph, template, and workflow-shape validation
before either output resource is written. For workflow-shape validation it adds a
fixed fake ID only to a temporary in-memory object because Swamp's schema requires
an ID. That value is never serialized, hashed, stored, or passed to Swamp.
