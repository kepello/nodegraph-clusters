# Changelog

All notable changes to `@kepello/nodegraph-clusters`. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.17.1] — 2026-07-19

Peer-floor sync, 5.0.139 sweep-gap cascade — no code change. `@kepello/nodegraph-dispositions` peer floor `^0.2.0` → `^0.3.0`: `0.3.0` is the first `nodegraph-dispositions` release to stamp `owner` on the disposition edges it writes (Fathom row 5.0.139), and the 0.x caret doesn't admit the minor bump without this floor update.

### Changed

- `package.json` — `@kepello/nodegraph-dispositions` peer floor `^0.2.0` → `^0.3.0`.

### Tests

Suite unchanged: 67/67 pass. `npm run build` clean.

## [0.17.0] — 2026-07-16

Fathom row 3.1.8.4 (disposition-layer), wave 4 — THE BREAKING WAVE. `nodegraph-clusters` is the wave's reference implementation (it already had full disposition-edge drift reconciliation since wave 3a). The legacy `groups` edge type is RETIRED: `insertCluster`/`renameCluster`/`setEnrichment` no longer emit it, and `clusterForElement`/`membersOf`/`liveMemberCount` no longer read it. `analysis-disposition` edges (kind `groups`, single-kind) are now THE membership record — public `ClusterOverlay` method SIGNATURES are unchanged, but the substrate edge shape underneath every one of them is.

### Changed

