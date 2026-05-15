/**
 * Naming-heuristic tests. Pins:
 *
 *   - splitIdentifier correctness across camelCase / PascalCase /
 *     snake_case / consecutive-uppercase shapes.
 *   - nameClusterFromIdentifiers returns a deterministic cluster-<...>
 *     name driven by frequency.
 *   - nameClustersTfIdf picks distinguishing terms (terms common to
 *     all clusters get down-weighted vs cluster-specific terms).
 *   - empty / vocabulary-less input falls back to 'cluster-unnamed'.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  nameClusterFromIdentifiers,
  nameClustersTfIdf,
  splitIdentifier,
} from "./naming.js";

// --- splitIdentifier --------------------------------------------------------

test("splitIdentifier — camelCase", () => {
  assert.deepEqual(splitIdentifier("orchestratorRunner"), ["orchestrator", "runner"]);
});

test("splitIdentifier — PascalCase", () => {
  assert.deepEqual(splitIdentifier("SubprocessSpawner"), ["subprocess", "spawner"]);
});

test("splitIdentifier — snake_case", () => {
  assert.deepEqual(splitIdentifier("subprocess_spawner_run"), [
    "subprocess",
    "spawner",
    "run",
  ]);
});

test("splitIdentifier — consecutive uppercase acronyms", () => {
  // "HTTPSession" should split as ["http", "session"].
  assert.deepEqual(splitIdentifier("HTTPSession"), ["http", "session"]);
});

test("splitIdentifier — drops length-1 tokens", () => {
  // "AB" → ["AB"] would have length 2 each char if split per upper, but
  // current split-by-upper rule keeps it as ["ab"].
  const tokens = splitIdentifier("xY");
  assert.ok(tokens.every((t) => t.length > 1) || tokens.length === 0);
});

// --- nameClusterFromIdentifiers --------------------------------------------

test("nameClusterFromIdentifiers — picks the most frequent term", () => {
  const name = nameClusterFromIdentifiers([
    "OrchestratorRunner",
    "SubprocessOrchestrator",
    "OrchestratorPool",
  ]);
  // 'orchestrator' appears 3 times — should be in the name.
  assert.ok(name.includes("orchestrator"));
});

test("nameClusterFromIdentifiers — empty input returns fallback", () => {
  assert.equal(nameClusterFromIdentifiers([]), "cluster-unnamed");
});

test("nameClusterFromIdentifiers — drops stopwords", () => {
  // "get", "set", "type" are stopwords — names shouldn't be made of them.
  const name = nameClusterFromIdentifiers([
    "getValue",
    "setValue",
    "getType",
    "setType",
  ]);
  // 'value' and 'type' are stopwords; should fall back or pick nothing.
  assert.equal(name, "cluster-unnamed");
});

test("nameClusterFromIdentifiers — deterministic on the same input", () => {
  const a = nameClusterFromIdentifiers([
    "OrchestratorRunner",
    "SubprocessOrchestrator",
  ]);
  const b = nameClusterFromIdentifiers([
    "OrchestratorRunner",
    "SubprocessOrchestrator",
  ]);
  assert.equal(a, b);
});

// --- nameClustersTfIdf -----------------------------------------------------

test("nameClustersTfIdf — distinguishes clusters by their unique vocabulary", () => {
  const names = nameClustersTfIdf([
    { identifiers: ["OrchestratorRunner", "SubprocessOrchestrator", "OrchestratorPool"] },
    { identifiers: ["ParserNode", "AstParser", "ParserVisitor"] },
    { identifiers: ["RatingComputer", "RatingThreshold", "RatingFilter"] },
  ]);
  assert.equal(names.length, 3);
  // Each name should have its distinguishing word.
  assert.ok(names[0].includes("orchestrator"));
  assert.ok(names[1].includes("parser"));
  assert.ok(names[2].includes("rating"));
});

test("nameClustersTfIdf — handles empty cluster", () => {
  const names = nameClustersTfIdf([
    { identifiers: [] },
    { identifiers: ["FooBar", "FooBaz"] },
  ]);
  assert.equal(names[0], "cluster-unnamed");
  assert.ok(names[1].startsWith("cluster-"));
});

test("nameClustersTfIdf — deterministic on the same input", () => {
  const inputs = [
    { identifiers: ["OrchestratorRunner", "SubprocessOrchestrator"] },
    { identifiers: ["ParserNode", "AstParser"] },
  ];
  const a = nameClustersTfIdf(inputs);
  const b = nameClustersTfIdf(inputs);
  assert.deepEqual(a, b);
});
