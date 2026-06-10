/**
 * Identity-hash tests. Pins:
 *
 *   - empty member set → reserved id "empty"
 *   - same member set in different order → same id
 *   - one swapped member → different id
 *   - renaming a member (different identityKey, same contentHash) →
 *     DIFFERENT cluster id (Fathom row 5.0.48.2 — deliberate reversal
 *     of the pre-fix "identity tracks behavior, not naming" property,
 *     which collided disjoint communities of content-identical members)
 *   - content-identical members with distinct identityKeys → distinct
 *     contributions (the 5.0.48.2 collision shape)
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { computeClusterId, type ClusterIdentityMember } from "./identity.js";

const m = (identityKey: string, contentHash: string): ClusterIdentityMember => ({
  identityKey,
  contentHash,
});

test("computeClusterId — empty input returns reserved 'empty' id", () => {
  assert.equal(computeClusterId([]), "empty");
});

test("computeClusterId — order-independent for the same member set", () => {
  const a = computeClusterId([m("k1", "h1"), m("k2", "h2"), m("k3", "h3")]);
  const b = computeClusterId([m("k3", "h3"), m("k1", "h1"), m("k2", "h2")]);
  assert.equal(a, b);
});

test("computeClusterId — different member set yields different id", () => {
  const a = computeClusterId([m("k1", "h1"), m("k2", "h2")]);
  const b = computeClusterId([m("k1", "h1"), m("k2", "h2"), m("k3", "h3")]);
  assert.notEqual(a, b);
});

test("computeClusterId — single content-hash swap changes the id", () => {
  const a = computeClusterId([m("k1", "h1"), m("k2", "h2"), m("k3", "h3")]);
  const b = computeClusterId([m("k1", "h1"), m("k2", "h2"), m("k3", "DIFFERENT")]);
  assert.notEqual(a, b);
});

test("computeClusterId — REGRESSION 5.0.48.2: same content multiset, different identityKeys → different ids", () => {
  // Pre-fix, identity hashed contentHashes only, so two disjoint
  // member sets with identical content collided onto one clusterId.
  const a = computeClusterId([m("gen/A", "SAME"), m("gen/B", "SAME")]);
  const b = computeClusterId([m("gen/C", "SAME"), m("gen/D", "SAME")]);
  assert.notEqual(a, b);
});

test("computeClusterId — renaming a member (identityKey change, same content) changes the id", () => {
  const a = computeClusterId([m("src/old.ts#Foo", "h1")]);
  const b = computeClusterId([m("src/new.ts#Foo", "h1")]);
  assert.notEqual(a, b);
});

test("computeClusterId — delimiter is unambiguous (key/hash boundary cannot shift)", () => {
  // "ab" + "c" vs "a" + "bc" must not concatenate to the same line.
  const a = computeClusterId([m("ab", "c")]);
  const b = computeClusterId([m("a", "bc")]);
  assert.notEqual(a, b);
});

test("computeClusterId — short fixed-width hash output", () => {
  const id = computeClusterId([m("k1", "h1"), m("k2", "h2")]);
  assert.equal(id.length, 16);
  assert.match(id, /^[0-9a-f]{16}$/);
});
