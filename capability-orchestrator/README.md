# @evrardjp/capability-orchestrator

Capability catalog and planner models for Swamp.

The catalog is manually maintained as a Swamp model definition. The planner
combines the catalog with VM facts from a fleet/pool model and emits dependency
waves that workflows can execute.

## Models

- `@evrardjp/capability-catalog`
  - method: `publish`
  - reads `globalArguments.capabilities`
  - writes one `capability` resource per capability plus `summary/current`

- `@evrardjp/capability-plan`
  - method: `plan`
  - reads `globalArguments.vms` and `globalArguments.capabilities`
  - writes `plan/current` with ordered `waves`

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

    gitea:
      requires: [base-arch, nginx-stream]
      implementation:
        type: workflow
        workflowIdOrName: gitea-guarantee
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
            "type": "workflow",
            "workflowIdOrName": "ssh-capability"
          }
        }
      ]
    }
  ]
}
```

Workflows should execute waves in order and items within a wave in parallel.
