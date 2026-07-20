# @evrardjp/kind-cluster-pool

Maintains a desired-size pool of local [kind](https://kind.sigs.k8s.io/)
clusters for test workloads.

## Model Type

`@evrardjp/kind-cluster-pool`

The model can initialize the pool, atomically reserve and release clusters,
reconcile replacements, and report pool health. Reservation atomicity relies on
Swamp's exclusive per-model-instance lock, which is held for the full method
execution and serializes concurrent reservations of the same pool. Kubeconfigs
are returned as base64-encoded data.

The host running Swamp must provide the configured `kindBinary` and a working
container runtime. `initialize` and `sync` create or delete real clusters.
Pool size is limited to 20, and cluster create/delete operations run with at
most four concurrent subprocesses. `initialize force=true` is rejected once
state exists because replacing tracked state could orphan live clusters; use
`sync` or explicitly remove the existing clusters first.

## Example

```yaml
globalArguments:
  n: 3
  clusterNamePrefix: ci-pool
  kindBinary: kind
  kindConfig: |
    kind: Cluster
    apiVersion: kind.x-k8s.io/v1alpha4
```

Initialize once, then reserve a cluster for a test run:

```bash
swamp model method run test-cluster-pool initialize
swamp model method run test-cluster-pool reserve --input testId=integration-42
```

Call `release` with the returned cluster ID after the workload finishes. The
release marks that cluster for deletion; a later `sync` removes it and creates
a replacement. This separation keeps reservation fast while allowing cleanup
and replenishment to run as one serialized fan-out operation. Kubeconfig data
is sensitive infrastructure access material and should be handled accordingly.
