# @evrardjp/capability-orchestrator

Capability catalog, planner, and concrete workflow generator models for Swamp.

The catalog is manually maintained as a Swamp model definition. The planner
combines the catalog with VM facts from a fleet/pool model and emits dependency
waves that workflows can execute. Capability implementations may be either
workflow calls or direct `model_method` calls. Direct model methods can use
`@{host}`, `@{capability}`, and `@{vm.<field>}` placeholders that the planner
materializes per target VM.

## Models

- `@evrardjp/capability-catalog`
  - method: `publish`
  - reads `globalArguments.capabilities`
  - writes one `capability` resource per capability plus `summary/current`

- `@evrardjp/capability-plan`
  - method: `plan`
  - reads `globalArguments.vms` and `globalArguments.capabilities`
  - writes `plan/current` with ordered `waves`

- `@evrardjp/capability-based-workflow-generator`
  - method: `generate`
  - reads `globalArguments.targetWorkflowName`, `globalArguments.vms`, and
    `globalArguments.capabilities`
  - writes `workflowDraft/current` with deterministic `workflowYaml`, its
    `contentHash`, compilation metadata, and requested and resolved capabilities

## Catalog shape

```yaml
globalArguments:
  capabilities:
    docker:
      requires: [base-arch]
      implementation:
        type: workflow
        workflowIdOrName: docker-capability
        inputs: {}

    gitea-package:
      requires: [base-arch]
      implementation:
        type: model_method
        modelType: "@adam/cfgmgmt/pacman"
        modelName: lab-@{host}-gitea-package
        methodName: apply
        globalArgs:
          packages: [gitea]
          ensure: present
          nodeHost: "@{vm.ipAddress}"
          nodeUser: "@{vm.sshUser}"
          nodePort: 22
        inputs: {}
```

## Planner input shape

The planner is usually wired with CEL from Swamp data:

```yaml
globalArguments:
  vms: ${{ data.findBySpec("lab-vm-pool", "vm").map(x, x.attributes) }}
  capabilities: ${{ data.findBySpec("lab-capability-catalog", "capability").map(x, x.attributes) }}
```

## Output shape

```json
{
  "waves": [
    {
      "name": "wave-0",
      "index": 0,
      "items": [
        {
          "host": "gitea",
          "capability": "ssh",
          "implementation": {
            "type": "model_method",
            "modelType": "@keeb/ssh/host",
            "modelName": "lab-gitea-ssh-capability",
            "methodName": "waitForConnection",
            "inputs": { "host": "192.0.2.12", "user": "admin", "timeout": 360 }
          }
        }
      ]
    }
  ]
}
```

`@evrardjp/capability-plan` remains available for consumers that execute ordered
waves. The generator instead emits concrete jobs with exact dependency edges:

```yaml
jobs:
  - name: node1:app
    dependsOn:
      - job: node1:left
        condition: { type: succeeded }
      - job: node1:right
        condition: { type: succeeded }
  - name: node1:left
    dependsOn:
      - job: node1:base
        condition: { type: succeeded }
```
