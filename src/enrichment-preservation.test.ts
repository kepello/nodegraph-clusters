/**
 * Conformance tests for the substrate's enrichment-preservation
 * invariant (Fathom row 5.0.31). Pins:
 *
 *   - When a cluster is re-emitted by Louvain with a DIFFERENT
 *     clusterId (because member contentHashes shifted) but the SAME
 *     canonical member set (member naturalKeys unchanged), any
 *     operator/LLM-supplied metadata on the prior cluster (e.g.
 *     `llmEnrichment.{name, displayName, summary}`) MUST lift forward
 *     onto the new cluster.
 *
 *   - The preservation is keyed on the canonical-member-set hash
 *     computed from sorted member naturalKeys (which are stable
 *     across content changes — unlike contentHashes which shift).
 *
 *   - When the input ClusterInput explicitly carries a fresh
 *     `llmEnrichment`, the input wins over the lifted-forward value.
 *
 *   - When the canonical member set differs (members added/removed),
 *     enrichment does NOT lift forward — the cluster is semantically
 *     different.
 *
 * Round-6 pilot F1 surfaced this as the headline user-visible
 * regression: every `code.bounded_contexts` row had no `llmName`
 * despite the Haiku-namer pipeline having run earlier. Root cause:
 * Louvain re-emission produces fresh clusterIds; the prior Haiku
 * enrichment is attached to clusterIds that the 5.0.7.1
 * tombstone-stale pass has since cleared. The wire surface
 * (`llmEnrichment` field threading) is correct — the data is just
 * absent.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  GraphLayerImpl,
  type GraphLayer,
} from "@kepello/nodegraph-core";
import { InMemoryBackend } from "@kepello/nodegraph-core/in-memory";
import { makeClusterOverlay } from "./overlay.js";

function makeGraph(): GraphLayer {
  return new GraphLayerImpl(new InMemoryBackend());
}

/**
 * Helper — write a Haiku-style enrichment onto a cluster node via
 * supersedeNode. Mirrors the path `nodegraph-llm-enrichment` takes
 * when it persists a Haiku-produced name to a cluster's metadata.
 */
function attachLlmEnrichment(
  graph: GraphLayer,
  clusterId: string,
  enrichment: { name: string; displayName: string; summary: string },
): void {
  const node = graph.getLiveNodeByNaturalKey("cluster", clusterId);
  assert.ok(node !== undefined, `cluster ${clusterId} not found`);
  const priorMeta = node!.metadata as Record<string, unknown>;
  graph.transaction(
    {
      kind: "attach-llm-enrichment",
      producerDomain: "cluster",
      summary: `attach Haiku enrichment to ${clusterId}`,
    },
    () => {
      graph.supersedeNode(node!.id, {
        contentHash: node!.contentHash,
        metadata: { ...priorMeta, llmEnrichment: enrichment },
      });
    },
  );
}

