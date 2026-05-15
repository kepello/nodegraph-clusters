/**
 * Cluster-identity computation. `clusterId = sha256(sorted member
 * contentHashes joined by '\n')`. The hash is short (16 hex chars =
 * 64 bits) — sufficient for inter-cluster uniqueness in a single
 * workspace; collisions remain astronomically unlikely.
 *
 * Stability properties:
 *
 *   - Identical member set → identical clusterId (sort + canonical
 *     delimiter ensures encoding-invariance).
 *   - Single membership swap → completely different clusterId. The L3
 *     v1 trade-off accepts churn beyond ~50% membership drift.
 *   - Renaming a member (different elementId, same contentHash) →
 *     identical clusterId. Identity tracks behavior, not naming.
 */

import { createHash } from "node:crypto";

const SHORT_HASH_LENGTH = 16;

/**
 * Compute a stable `clusterId` from an unordered iterable of member
 * content hashes. Empty inputs produce a special-cased empty-cluster
 * id so consumers don't collide on the all-zero-hash value.
 */
export function computeClusterId(
  memberContentHashes: Iterable<string>,
): string {
  const sorted = [...memberContentHashes].sort();
  if (sorted.length === 0) return "empty";
  const hasher = createHash("sha256");
  hasher.update(sorted.join("\n"));
  return hasher.digest("hex").slice(0, SHORT_HASH_LENGTH);
}
