# Changelog

All notable changes to `@kepello/nodegraph-clusters`. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.11.0] — 2026-06-09

**Cluster identity incorporates member identity** (Fathom row `l3-cluster-count-discrepancy-envisionweb` 5.0.48.2 — the L3-TS baseline M1 forcing bug). Content-only identity (`sha256(sorted member contentHashes)`) collided when two DISJOINT communities had identical member-content multisets — rampant in generated .NET code. EnvisionWeb measured 1,011 emitted → 963 persisted (4.7% silent collapse): colliding clusters merged compute-side (`clusterById` / `elementToCluster` keyed by clusterId, corrupting `dependsOn`/confidence/assignments) AND collapsed persist-side (same naturalKey + contentHash → no-op upsert; the last writer's `reconcileGroupsEdges` orphaned the first community's members).

### Changed

- **BREAKING**: `computeClusterId` now takes `Iterable<ClusterIdentityMember>` (`{identityKey, contentHash}`); identity = sha256 of sorted NUL-delimited pairs. **Deliberate property reversal**: renaming a member (identityKey change, same content) now CHANGES the clusterId — the old "identity tracks behavior, not naming" property was the collision bug. Enrichment survives id churn via `canonicalMemberSetHash` lift-forward (0.6.0 / row 5.0.31), unchanged.
- `ElementInput.identityKey?: string` — rebuild-stable identity for clusterId computation, defaults to `id`. Callers whose ids are transient UUIDs pass the substrate naturalKey (fathom-cli does from `@4.41.0`).
- `computeClusters` now THROWS on duplicate clusterIds across communities (only possible via duplicate `(identityKey, contentHash)` caller input) — fail-loud forcing function instead of silent merge.

### Tests

- 2 collision regressions (singleton×singleton — the generated-code corpus shape; disjoint multi-member identical multisets, incl. unmerged confidence/dependsOn), identityKey cross-rebuild stability, reversed rename pin, delimiter-unambiguity pin. 56 pass.

## [0.10.0] — 2026-05-28

Adopt the per-overlay schema-version stamp (Fathom row 1.12.3). Exports `CLUSTER_SCHEMA_VERSION` (= 1, V1 baseline) and declares it on the overlay's `OverlayRegistration`.

### Changed

- Registration now passes the mandatory `schemaVersion` field added in substrate 1.12.2. Peer dependency on `@kepello/nodegraph-core` retargeted to `^3.0.0`. No behavior change beyond the version stamp.

## [0.9.0] — 2026-05-25

Batch UUID→Node hydration in `reconcileGroupsEdges` + `clusterForElement`. Part of Fathom row `perf-getbyid-consumer-migrations` (5.0.1.2.3.1). Peer-bump `@kepello/nodegraph-core` `^2.2.0` → `^2.3.0`. No behavior change.

### Changed

- `reconcileGroupsEdges`: two IN-clause queries (one for existing-edge targets to check liveness, one for desired-member ids to choose targetId-vs-targetRef branch). Pre-fix did one SQL per existing edge + one per desired member.
- `clusterForElement`: per-edge `getNodeById` loop → one batch `getNodesByIds` + Map lookup.

### Tests

All existing tests pass; no behavior change.

## [0.7.0] — 2026-05-19

Adds — `ClusterOverlay.setEnrichment(clusterId, llmEnrichment)` as the canonical persistence path for LLM enrichment. Fixes latent bug in `renameCluster`. Closes Fathom row 5.0.39 (cluster half). TDD-driven.

### Added

- **`setEnrichment(clusterId, llmEnrichment)`** — writes `metadata.llmEnrichment` and re-reconciles `groups` edges through a private `supersedeWithMetadata` helper. The ONLY correct path to persist LLM enrichment; calling `graph.supersedeNode` directly cascades the cluster's `groups` edges to tombstoned and breaks membership.

### Fixed

- **`renameCluster` no longer strips groups edges**. Prior implementation called `graph.supersedeNode` directly, relying on the substrate cascade — which tombstones outgoing live edges. Now routes through the same `supersedeWithMetadata` helper as `setEnrichment`: captures the prior tip's member-edge targets before supersede, then re-emits them from the new tip via `reconcileGroupsEdges`. Latent bug pre-fix; no production caller was hitting it, but any operator-rename UI would have triggered the cluster-membership wipe.

