# Changelog

All notable changes to `@kepello/nodegraph-clusters`. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.2.0] — 2026-05-17

Additive — `computeClusters` now guarantees output determinism regardless of input element / dependency ordering. Closes Fathom row 5.0.7 (`louvain-l3-non-determinism`).

### Fixed

- Two sequential `fathom analyze` runs on the same unchanged workspace had produced different L3 cluster counts (885 vs 892). Even with a seeded RNG, Louvain's modularity heuristic processes nodes in graph-insertion order during community-merge iteration, so ambiguous community boundaries can resolve differently when the caller's `queryNodes` / `queryEdges` return rows in a different order across runs. Fix: sort `input.elements` by id and `input.dependencies` by `(source, target)` at the top of `computeClusters` before constructing the graphology graph. All downstream loops (community grouping, dependsOn aggregation, final assignment map) iterate the same canonical sorted list.

### Tests

- New `computeClusters — determinism: reordered inputs produce identical clusters (row 5.0.7)` test exercises a 200-node graph with ambiguous community boundaries; runs against canonical, reversed, and shuffled inputs and asserts identical `clusterId` sets. 11/11 tests pass.

### Compatibility

- Output values may shift on a given graph relative to 0.1.x (the algorithm walks a deterministically-sorted node order now, not whatever order the caller happened to pass), but become stable across re-runs. Callers that cached cluster IDs from 0.1.x will see one invalidation on first run under 0.2.0; subsequent runs are stable.

## [0.1.0] — 2026-05-14

Initial publish. Third layer of the workspace-level Layered Code Abstraction arc (Fathom work row `l3-cluster-overlay` 3.1.3, per `docs/code_abstraction.md` L3).

### Added

- `CLUSTER_DOMAIN` + `CLUSTER_METADATA_SCHEMA` + indexes (`clusters_by_clusterId`, `clusters_by_language`).
- `ClusterMetadata`, `ClusterInput`, `ClusterNode`, `Cluster`, `ClusterOverlay` interfaces.
- `makeClusterOverlay(graph)` factory — registers the domain + indexes against a `GraphLayer` and returns the overlay.
- `computeClusters({ elements, dependencies, options? })` — runs deterministic Louvain community detection via `graphology-communities-louvain` with a fixed seed (Mulberry32 reset per call); returns `{ clusters, assignments }` where each cluster carries a content-hashed `clusterId`, a TF-IDF-derived `name`, and an aggregated `dependsOn` list to other clusters.
- `nameClusterFromIdentifiers(identifiers)` — standalone TF-IDF naming heuristic over identifier vocabulary.
- Tests on synthetic dependency graphs pinning (a) cluster boundary determinism (same input + seed = same clusters); (b) content-hash identity stability; (c) TF-IDF naming correctness; (d) `dependsOn` aggregation; (e) handling of isolated nodes.

### Heuristic scope (v1 — documented limitations)

- Flat (non-hierarchical) clustering only. Multi-resolution dendrograms parked as Fathom `l3-hierarchical-clustering` (3.1.3.3).
- `clusterId` drifts when cluster membership shifts > 50%; mostly-intact clusters keep their id.
- Lexical features used for naming only, not for clustering decisions (keeps boundaries deterministic).
- Cluster-level `dependsOn` edges are aggregate counts per target, not weighted per edge-type.

### Schema-versioning note

This overlay registers without `schemaVersion` because `nodegraph-core@1.1.1` does not yet enforce the field. When Fathom row `overlay-version-and-migration-substrate` (1.12.2) ships, the registration will be amended to declare `schemaVersion: 1` and the package will major-bump to track the substrate change.
