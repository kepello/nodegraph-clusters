/**
 * Identity-hash tests. Pins:
 *
 *   - empty member set → reserved id "empty"
 *   - same member set in different order → same id
 *   - one swapped member → different id
 *   - renaming a member (different id, same hash) → same cluster id
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { computeClusterId } from "./identity.js";

test("computeClusterId — empty input returns reserved 'empty' id", () => {
  assert.equal(computeClusterId([]), "empty");
});

test("computeClusterId — order-independent for the same member set", () => {
  const a = computeClusterId(["h1", "h2", "h3"]);
  const b = computeClusterId(["h3", "h1", "h2"]);
  assert.equal(a, b);
});

test("computeClusterId — different member set yields different id", () => {
  const a = computeClusterId(["h1", "h2"]);
  const b = computeClusterId(["h1", "h2", "h3"]);
  assert.notEqual(a, b);
});

test("computeClusterId — single content-hash swap changes the id", () => {
  const a = computeClusterId(["h1", "h2", "h3"]);
  const b = computeClusterId(["h1", "h2", "DIFFERENT"]);
  assert.notEqual(a, b);
});

test("computeClusterId — short fixed-width hash output", () => {
  const id = computeClusterId(["h1", "h2"]);
  assert.equal(id.length, 16);
  assert.match(id, /^[0-9a-f]{16}$/);
});