- **BREAKING (data shape, not API signature)**: `reconcileGroupsEdges` (the dual-family reconcile helper wave 3a introduced) is deleted; `reconcileDispositionEdges` is now the ONLY reconcile path, called from the same two integration points (`doInsertCluster`, `supersedeWithMetadata`). No more `groups`-typed edges are ever written.
- `clusterForElement` / `membersOf` re-implemented over `analysis-disposition` edges. Reads filter on `metadata.kinds` CONTAINS `"groups"` (a new `hasGroupsKind`/`edgeKinds` helper pair, mirroring `nodegraph-domain-model/src/overlay.ts`'s own `edgeKinds`) — never `subtype` equality, because `analysis-disposition` is a SHARED edge type: an element can be the target of many kinds from many producing domains, and a cluster node's own outgoing edges are the only slice this overlay may assume are all `groups`. `clusterForElement`'s dual `edgesTo` (resolved) + `queryEdges({ targetRef })` (dangling fallback) read path is preserved unchanged.
- `GROUPS_EDGE_TYPE` — **removed** (dead export; the emission it named no longer exists). No other in-repo or in-workspace source consumer imported it (swept the workspace — only this package's own test file did, and that reference is now a package-test-local literal).

### Tests

- 67/67 pass (was 66). RED witnessed first, two families:
  1. The wave-3a coexistence pin ("insertCluster — ALSO emits analysis-disposition edges … for every member") flipped into "insertCluster — emits ONLY analysis-disposition edges (kind groups); legacy groups edges are RETIRED" — RED on pre-fix code (`2 !== 0`: two lingering legacy `groups` edges).
  2. New: "clusterForElement / membersOf / liveMemberCount — work against a store with ONLY analysis-disposition edges" — strips any legacy `groups` edges out from under a normal `insertCluster` call (via a second `CLUSTER_DOMAIN` mutator obtained through `registerOverlay`'s established idempotency) and exercises every read against the surviving disposition edges alone — RED on pre-fix code (`clusterForElement` returned `undefined`; the pre-fix reads only ever looked at `groups`-typed edges).
- All 7 lifecycle "crown jewel" pins named in the wave-4 brief survive, reworked onto the disposition family: `renameCluster — PRESERVES edges through supersede`, `setEnrichment — preserves edges and writes llmEnrichment`, `insertCluster — re-emits after element supersede`, `insertCluster — drops members no longer in input (drift-down)`, `insertCluster — re-emits after tombstone cascade`, `insertCluster — analysis-disposition edges reconcile on drift-down`, `renameCluster — PRESERVES analysis-disposition edges through supersede`. Sanctioned title/wording deltas (dropped stale "groups edges" / "wave 3a" language now that there is nothing to coexist with) — no test bodies deleted, no assertions weakened.
- `npm run build` clean.
- Downstream file:-linked consumers rebuilt + full-suite verified: `nodegraph-layering` (46/46), `nodegraph-llm-enrichment` (31/31) — both pass unmodified (llm-enrichment already read membership via its own `dispositionEdgesByKind` helper against `analysis-disposition`, never the legacy `groups` type, so it was unaffected even before this wave).
- **Found while verifying `fathom-cli` downstream, NOT fixed here (out of this repo's scope)**: `fathom-cli/src/commands/analyze-abstractions.test.ts` has THREE sites (`analyze-abstractions.test.ts:599,1252,1350`) that `graph.queryEdges({ type: "groups" })` directly against the raw substrate — a storage-boundary violation (bypasses `ClusterOverlay.membersOf`/`clusterForElement`) that breaks the moment this package emits no more `groups` edges (one test, "overrides edges feed L3 Louvain clustering", already went RED against this repo's 0.17.0 build: isolated by `git stash`/rebuild/retest — `fathom-cli`'s suite was 212/216 pass before this bump (4 pre-existing failures, unrelated: 3 from other in-flight wave-4 sibling bumps + the peer-floors conformance drift they cause) and 211/216 pass after (the same 4, plus exactly this one new failure) — confirmed caused by this change alone). **Worse**: `nodegraph-inspect-cli/src/detail-generate.ts:217`'s `clusterMemberSampleLocation` does the identical raw `graph.queryEdges({ sourceId: clusterNodeId, type: "groups" })` in PRODUCTION code (not a test) — this has no compile-time peer-floor gate at all (it doesn't import from `@kepello/nodegraph-clusters`), so it will silently report every cluster as `unavailable: cluster has no resolvable live member to sample a location from` — a FALSE reason (the cluster has live members; they're just addressed by a different edge type now) — for any graph a wave-4-built `nodegraph-clusters` produces, the instant that graph is inspected. Flagged as a class-first finding (2 repos, 4 call sites) for the orchestrator to file a companion wave-4 fix in both trees before this version rolls out anywhere `nodegraph-inspect-cli` or `fathom-cli`'s abstractions test suite is exercised against it.

## [0.16.1] — 2026-07-16

Peer-floor sync, 3.1.8.4 wave 3a/3b sibling bumps — no code change. `@kepello/nodegraph-dispositions` peer floor `^0.1.0` → `^0.2.0` (0.x caret — did not admit the installed `0.2.0` without the bump).

### Tests

Suite unchanged: 66/66 pass. `npm run build` clean.

## [0.16.0] — 2026-07-16

Fathom row 3.1.8.4 (disposition-layer), wave 3a — ADDITIVE. `insertCluster`'s member-edge reconciliation now ALSO emits `analysis-disposition` edges (`@kepello/nodegraph-dispositions`), one per member, carrying the single positive kind `groups`. Membership (`groups`) edges are unchanged and stay live — the two families coexist until wave 4 retires membership emission in favor of reading the disposition edges directly. No refusal work in this wave: L3's negative dispositions (the `kind-ineligible` / `fixture` refusal points) already live on the `fathom-cli` side since wave 2, and wave 2's corpus measurement found L3's conservation residual already at 0 — nothing for this repo to name.

### Added

- New peer dependency `@kepello/nodegraph-dispositions@^0.1.0`. `ClusterOverlayImpl` constructs its own `DispositionOverlay` (idempotent registration, mirrors this package's own `registerOverlay` idempotency) and calls `recordDispositions` through THIS overlay's own `CLUSTER_DOMAIN`-scoped mutator — per the disposition package's own `overlay.ts` doc comment, `analysis-disposition` edges are sourced in the PRODUCING domain (substrate rule 5.0.42: a `GraphMutator<TDomain>` may only author edges whose source node is in `TDomain`), never in `disposition`'s own domain.
- `reconcileDispositionEdges` (private): mirrors `reconcileGroupsEdges` exactly — tombstones any live `analysis-disposition` edge whose target left the desired member set (a member that drifted out of the cluster), then `recordDispositions`s the full desired set (create-or-update; unchanged members are a no-op via the disposition overlay's own existing-edge collapse). Called from the same single integration point `reconcileGroupsEdges` already serves for `insertCluster`, `renameCluster`, and `setEnrichment` — so all three write paths stay in sync without three separate call sites.

### Tests

- 4 new regressions (66/66 total, was 62): disposition edges emitted alongside groups edges with `subtype: "groups"` + `metadata.kinds: ["groups"]`; idempotent on identical content-hash (no duplicate edges); reconcile on drift-down (stale disposition edge to a departed member tombstones, mirroring the existing groups-edge drift-down pin); preserved through `renameCluster`'s `supersedeNode` (same class of bug 5.0.39 fixed for groups edges — a raw `supersedeNode` cascades the prior tip's outgoing edges to tombstoned, so every metadata-only supersede path MUST re-reconcile both edge families).
- RED witnessed first: all 4 new tests failed against the pre-fix overlay (`0 !== 2` / `0 !== 1` / `0 !== 3` / `0 !== 3`) before `reconcileDispositionEdges` was wired in.
- Downstream file:-linked consumers verified unaffected (additive; public `ClusterOverlay` API surface unchanged): `nodegraph-layering` (46/46), `nodegraph-llm-enrichment` (31/31) — both pass unmodified.
- `npm run build` clean.

## [0.15.0] — 2026-07-14

Fathom row `overlay-projection-discards-14-of-19-facets` (3.1.0.7) — `fathom-cli`'s abstractions runner used to hand-project each L0 element down to `id`/`identityKey`/`name`/`contentHash`/`language` before calling `computeClusters`. Adds the field this row's shared facet bag lands on; `computeClusters` itself is unchanged (`facets` is not read by this package).

### Added

- `ElementInput.facets?: Readonly<Record<string, unknown>>` — the full L0 facet set (`@kepello/nodegraph-analysis`'s `projectElementFacets`), when the caller supplies it. Plain structural type, not an imported one — this package still has no peer-dependency on `nodegraph-analysis` (same decoupling rationale as every other field on `ElementInput`). Optional, not required: making it required would force editing every hand-built `ElementInput` literal across this package's test suite for a field `computeClusters` doesn't read yet.

### Tests

Suite unchanged: 62/62 pass. `npm run build` clean.

## [0.14.0] — 2026-07-11

Two bundled fixes: the NUL-byte source-hygiene bug (Fathom row `source-control-bytes-ratchet-ungeneralized` 5.0.106.2) and the L3 member of the confidence-saturation class, `l3-confidence-honest-null-for-edgeless-clusters` (5.4.0.1) — the honest-null contract L6/L7 will mirror for their own `confidenceScore` fields.

### Fixed

- **BREAKING**: `confidenceScore` is now `number | null`. An edge-less cluster OR an inbound-only cluster (the intra/total tally only counts SOURCE-side dependency edges, so a cluster that only ever appears as a `target` also has zero counted edges) used to get a forced `confidenceScore: 1` — a max indistinguishable from genuine high cohesion. 88% of live clusters measured at exactly 1.0 before this fix. `total === 0` now yields `null`; the real `intra / total` ratio is unchanged whenever the cluster has at least one counted edge. Mirrors the in-engine precedent `nodegraph-analysis/src/engine/derivations/cohesion.ts`'s `methodPairCohesion` null-on-insufficient-input shape. `ClusterMetadata.confidenceScore` / `ClusterInput.confidenceScore` widen to `number | null`; `insertCluster` persists an explicit `null` distinctly from an omitted field (`buildMetadata`'s `!== undefined` check, unchanged, already had this property). Pre-prod — no migration path: delete `.fathom/graph.db` and re-analyze to pick up honest nulls on existing edge-less/inbound-only clusters.
- Three literal NUL bytes (`clustering.ts:206,211`, `identity.test.ts:74`) used as a template-literal delimiter/split separator and in a doc comment, instead of the space-character escape sequence that `identity.ts`'s `computeClusterId` and `nodegraph-patterns/src/matchers.ts` already used correctly for the identical shape. A raw control byte makes the file read as BINARY to plain `grep` (no `-a`) and every `grep`-class tool built on the same libc heuristic, including agent grep wrappers — silently hiding the file from text sweeps (`clustering.ts` and `identity.test.ts` were both invisible to unflagged `grep`). Byte-identical runtime behavior; delimiter still verified unambiguous by the existing pin test.

### Changed

- `nodegraph-analyzer-conformance` gains a new workspace-wide `no-control-bytes-ratchet.test.ts`, generalizing `nodegraph-analysis/src/no-control-bytes.test.ts` (which only scanned its own repo) to walk every sibling repo's `src/**` — the same cross-repo-reach shape as `natural-key-codec-ratchet.test.ts`. Closes the ratchet-home gap that let this exact regrowth shape land unnoticed in a repo other than the one the original 5.0.106/.1 ratchet lives in.
- Incidental find while drafting this changelog entry: the *previous* (0.13.0) entry below already carried a raw NUL byte in its own prose (same copy-paste failure mode, in a doc line describing the identityKey/contentHash delimiter) — fixed in place. `CHANGELOG.md` is outside `src/`, so neither the old nor the new ratchet would have caught it; flagged for the orchestrator as a scope gap (prose files can carry the same pathology).

### Tests

- 2 new clustering regressions (edge-less singleton → null; inbound-only cluster in a 3-element graph → null, real-ratio sibling cluster unaffected) + 2 new overlay round-trip regressions (explicit `null` persists as `null`; omitted field stays absent from metadata — the two stay distinguishable). 62/62 pass (was 58).
- `nodegraph-analyzer-conformance`'s new ratchet: RED-witnessed against the pre-fix workspace (flagged all three known NUL sites, zero false positives elsewhere), GREEN after the fix.
- Downstream file:-linked consumers rebuilt + full-suite verified after this change: `fathom-cli` (186/186), `fathom-mcp` (41/41), `nodegraph-layering` (46/46), `nodegraph-llm-enrichment` (31/31) — all build clean, no consumer read `confidenceScore` in a way that breaks on `null` (fathom-cli's `analyze-abstractions.ts` passes it straight through to `insertCluster`; `nodegraph-inspect-cli`'s health/detail generators were already `typeof === "number"`-gated and bucket non-number values as an observable "null" chart segment — zero changes needed there).

## [0.13.0] — 2026-07-10

`computeClusterId` migrated onto `@kepello/nodegraph-core`'s shared `shortContentHash` helper. Step 2 of Fathom row `0.3.2.f8` (identity-hash-helper-consolidation). Behavior-preserving — golden-pinned; no id change → no downstream cache concern from this package.

### Changed

- `computeClusterId` keeps the empty-set→`"empty"` guard and the caller-side `identityKey<NUL>contentHash` line composition + sort, then routes the sorted lines through `shortContentHash(lines)` (default `"\n"` delimiter) instead of hand-rolling sha256-then-slice(0,16). Local `SHORT_HASH_LENGTH` const removed. The delimiter-unambiguity boundary test stays green — the NUL intra-line separator is untouched.
- Peer dependency on `@kepello/nodegraph-core` retargeted `^5.7.1` → `^5.12.0` (introduces `shortContentHash`).

### Tests

- 1 new golden-pin regression test: fixed input (three `gen/*` members with distinct golden content hashes) asserts the exact pre-migration literal `9b06236a253c22ec`. Captured green against the un-migrated code, stayed green after the migration — byte-identity confirmed. 9/9 identity tests pass (was 8); full suite unaffected.

## [0.12.0] — 2026-06-09

**Cross-rebuild partition determinism** (L3-TS baseline M4 measurement, Fathom row `l3-ts-baseline` 5.4.0). Canonical input order now sorts by the rebuild-stable `identityKey ?? id` (elements AND dependency endpoints, id tie-break) instead of raw id. Ids are typically substrate UUIDs that differ between clean rebuilds, so the 5.0.7 id-keyed canonicalization was a fresh shuffle per rebuild — Louvain's order-sensitive community walk produced 25/115 cluster-composition flips across two clean rebuilds of the unchanged Fathom workspace. With stable keys the partition reproduces exactly.

### Tests

- 24-node weak-clique-chain regression: identical identityKeys + edges under two id labelings must produce identical clusterId sets (pre-fix: 4/6/6/8 vs 6/6/6/6 partitions). 57 pass.

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