test("ClusterOverlay — preserves llmEnrichment across re-clustering with same canonical member set (Fathom 5.0.31)", () => {
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);

  // Step 1: Initial Louvain emission. Cluster A holds members
  // [m1, m2, m3] with contentHashes [h_v1_m1, h_v1_m2, h_v1_m3].
  // The clusterId is hash-derived from those contentHashes.
  overlay.insertCluster({
    clusterId: "cluster-A-v1",
    name: "cluster-foo-bar",
    memberCount: 3,
    contentHash: "h_cluster_A_v1",
    memberElementIds: ["m1", "m2", "m3"],
    // Fathom 5.0.31: the canonical-member-set hash is what enables
    // enrichment preservation across re-clusterings. Computed from
    // sorted member naturalKeys, which are stable across content
    // changes. The runner passes this in.
    canonicalMemberSetHash: "cms_m1_m2_m3",
  });

  // Step 2: Haiku-namer runs. Operator-facing name surfaces via
  // `code.bounded_contexts` / `code.cluster_summary`.
  attachLlmEnrichment(graph, "cluster-A-v1", {
    name: "domain-model",
    displayName: "Domain Model",
    summary: "Core domain entities and their relationships.",
  });

  // Step 3: re-analyze run. Member m1's source file changed, so
  // its contentHash shifted from h_v1_m1 → h_v2_m1. The new Louvain
  // emission produces a DIFFERENT clusterId because the
  // contentHash-of-contentHashes inputs differ. BUT the canonical
  // member set is unchanged (same naturalKeys, same membership).
  overlay.insertCluster({
    clusterId: "cluster-A-v2",
    name: "cluster-foo-bar",
    memberCount: 3,
    contentHash: "h_cluster_A_v2",
    memberElementIds: ["m1", "m2", "m3"],
    canonicalMemberSetHash: "cms_m1_m2_m3",
  });

  // Assertion — the new cluster carries the prior cluster's
  // llmEnrichment forward, keyed on canonicalMemberSetHash.
  const newCluster = overlay.getCluster("cluster-A-v2");
  assert.ok(newCluster !== undefined);
  const llmEnrichment = (newCluster!.metadata as { llmEnrichment?: unknown })
    .llmEnrichment;
  assert.ok(
    llmEnrichment !== undefined,
    "llmEnrichment should lift forward when canonical member set is unchanged",
  );
  assert.deepEqual(llmEnrichment, {
    name: "domain-model",
    displayName: "Domain Model",
    summary: "Core domain entities and their relationships.",
  });
});

test("ClusterOverlay — input llmEnrichment wins over lifted-forward when both present", () => {
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);

  // Prior cluster with enrichment.
  overlay.insertCluster({
    clusterId: "C-v1",
    name: "cluster-a",
    memberCount: 2,
    contentHash: "h1",
    memberElementIds: ["m1", "m2"],
    canonicalMemberSetHash: "cms-shared",
  });
  attachLlmEnrichment(graph, "C-v1", {
    name: "OLD",
    displayName: "OLD",
    summary: "OLD",
  });

  // New cluster with same canonical member set BUT a fresh
  // llmEnrichment supplied in the input — the input wins.
  overlay.insertCluster({
    clusterId: "C-v2",
    name: "cluster-a",
    memberCount: 2,
    contentHash: "h2",
    memberElementIds: ["m1", "m2"],
    canonicalMemberSetHash: "cms-shared",
    llmEnrichment: { name: "NEW", displayName: "NEW", summary: "NEW" },
  });

  const newCluster = overlay.getCluster("C-v2");
  const llmEnrichment = (newCluster!.metadata as { llmEnrichment?: { name?: string } })
    .llmEnrichment;
  assert.equal(llmEnrichment?.name, "NEW", "input enrichment should win");
});

test("ClusterOverlay — does NOT lift forward when canonical member set differs", () => {
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);

  overlay.insertCluster({
    clusterId: "D-v1",
    name: "cluster-a",
    memberCount: 3,
    contentHash: "h1",
    memberElementIds: ["m1", "m2", "m3"],
    canonicalMemberSetHash: "cms-abc",
  });
  attachLlmEnrichment(graph, "D-v1", {
    name: "OLD",
    displayName: "OLD",
    summary: "OLD",
  });

  // New cluster — DIFFERENT canonical member set (different members).
  // Semantically a different cluster; enrichment should not lift.
  overlay.insertCluster({
    clusterId: "D-v2",
    name: "cluster-b",
    memberCount: 2,
    contentHash: "h2",
    memberElementIds: ["m4", "m5"],
    canonicalMemberSetHash: "cms-de",
  });

  const newCluster = overlay.getCluster("D-v2");
  const llmEnrichment = (newCluster!.metadata as { llmEnrichment?: unknown })
    .llmEnrichment;
  assert.equal(
    llmEnrichment,
    undefined,
    "different canonical member set should NOT lift forward enrichment",
  );
});