### Internal

- Extracted `reconcileGroupsEdges(clusterNodeId, desiredMemberElementIds)` from `insertCluster`. Now also called by `supersedeWithMetadata` (renameCluster + setEnrichment) so every metadata-only supersede preserves membership.

### Tests

- 2 new regression tests: `renameCluster — PRESERVES groups edges through supersede (Fathom 5.0.39)` + `setEnrichment — preserves groups edges and writes llmEnrichment (Fathom 5.0.39)`. Both RED pre-fix, GREEN post-fix.
- 49/49 tests pass.

## [0.6.0] — 2026-05-19

Adds — `ClusterInput.canonicalMemberSetHash` + `llmEnrichment` for enrichment-preservation across Louvain re-emissions. Closes Fathom row 5.0.31. TDD-driven (test pinned the invariant before the fix landed).

### Added

- `ClusterInput.canonicalMemberSetHash?: string` — caller-supplied content-hash over sorted member naturalKeys (stable across content changes). The cluster overlay does NOT compute it (it doesn't know member naturalKeys, only their UUIDs); the runner is responsible.
- `ClusterInput.llmEnrichment?: { name?, displayName?, summary?, provenance? }` — fresh enrichment supplied directly. Wins over lifted-forward enrichment.
- `ClusterMetadata.canonicalMemberSetHash` + `ClusterMetadata.llmEnrichment` — persisted on every cluster node carrying either.
- New `clusters_by_canonicalMemberSetHash` index for lookups.
- **Enrichment preservation**: when `insertCluster` runs WITHOUT `input.llmEnrichment` AND WITH `input.canonicalMemberSetHash`, it queries for any live cluster sharing the same canonical member set; if found AND it carries an `llmEnrichment`, that enrichment lifts forward onto the new cluster. Round-6 F1 surfaced this as the headline user-visible regression: Haiku-produced names persist to clusterIds that the 5.0.7.1 tombstone-stale pass clears across re-analyzes; canonical-member-set keying lifts them forward.

### Why

Round-6 pilot F1 (HIGH): `code.bounded_contexts` returned zero rows with `llmName` despite a Haiku-namer run earlier in the session. Root cause: Louvain re-emissions are content-hash-derived; member contentHashes shift across runs, producing fresh clusterIds. The prior Haiku enrichment is attached to clusterIds the new emission doesn't produce. The fix: keep an orthogonal "canonical member set" identity (member naturalKeys, stable across content changes) and lift enrichment forward when it matches.

### Tests

- 3 new regression tests pinning the preservation invariant:
  - "preserves llmEnrichment across re-clustering with same canonical member set"
  - "input llmEnrichment wins over lifted-forward when both present"
  - "does NOT lift forward when canonical member set differs"
- 47/47 tests pass.

### Compat note

Both new `ClusterInput` fields are optional for test-fixture ergonomics. Tracked for removal as Fathom row 5.0.31.1 — trigger: after the production runner reliably populates `canonicalMemberSetHash`.

## [0.5.0] — 2026-05-18

Breaking — `ClusterDependency` field rename: `edgeCount` → split into `rawEdgeCount` + `weightedEdgeCount`. Closes Fathom row 5.0.28 (d).

### Changed

- **Breaking**: `ClusterDependency` interface now exposes two fields instead of one:
  - `rawEdgeCount: number` — integer count of distinct contributing element-level edges crossing the cluster boundary.
  - `weightedEdgeCount: number` — sum of per-edge weights (may be fractional when edge-type weighting is in play per Fathom row 5.0.14's caller-side weights).
- `computeClusters` tracks both counts independently. Pre-prod no migration path; consumers must read the new field names.
- Schema description updated to reflect the dual-field shape.

### Why

Round-5 pilot F14 surfaced `cluster_dependencies.edgeCount` returning fractional values like `15.400000000000007` — a leak of internal weight-sum semantics through a field named "count." Splitting clarifies the two distinct signals (count vs weighted-sum) so consumers can pick the one they want.

### Tests

- Updated existing test to assert both `rawEdgeCount` + `weightedEdgeCount`.
- 44/44 tests pass.

## [0.4.0] — 2026-05-18

Bug fix — `ClusterOverlay.insertCluster` now reconciles `groups` edges against `input.memberElementIds` instead of doing additive emit-if-not-present dedup. Closes Fathom row 5.0.22 (`ghost-cluster-substrate-integrity`).

### Changed

- `insertCluster` walks the cluster's existing live `groups` edges and tombstones any whose target is (a) not in the desired member set, or (b) a non-live node (e.g. previously-superseded element). Then emits fresh edges for any desired member not already represented. Post-call invariant: live `groups` edges from the cluster exactly mirror `input.memberElementIds`.

### Why

Prior code deduped existing edges by `targetId`, then emitted any `input.memberElementIds[i]` not in that set. Two failure modes:

1. **Stale edges on element supersede.** When a member element superseded (new UUID, same naturalKey), the new UUID wasn't in `existingTargets` (which held the old UUID) → fresh edge emitted, but the stale edge pointing at the now-superseded element stayed live. Live edge count inflated beyond `input.memberElementIds.length`. Round-5 pilot saw 6 clusters in the top-50 with `memberCount > originalMemberCount` (`ceb6d698284655e8`, `8524a8e106bd076e`, `2c443cb6126e7fa6`, `01c0178249a71679`, `527f887f3a4a0a64`, `a6522c196dbefff9`).
2. **Lingering edges on drift-down.** When the cluster's member set shrank across re-clusters (e.g. a member left the Louvain community) with the same `contentHash`, dropped members' edges were never tombstoned because the dedup loop only walked the input side, not the existing side.

Reconciliation pattern matches `nodegraph-capability-units`' entry-edge handling. Substrate `tombstoneEdge` was the surgical tool — no substrate-side change needed.

### Tests

- `insertCluster — re-emits groups edges after element supersede (Fathom 5.0.22)` — inserts cluster + 2 members, supersedes one (new UUID), re-calls insertCluster with [newUUID, e2.id]. Asserts `liveMemberCount === 2` and both edges point at live element nodes. Pre-fix would report 3.
- `insertCluster — drops members no longer in input (drift-down)` — inserts cluster + 3 members, re-calls with [m1] only. Asserts `liveMemberCount === 1`. Pre-fix would report 3.
- `insertCluster — re-emits after tombstone cascade (Fathom 5.0.22 ghost variant)` — pins the invariant for the post-tombstone-cascade re-cluster case (this case worked pre-fix; pinning prevents regression).
- 44/44 tests pass (41 prior + 3 new).

### Migration

Pre-0.4.0 graphs may carry stale `groups` edges (inflated cluster membership) or orphaned cluster nodes (0 live members, called "ghost clusters" by Round-5 F1). Rebuild `.fathom/graph.db` after install for a clean state.

## [0.3.0] — 2026-05-17

Additive — `ClusterOverlay.liveMemberCount(clusterId)` returns the current member count derived from live `groups` edges, distinct from `metadata.memberCount` (the at-insert-time snapshot). Closes Fathom row 5.1.4.3 (`mcp-cluster-members-inconsistency`).

### Added

- `ClusterOverlay.liveMemberCount(clusterId): number` — counts live `groups` edges from the cluster node. Returns 0 for unknown clusters or clusters with all members tombstoned. Wraps `membersOf(clusterId).length` for the common case.

### Why

`metadata.memberCount` is set at insert time from the algorithm's computed value and persists across the cluster node's lifetime. When member elements get tombstoned (substrate's `tombstoneNode` cascades to incoming edges, including `groups` edges from this cluster), the cluster's live-edge count drifts below `metadata.memberCount`. On the Fathom workspace this manifested as cluster `43a96f6237e737ea` reporting `metadata.memberCount=132` but having only 1 live `groups` edge — surfaced by the 5.1.4 Opus post-flip pilot as a substrate-correctness gap.

`metadata.memberCount` is retained as the at-insert snapshot (don't change cluster contentHash; preserves the algorithm's intent at the time it ran). Consumers wanting current count use `liveMemberCount`.

### Tests

- `liveMemberCount — reflects live edges, not the at-insert snapshot (row 5.1.4.3)` — inserts a 3-member cluster, tombstones 2 members, asserts metadata.memberCount stays 3 while liveMemberCount returns 1.
- `liveMemberCount — returns 0 for unknown clusterId`.
- 41/41 tests pass (39 prior + 2 new).

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
