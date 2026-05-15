# @kepello/nodegraph-clusters

Recovered-cluster overlay for [`@kepello/nodegraph`](https://github.com/kepello/nodegraph-core). Third layer of the Layered Code Abstraction arc (L3 in [Fathom's roadmap](https://github.com/kepello/Fathom/blob/main/docs/code_abstraction.md#l3--software-clustering-module--component-recovery)).

Groups L0 element nodes (classes, top-level functions) into cohesive modules / components by running Louvain community detection over their dependency graph. Methods inherit their parent class's cluster. Each cluster gets a stable content-hashed identity and a TF-IDF-derived name.

## Quick start

```ts
import { GraphLayerImpl } from "@kepello/nodegraph-core";
import { InMemoryBackend } from "@kepello/nodegraph-core/in-memory";
import { makeClusterOverlay, computeClusters } from "@kepello/nodegraph-clusters";

const graph = new GraphLayerImpl(new InMemoryBackend());
const clusters = makeClusterOverlay(graph);

// Compute cluster assignments from an L0 element-dependency graph.
const result = computeClusters({
  elements: [
    { id: "A", name: "Foo", contentHash: "h1" },
    { id: "B", name: "Bar", contentHash: "h2" },
    { id: "C", name: "Baz", contentHash: "h3" },
  ],
  dependencies: [
    { source: "A", target: "B", weight: 1 },
    { source: "B", target: "A", weight: 1 },
    { source: "C", target: "C", weight: 0 },
  ],
});

// Persist each cluster as a node in the graph.
for (const cluster of result.clusters) {
  clusters.insertCluster(cluster);
}
```

## Surface

- **Overlay**: `makeClusterOverlay(graph)` registers the `"cluster"` domain and returns `ClusterOverlay` with insert / read APIs.
- **Algorithm**: `computeClusters({ elements, dependencies })` runs deterministic Louvain (fixed seed) and returns `{ clusters, assignments }` where each cluster carries a stable `clusterId = hash(sorted contentHashes of members)` and a TF-IDF-derived `name` from member identifiers.
- **Naming**: `nameClusterFromIdentifiers(identifiers)` exposes the standalone TF-IDF naming heuristic.

## Trade-offs

- Flat (non-hierarchical) clustering in v1. Multi-resolution dendrograms are a follow-on (Fathom `l3-hierarchical-clustering` 3.1.3.3).
- Cluster ids drift when membership shifts > 50% (intrinsic to content-hash identity).
- Lexical features used for naming only, not for clustering decisions.
- Cluster-level `dependsOn` edges are aggregate counts per target, not weighted per edge-type.
