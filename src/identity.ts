/**
 * Cluster-identity computation. `clusterId = sha256(sorted
 * "identityKey\u0000contentHash" member lines joined by '\n')`. The hash is
 * short (16 hex chars = 64 bits) — sufficient for inter-cluster
 * uniqueness in a single workspace; collisions remain astronomically
 * unlikely.
 *
 * Identity incorporates member IDENTITY as well as content (Fathom row
 * `l3-cluster-count-discrepancy-envisionweb` 5.0.48.2): content-only
 * identity collided when two DISJOINT communities had identical member
 * contentHash multisets — rampant in generated .NET code, where many
 * distinct elements are byte-identical. EnvisionWeb measured 1,011
 * emitted → 963 persisted (4.7% silent collapse) before the fix.
 *
 * Stability properties:
 *
 *   - Identical member set (same identityKeys + same contentHashes) →
 *     identical clusterId (sort + canonical delimiter ensures
 *     encoding-invariance).
 *   - Single membership swap or single member content change →
 *     completely different clusterId. The L3 v1 trade-off accepts
 *     churn beyond ~50% membership drift.
 *   - Renaming a member (different identityKey, same contentHash) →
 *     DIFFERENT clusterId. Deliberate reversal of the pre-5.0.48.2
 *     "identity tracks behavior, not naming" property — that property
 *     was the collision bug. Rename-churn is absorbed the same way all
 *     id churn is: `canonicalMemberSetHash` lift-forward (row 5.0.31)
 *     carries enrichment across re-emissions.
 */

import { shortContentHash } from "@kepello/nodegraph-core";

/** One member's contribution to cluster identity. */
export interface ClusterIdentityMember {
  /**
   * Stable member identity — the element's substrate naturalKey when
   * available, else the caller's element id. Distinguishes
   * content-identical members so disjoint communities never collide.
   */
  identityKey: string;
  contentHash: string;
}

/**
 * Compute a stable `clusterId` from an unordered iterable of members.
 * Empty inputs produce a special-cased empty-cluster id so consumers
 * don't collide on the all-zero-hash value.
 */
export function computeClusterId(
  members: Iterable<ClusterIdentityMember>,
): string {
  const lines = [...members]
    .map((m) => `${m.identityKey}\u0000${m.contentHash}`)
    .sort();
  if (lines.length === 0) return "empty";
  return shortContentHash(lines);
}
