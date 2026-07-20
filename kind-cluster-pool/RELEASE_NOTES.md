## 2026.07.20.1

**Added:** Initial release of `@evrardjp/kind-cluster-pool`, with desired-size
initialization, atomic reservation, release, reconciliation, replacement, and
health reporting for local kind test clusters.

**Upgrade note:** The Swamp execution host must provide kind and a working
container runtime.

**Changed:** Pool size and subprocess concurrency are bounded, force
reinitialization cannot orphan existing clusters, and discovery failures abort
reconciliation.
