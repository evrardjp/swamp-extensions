import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./kind_cluster_pool.ts";

Deno.test("kind-cluster-pool exposes its lifecycle methods", () => {
  assertEquals(model.type, "@evrardjp/kind-cluster-pool");
  for (const method of ["initialize", "reserve", "release", "sync", "status"]) {
    assert(method in model.methods);
  }
});

Deno.test("kind-cluster-pool applies safe naming defaults", () => {
  const parsed = model.globalArguments.parse({ n: 2, kindConfig: "kind: Cluster" });
  assertEquals(parsed.clusterNamePrefix, "swamp-pool");
  assertEquals(parsed.kindBinary, "kind");
});
