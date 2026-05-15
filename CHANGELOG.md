# Changelog

All notable changes to `@kepello/nodegraph-clusters`. Format follows [Keep a Changelog](https://keepachangelog.com/).

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
