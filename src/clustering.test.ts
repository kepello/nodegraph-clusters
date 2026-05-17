/**
 * Clustering algorithm tests. Pins:
 *
 *   - Two strongly-connected components in the same input produce two
 *     clusters; an isolated node produces a singleton cluster.
 *   - Same input + same seed = same clusters (determinism).
 *   - Each cluster's contentHash + clusterId are derived from member
 *     contentHashes (not from element ids).
 *   - dependsOn aggregations sum inter-cluster edges per target.
 *   - confidenceScore = intra-cluster edge weight / total cluster edge
 *     weight (0..1).
 *   - Empty input returns no clusters and an empty assignment map.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { computeClusters, type ElementInput, type DependencyInput } from "./clustering.js";

test("computeClusters — empty input returns empty result", () => {
  const result = computeClusters({ elements: [], dependencies: [] });
  assert.equal(result.clusters.length, 0);
  assert.equal(result.assignments.size, 0);
});

test("computeClusters — single isolated element forms a singleton cluster", () => {
  const result = computeClusters({
    elements: [{ id: "A", name: "FooClass", contentHash: "h1" }],
    dependencies: [],
  });
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0].memberCount, 1);
  assert.equal(result.clusters[0].memberElementIds[0], "A");
});

test("computeClusters — two disconnected pairs produce two clusters", () => {
  const result = computeClusters({
    elements: [
      { id: "A", name: "FooA", contentHash: "h1" },
      { id: "B", name: "FooB", contentHash: "h2" },
      { id: "C", name: "BarC", contentHash: "h3" },
      { id: "D", name: "BarD", contentHash: "h4" },
    ],
    dependencies: [
      { source: "A", target: "B", weight: 5 },
      { source: "B", target: "A", weight: 5 },
      { source: "C", target: "D", weight: 5 },
      { source: "D", target: "C", weight: 5 },
    ],
  });
  assert.equal(result.clusters.length, 2);
  // Each cluster has 2 members.
  for (const c of result.clusters) {
    assert.equal(c.memberCount, 2);
  }
  // A and B are in the same cluster; C and D are in the same cluster.
  const aCluster = result.assignments.get("A");
  const bCluster = result.assignments.get("B");
  const cCluster = result.assignments.get("C");
  const dCluster = result.assignments.get("D");
  assert.equal(aCluster, bCluster);
  assert.equal(cCluster, dCluster);
  assert.notEqual(aCluster, cCluster);
});

test("computeClusters — determinism: same input + seed produces same clusters", () => {
  const input = {
    elements: [
      { id: "A", name: "FooA", contentHash: "h1" },
      { id: "B", name: "FooB", contentHash: "h2" },
      { id: "C", name: "BarC", contentHash: "h3" },
      { id: "D", name: "BarD", contentHash: "h4" },
    ],
    dependencies: [
      { source: "A", target: "B", weight: 5 },
      { source: "C", target: "D", weight: 5 },
    ],
  };
  const a = computeClusters(input);
  const b = computeClusters(input);
  assert.deepEqual(
    a.clusters.map((c) => c.clusterId).sort(),
    b.clusters.map((c) => c.clusterId).sort(),
  );
  assert.deepEqual(
    [...a.assignments.entries()].sort(),
    [...b.assignments.entries()].sort(),
  );
});

test("computeClusters — determinism: reordered inputs produce identical clusters (row 5.0.7)", () => {
  // Regression for Fathom row 5.0.7. Two sequential `fathom analyze`
  // runs on the same workspace produced different L3 cluster counts
  // (885 vs 892) because the caller's `queryNodes` / `queryEdges`
  // calls returned rows in a different order across runs. computeClusters
  // must canonicalize input order so the result is order-invariant.
  const elements: ElementInput[] = [];
  const dependencies: DependencyInput[] = [];
  // 200 nodes split into ambiguous-boundary clusters: 4 groups of 50 with
  // overlapping inter-group edges that push Louvain into borderline merges.
  for (let i = 0; i < 200; i++) {
    elements.push({ id: `n${i.toString().padStart(3, "0")}`, name: `Node${i}`, contentHash: `h${i}` });
  }
  for (let g = 0; g < 4; g++) {
    const start = g * 50;
    for (let i = start; i < start + 50; i++) {
      for (let j = i + 1; j < start + 50; j++) {
        if (((i * 17 + j * 31) % 7) < 3) {
          dependencies.push({ source: `n${i.toString().padStart(3, "0")}`, target: `n${j.toString().padStart(3, "0")}`, weight: 5 });
        }
      }
    }
  }
  // Heavy inter-group bridges that make borders ambiguous.
  for (let k = 0; k < 100; k++) {
    const a = (k * 13) % 200;
    const b = (k * 41 + 7) % 200;
    if (a !== b) {
      dependencies.push({ source: `n${a.toString().padStart(3, "0")}`, target: `n${b.toString().padStart(3, "0")}`, weight: 2 });
    }
  }

  // Canonical order.
  const r1 = computeClusters({ elements, dependencies });
  // Reverse.
  const r2 = computeClusters({
    elements: [...elements].reverse(),
    dependencies: [...dependencies].reverse(),
  });
  // Shuffle.
  const shuffled = [...elements];
  const shuffledDeps = [...dependencies];
  let s = 42;
  const rng = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  for (let i = shuffledDeps.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffledDeps[i], shuffledDeps[j]] = [shuffledDeps[j], shuffledDeps[i]];
  }
  const r3 = computeClusters({ elements: shuffled, dependencies: shuffledDeps });

  const ids1 = r1.clusters.map((c) => c.clusterId).sort();
  const ids2 = r2.clusters.map((c) => c.clusterId).sort();
  const ids3 = r3.clusters.map((c) => c.clusterId).sort();
  assert.deepEqual(ids1, ids2, "reversed input must produce identical cluster IDs");
  assert.deepEqual(ids1, ids3, "shuffled input must produce identical cluster IDs");
  assert.equal(r1.clusters.length, r2.clusters.length);
  assert.equal(r1.clusters.length, r3.clusters.length);
});

test("computeClusters — clusterId is derived from member contentHashes, not element ids", () => {
  // Same content hashes + different element ids → same clusterId.
  const a = computeClusters({
    elements: [
      { id: "A", name: "n1", contentHash: "h1" },
      { id: "B", name: "n2", contentHash: "h2" },
    ],
    dependencies: [
      { source: "A", target: "B" },
      { source: "B", target: "A" },
    ],
  });
  const b = computeClusters({
    elements: [
      { id: "RENAMED_A", name: "n1", contentHash: "h1" },
      { id: "RENAMED_B", name: "n2", contentHash: "h2" },
    ],
    dependencies: [
      { source: "RENAMED_A", target: "RENAMED_B" },
      { source: "RENAMED_B", target: "RENAMED_A" },
    ],
  });
  // Single cluster in each case; same clusterId.
  assert.equal(a.clusters.length, 1);
  assert.equal(b.clusters.length, 1);
  assert.equal(a.clusters[0].clusterId, b.clusters[0].clusterId);
});

test("computeClusters — dependsOn captures inter-cluster aggregate edge counts", () => {
  const result = computeClusters({
    elements: [
      { id: "A", name: "FooA", contentHash: "h1" },
      { id: "B", name: "FooB", contentHash: "h2" },
      { id: "C", name: "BarC", contentHash: "h3" },
      { id: "D", name: "BarD", contentHash: "h4" },
    ],
    dependencies: [
      { source: "A", target: "B", weight: 5 }, // intra
      { source: "B", target: "A", weight: 5 }, // intra
      { source: "C", target: "D", weight: 5 }, // intra
      { source: "D", target: "C", weight: 5 }, // intra
      // One cross-cluster edge: A → C, weight 2.
      { source: "A", target: "C", weight: 2 },
    ],
  });
  const aCluster = result.clusters.find((c) => c.memberElementIds.includes("A"));
  const cCluster = result.clusters.find((c) => c.memberElementIds.includes("C"));
  assert.ok(aCluster);
  assert.ok(cCluster);
  assert.equal(aCluster.dependsOn.length, 1);
  assert.equal(aCluster.dependsOn[0].targetClusterId, cCluster.clusterId);
  assert.equal(aCluster.dependsOn[0].edgeCount, 2);
});

test("computeClusters — confidenceScore reflects intra-cluster cohesion", () => {
  const result = computeClusters({
    elements: [
      { id: "A", name: "FooA", contentHash: "h1" },
      { id: "B", name: "FooB", contentHash: "h2" },
      { id: "C", name: "BarC", contentHash: "h3" },
      { id: "D", name: "BarD", contentHash: "h4" },
    ],
    dependencies: [
      // Cluster (A, B): all intra
      { source: "A", target: "B", weight: 10 },
      // Cluster (C, D): half-intra, half-out
      { source: "C", target: "D", weight: 10 },
      { source: "C", target: "A", weight: 10 }, // cross-cluster
    ],
  });
  // The cluster containing only intra-edges has confidenceScore = 1.
  // The cluster with half-intra/half-out has score = 10 / (10 + 10) = 0.5.
  const cluster_AB = result.clusters.find((c) => c.memberElementIds.includes("A"));
  const cluster_CD = result.clusters.find((c) => c.memberElementIds.includes("C"));
  assert.ok(cluster_AB);
  assert.ok(cluster_CD);
  // The AB cluster has no outgoing edges from its own members (A's only
  // edge is intra), so confidence = 1.
  assert.equal(cluster_AB.confidenceScore, 1);
  // The CD cluster has C → D intra (10) and C → A out (10), score 0.5.
  assert.equal(cluster_CD.confidenceScore, 0.5);
});

test("computeClusters — language tag set when uniform across members", () => {
  const result = computeClusters({
    elements: [
      { id: "A", name: "FooA", contentHash: "h1", language: "typescript" },
      { id: "B", name: "FooB", contentHash: "h2", language: "typescript" },
    ],
    dependencies: [
      { source: "A", target: "B" },
      { source: "B", target: "A" },
    ],
  });
  assert.equal(result.clusters[0].language, "typescript");
});

test("computeClusters — language tag absent when members differ", () => {
  const result = computeClusters({
    elements: [
      { id: "A", name: "FooA", contentHash: "h1", language: "typescript" },
      { id: "B", name: "FooB", contentHash: "h2", language: "dotnet" },
    ],
    dependencies: [
      { source: "A", target: "B" },
      { source: "B", target: "A" },
    ],
  });
  assert.equal(result.clusters[0].language, undefined);
});

test("computeClusters — self-loops are ignored", () => {
  const result = computeClusters({
    elements: [
      { id: "A", name: "FooA", contentHash: "h1" },
      { id: "B", name: "FooB", contentHash: "h2" },
    ],
    dependencies: [
      { source: "A", target: "A", weight: 100 }, // self-loop, should not influence
      { source: "A", target: "B" },
      { source: "B", target: "A" },
    ],
  });
  // Both elements still form a cluster; self-loop didn't crash anything.
  assert.equal(result.assignments.get("A"), result.assignments.get("B"));
});
