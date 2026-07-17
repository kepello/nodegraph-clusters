/**
 * Overlay-implementation tests. Pins:
 *
 *   - registerOverlay is idempotent (constructing a second overlay
 *     over the same graph doesn't throw).
 *   - insertCluster persists metadata + group edges.
 *   - insertCluster is idempotent on identical content-hash (no
 *     supersession, no duplicate edges).
 *   - insertCluster supersedes on different content-hash.
 *   - renameCluster updates displayName without changing identity.
 *   - tombstoneCluster removes the cluster from listClusters.
 *   - clusterForElement walks `groups` edges to recover membership.
 *   - membersOf returns the edges that belong to a cluster.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  GraphLayerImpl,
  type GraphLayer,
} from "@kepello/nodegraph-core";
import { InMemoryBackend } from "@kepello/nodegraph-core/in-memory";
import { ANALYSIS_DISPOSITION_EDGE_TYPE } from "@kepello/nodegraph-dispositions";
import {
  CLUSTER_DOMAIN,
  CLUSTER_METADATA_KIND,
  CLUSTER_SCHEMA_VERSION,
} from "./schema.js";
import {
  ClusterOverlayImpl,
  GROUPS_EDGE_TYPE,
  makeClusterOverlay,
} from "./overlay.js";

function makeGraph(): GraphLayer {
  return new GraphLayerImpl(new InMemoryBackend());
}

test("registerOverlay — idempotent on repeated construction", () => {
  const graph = makeGraph();
  const overlay1 = makeClusterOverlay(graph);
  // Constructing a second overlay over the same graph should tolerate
  // the substrate's "already-registered" rejection.
  assert.doesNotThrow(() => new ClusterOverlayImpl(graph));
  assert.ok(overlay1);
});

test("registerOverlay — wires CLUSTER_SCHEMA_VERSION into the persisted stamp (Fathom 1.12.3)", () => {
  // Adoption pin: the overlay constructor declares the package's exported
  // schema-version constant, and the substrate persists exactly that value
  // to overlay_schemas. Guards against the registration drifting away from
  // the public CLUSTER_SCHEMA_VERSION contract.
  const backend = new InMemoryBackend();
  const graph = new GraphLayerImpl(backend);
  new ClusterOverlayImpl(graph);
  const rows = backend.query("overlay_schemas", { domain: CLUSTER_DOMAIN });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].schemaVersion, CLUSTER_SCHEMA_VERSION);
});

test("insertCluster — persists metadata + groups edges", () => {
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);
  const node = overlay.insertCluster({
    clusterId: "abc123",
    name: "cluster-foo-bar",
    memberCount: 2,
    contentHash: "ch_abc",
    memberElementIds: ["member1", "member2"],
  });
  assert.equal(node.metadata.kind, CLUSTER_METADATA_KIND);
  assert.equal(node.metadata.clusterId, "abc123");
  assert.equal(node.metadata.name, "cluster-foo-bar");
  assert.equal(node.metadata.memberCount, 2);

  const edges = overlay.membersOf("abc123");
  assert.equal(edges.length, 2);
  for (const e of edges) {
    assert.equal(e.type, GROUPS_EDGE_TYPE);
  }
});

// Fathom row 5.4.0.1 (l3-confidence-honest-null-for-edgeless-clusters):
// an explicit `confidenceScore: null` must persist as an observable
// `null` on read-back — distinct from a caller that never supplied the
// field at all (which stays absent from metadata entirely).
test("insertCluster — REGRESSION 5.4.0.1: explicit confidenceScore null persists and reads back as null", () => {
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);
  const node = overlay.insertCluster({
    clusterId: "null-conf",
    name: "cluster-edgeless",
    memberCount: 1,
    contentHash: "ch_null_conf",
    memberElementIds: ["member1"],
    confidenceScore: null,
  });
  assert.equal(node.metadata.confidenceScore, null);
  const reread = overlay.getCluster("null-conf");
  assert.ok(reread);
  assert.equal(reread.metadata.confidenceScore, null);
});

test("insertCluster — confidenceScore omitted entirely stays absent from metadata (distinct from explicit null)", () => {
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);
  const node = overlay.insertCluster({
    clusterId: "no-conf-field",
    name: "cluster-no-score",
    memberCount: 1,
    contentHash: "ch_no_conf",
    memberElementIds: ["member1"],
  });
  assert.equal("confidenceScore" in node.metadata, false);
});

test("insertCluster — idempotent on identical content-hash", () => {
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);
  const a = overlay.insertCluster({
    clusterId: "xyz",
    name: "cluster-x",
    memberCount: 1,
    contentHash: "h1",
    memberElementIds: ["m1"],
  });
  const b = overlay.insertCluster({
    clusterId: "xyz",
    name: "cluster-x",
    memberCount: 1,
    contentHash: "h1",
    memberElementIds: ["m1"],
  });
  assert.equal(a.id, b.id);
  // Should not duplicate the groups edge.
  assert.equal(overlay.membersOf("xyz").length, 1);
});

test("insertCluster — supersedes on different content-hash", () => {
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);
  const a = overlay.insertCluster({
    clusterId: "drift",
    name: "cluster-drift",
    memberCount: 1,
    contentHash: "v1",
    memberElementIds: ["m1"],
  });
  const b = overlay.insertCluster({
    clusterId: "drift",
    name: "cluster-drift-new",
    memberCount: 2,
    contentHash: "v2",
    memberElementIds: ["m1", "m2"],
  });
  // Different content-hash → supersession → new id.
  assert.notEqual(a.id, b.id);
  // listClusters returns the live tip only.
  const live = overlay.listClusters();
  assert.equal(live.length, 1);
  assert.equal(live[0].id, b.id);
  assert.equal(live[0].metadata.memberCount, 2);
});

test("renameCluster — updates displayName, preserves clusterId", () => {
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);
  overlay.insertCluster({
    clusterId: "renameMe",
    name: "cluster-auto",
    memberCount: 1,
    contentHash: "h1",
    memberElementIds: ["m1"],
  });
  const renamed = overlay.renameCluster("renameMe", "Operator-Picked Name");
  assert.equal(renamed.metadata.clusterId, "renameMe");
  assert.equal(renamed.metadata.displayName, "Operator-Picked Name");
  assert.equal(renamed.metadata.name, "cluster-auto");
});

test("renameCluster — PRESERVES groups edges through supersede (Fathom 5.0.39)", () => {
  // Round-7 follow-up. The bug: `renameCluster` calls
  // `graph.supersedeNode` to update displayName, which CASCADES the
  // prior node's outgoing live edges to tombstoned (per the substrate
  // conformance test). The current implementation does NOT re-emit
  // groups edges from the new node — so the renamed cluster loses its
  // membership entirely.
  //
  // Invariant: after any overlay-method-driven supersede of a cluster
  // node, liveMemberCount MUST equal the cluster's memberCount. The
  // overlay owns the groups-edge invariant; its OWN methods MUST
  // honor it.
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);
  overlay.insertCluster({
    clusterId: "preserve-me",
    name: "cluster-x",
    memberCount: 3,
    contentHash: "h1",
    memberElementIds: ["m1", "m2", "m3"],
  });
  assert.equal(overlay.liveMemberCount("preserve-me"), 3);
  overlay.renameCluster("preserve-me", "Renamed");
  assert.equal(
    overlay.liveMemberCount("preserve-me"),
    3,
    "renameCluster lost groups edges — bug introduced by raw supersedeNode without edge reconciliation",
  );
});

test("setEnrichment — preserves groups edges and writes llmEnrichment (Fathom 5.0.39)", () => {
  // The new overlay method to be added by 5.0.39's fix. Currently the
  // Haiku-namer script bypasses the overlay and calls
  // `graph.supersedeNode` directly to write `llmEnrichment` onto the
  // cluster's metadata. That bypass tombstones the cluster's groups
  // edges (substrate cascade) without re-emitting them, breaking
  // cluster_summary + layering_violations on every enriched cluster.
  //
  // The fix: `setEnrichment(clusterId, llmEnrichment)` on the
  // overlay. Wraps supersedeNode + reconciles groups edges in one
  // transaction.
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);
  overlay.insertCluster({
    clusterId: "to-enrich",
    name: "cluster-y",
    memberCount: 4,
    contentHash: "h1",
    memberElementIds: ["m1", "m2", "m3", "m4"],
  });
  // This method does not yet exist — test will fail with TypeError
  // until 5.0.39 ships the method.
  const o = overlay as unknown as {
    setEnrichment(
      clusterId: string,
      enrichment: { name: string; displayName?: string; summary?: string },
    ): unknown;
  };
  o.setEnrichment("to-enrich", {
    name: "my-bc",
    displayName: "My Bounded Context",
    summary: "A test enrichment.",
  });
  assert.equal(
    overlay.liveMemberCount("to-enrich"),
    4,
    "setEnrichment lost groups edges — same class of bug as renameCluster",
  );
  const cluster = overlay.getCluster("to-enrich");
  const enriched = cluster?.metadata.llmEnrichment;
  assert.equal(enriched?.name, "my-bc");
  assert.equal(enriched?.displayName, "My Bounded Context");
});

test("renameCluster — throws on unknown clusterId", () => {
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);
  assert.throws(() => overlay.renameCluster("nonexistent", "Whatever"));
});

test("tombstoneCluster — removes from listClusters", () => {
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);
  overlay.insertCluster({
    clusterId: "doomed",
    name: "cluster-doomed",
    memberCount: 1,
    contentHash: "h1",
    memberElementIds: ["m1"],
  });
  assert.equal(overlay.listClusters().length, 1);
  overlay.tombstoneCluster("doomed");
  assert.equal(overlay.listClusters().length, 0);
});

test("tombstoneCluster — silent no-op on unknown clusterId", () => {
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);
  assert.doesNotThrow(() => overlay.tombstoneCluster("nonexistent"));
});

test("clusterForElement — recovers membership by walking groups edges", () => {
  const graph = makeGraph();
  // Register a domain we can insert a "member element" into so the
  // cluster's groups edge resolves to a real id.
  graph.registerOverlay({
    schemaVersion: 1,
    domain: "test-members",
    metadataSchema: { type: "object", properties: {} },
    indexes: [],
  });
  const memberNode = graph.transaction(
    { kind: "test", producerDomain: "test-members", summary: "seed member" },
    () => graph.insertNode({
      domain: "test-members",
      naturalKey: "member1",
      contentHash: "ch1",
      metadata: {},
    }),
  ).result;
  const overlay = makeClusterOverlay(graph);
  overlay.insertCluster({
    clusterId: "containerC",
    name: "cluster-foo",
    memberCount: 1,
    contentHash: "h1",
    memberElementIds: [memberNode.id],
  });
  const cluster = overlay.clusterForElement(memberNode.id);
  assert.ok(cluster);
  assert.equal(cluster.metadata.clusterId, "containerC");
});

test("getCluster — returns the cluster by id, undefined for unknown", () => {
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);
  overlay.insertCluster({
    clusterId: "known",
    name: "cluster-known",
    memberCount: 1,
    contentHash: "h1",
    memberElementIds: ["m1"],
  });
  const found = overlay.getCluster("known");
  const missing = overlay.getCluster("unknown");
  assert.ok(found);
  assert.equal(found.metadata.clusterId, "known");
  assert.equal(missing, undefined);
});

test("CLUSTER_DOMAIN — domain is the substrate identifier", () => {
  assert.equal(CLUSTER_DOMAIN, "cluster");
});

test("liveMemberCount — reflects live edges, not the at-insert snapshot (row 5.1.4.3)", () => {
  // Regression for Fathom 5.1.4.3: `metadata.memberCount` is set at
  // insert time and stays at that value even after member elements
  // get tombstoned (substrate's `tombstoneNode` cascade also
  // tombstones incoming edges). On a real workspace this drifts a
  // cluster's reported memberCount from its actual live-edge set
  // (Fathom self-analysis: cluster `43a96f6237e737ea` showed
  // metadata.memberCount=132 but only 1 live `groups` edge).
  // `liveMemberCount` must read from edges, not metadata.
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);

  // Insert three member element nodes so the groups edges are
  // resolved (live tombstone cascade requires resolved targetIds).
  graph.transaction(
    { kind: "test-elements", producerDomain: "analysis", summary: "test setup" },
    () => {
      graph.insertNode({ domain: "analysis", naturalKey: "m1", contentHash: "h-m1" });
      graph.insertNode({ domain: "analysis", naturalKey: "m2", contentHash: "h-m2" });
      graph.insertNode({ domain: "analysis", naturalKey: "m3", contentHash: "h-m3" });
    },
  );
  const m1 = graph.getLiveNodeByNaturalKey("analysis", "m1")!;
  const m2 = graph.getLiveNodeByNaturalKey("analysis", "m2")!;
  const m3 = graph.getLiveNodeByNaturalKey("analysis", "m3")!;

  overlay.insertCluster({
    clusterId: "cluster-x",
    name: "cluster-x",
    memberCount: 3,
    contentHash: "ch_x",
    memberElementIds: [m1.id, m2.id, m3.id],
  });

  // Before tombstone: both views agree.
  assert.equal(overlay.getCluster("cluster-x")!.metadata.memberCount, 3);
  assert.equal(overlay.liveMemberCount("cluster-x"), 3);

  // Tombstone two member elements. The cluster overlay does NOT
  // observe these — its metadata.memberCount stays at 3.
  graph.transaction(
    { kind: "test-tombstones", producerDomain: "analysis", summary: "drop members" },
    () => {
      graph.tombstoneNode(m1.id);
      graph.tombstoneNode(m2.id);
    },
  );

  // metadata.memberCount stays stale at 3 (this is the documented
  // snapshot behavior — preserved for callers that want it).
  assert.equal(overlay.getCluster("cluster-x")!.metadata.memberCount, 3);
  // liveMemberCount reflects reality: 1 member still live.
  assert.equal(overlay.liveMemberCount("cluster-x"), 1);
});

test("insertCluster — re-emits groups edges after element supersede (Fathom 5.0.22)", () => {
  // Regression for Fathom row 5.0.22: prior code deduped existing
  // edges by targetId, so when a member element superseded (new UUID,
  // same naturalKey) the dedup check missed the new UUID and emitted
  // a fresh edge — without tombstoning the stale edge pointing at the
  // now-superseded element. Both edges stayed live, inflating
  // `liveMemberCount` beyond `input.memberElementIds.length`.
  // Reconciliation tombstones the stale edge.
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);

  graph.transaction(
    { kind: "test-elements", producerDomain: "analysis", summary: "init" },
    () => {
      graph.insertNode({ domain: "analysis", naturalKey: "elem1", contentHash: "h-e1-v1" });
      graph.insertNode({ domain: "analysis", naturalKey: "elem2", contentHash: "h-e2-v1" });
    },
  );
  const e1 = graph.getLiveNodeByNaturalKey("analysis", "elem1")!;
  const e2 = graph.getLiveNodeByNaturalKey("analysis", "elem2")!;

  overlay.insertCluster({
    clusterId: "C1",
    name: "cluster-c1",
    memberCount: 2,
    contentHash: "ch-c1",
    memberElementIds: [e1.id, e2.id],
  });
  assert.equal(overlay.liveMemberCount("C1"), 2);

  graph.transaction(
    { kind: "test-supersede", producerDomain: "analysis", summary: "update elem1" },
    () => {
      graph.supersedeNode(e1.id, { contentHash: "h-e1-v2" });
    },
  );
  const e1Prime = graph.getLiveNodeByNaturalKey("analysis", "elem1")!;
  assert.notEqual(e1.id, e1Prime.id);

  overlay.insertCluster({
    clusterId: "C1",
    name: "cluster-c1",
    memberCount: 2,
    contentHash: "ch-c1",
    memberElementIds: [e1Prime.id, e2.id],
  });

  // Post-fix: exactly 2 live members. Pre-fix: 3 (stale e1 + new e1Prime + e2).
  assert.equal(overlay.liveMemberCount("C1"), 2);

  // And those 2 members must point at LIVE element nodes.
  const clusterNode = graph.getLiveNodeByNaturalKey("cluster", "C1")!;
  const liveTargetCount = graph
    .edgesFrom(clusterNode.id, { type: GROUPS_EDGE_TYPE })
    .filter((e) => e.targetId !== null)
    .map((e) => graph.getNodeById(e.targetId!))
    .filter((n) => n !== undefined && n.lifecycleState === "live")
    .length;
  assert.equal(liveTargetCount, 2);
});

test("insertCluster — drops members no longer in input (drift-down)", () => {
  // Regression: cluster member set shrinks across re-clusters (member
  // left the Louvain community); old edges to removed members must
  // tombstone, not linger.
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);

  graph.transaction(
    { kind: "test-elements", producerDomain: "analysis", summary: "init" },
    () => {
      graph.insertNode({ domain: "analysis", naturalKey: "m1", contentHash: "h1" });
      graph.insertNode({ domain: "analysis", naturalKey: "m2", contentHash: "h2" });
      graph.insertNode({ domain: "analysis", naturalKey: "m3", contentHash: "h3" });
    },
  );
  const m1 = graph.getLiveNodeByNaturalKey("analysis", "m1")!;
  const m2 = graph.getLiveNodeByNaturalKey("analysis", "m2")!;
  const m3 = graph.getLiveNodeByNaturalKey("analysis", "m3")!;

  overlay.insertCluster({
    clusterId: "CD",
    name: "cluster-cd",
    memberCount: 3,
    contentHash: "ch-cd-v1",
    memberElementIds: [m1.id, m2.id, m3.id],
  });
  assert.equal(overlay.liveMemberCount("CD"), 3);

  // Re-cluster with only m1; m2/m3 left the community. Different
  // contentHash would normally trigger supersede + edge re-emit, but
  // an explicit drift-down with same-hash should still reconcile.
  overlay.insertCluster({
    clusterId: "CD",
    name: "cluster-cd",
    memberCount: 1,
    contentHash: "ch-cd-v1",
    memberElementIds: [m1.id],
  });
  assert.equal(overlay.liveMemberCount("CD"), 1);
});

test("insertCluster — re-emits after tombstone cascade (Fathom 5.0.22 ghost variant)", () => {
  // Regression: when a member element tombstones, the substrate
  // cascade tombstones the cluster's outgoing groups edge to it
  // (incoming-to-target cascade). A subsequent insertCluster call
  // must re-emit fresh edges for the surviving members — the prior
  // code's `existingTargets` dedup was correct in this branch (the
  // cascaded edges aren't in `edgesFrom`'s live-only result), but
  // pinning the invariant here protects against future regressions.
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);

  graph.transaction(
    { kind: "test-elements", producerDomain: "analysis", summary: "init" },
    () => {
      graph.insertNode({ domain: "analysis", naturalKey: "e1", contentHash: "h1" });
      graph.insertNode({ domain: "analysis", naturalKey: "e2", contentHash: "h2" });
    },
  );
  const e1 = graph.getLiveNodeByNaturalKey("analysis", "e1")!;
  const e2 = graph.getLiveNodeByNaturalKey("analysis", "e2")!;

  overlay.insertCluster({
    clusterId: "CG",
    name: "cluster-cg",
    memberCount: 2,
    contentHash: "ch-cg",
    memberElementIds: [e1.id, e2.id],
  });

  graph.transaction(
    { kind: "test-tombstone", producerDomain: "analysis", summary: "drop e1" },
    () => {
      graph.tombstoneNode(e1.id);
    },
  );
  // Cascade has tombstoned the cluster→e1 edge.
  assert.equal(overlay.liveMemberCount("CG"), 1);

  // Re-call insertCluster with surviving member only.
  overlay.insertCluster({
    clusterId: "CG",
    name: "cluster-cg",
    memberCount: 1,
    contentHash: "ch-cg",
    memberElementIds: [e2.id],
  });
  assert.equal(overlay.liveMemberCount("CG"), 1);
});

test("liveMemberCount — returns 0 for unknown clusterId", () => {
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);
  assert.equal(overlay.liveMemberCount("does-not-exist"), 0);
});

// Fathom row 3.1.8.4 (disposition-layer wave 3a): ADDITIVE — insertCluster's
// groups-edge reconciliation ALSO emits `analysis-disposition` edges
// (single kind `"groups"`) via `@kepello/nodegraph-dispositions`'s
// `recordDispositions`, authored through THIS overlay's own
// CLUSTER_DOMAIN-scoped mutator (substrate rule 5.0.42 — the edge
// source is the cluster node, in the `cluster` domain, never
// `disposition`). Membership (`groups`) edges STAY — both families
// coexist until wave 4 retires membership emission.

test("insertCluster — ALSO emits analysis-disposition edges (kind groups) for every member (Fathom row 3.1.8.4 wave 3a)", () => {
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);
  overlay.insertCluster({
    clusterId: "disp-basic",
    name: "cluster-disp",
    memberCount: 2,
    contentHash: "ch_disp",
    memberElementIds: ["member1", "member2"],
  });
  const clusterNode = graph.getLiveNodeByNaturalKey(CLUSTER_DOMAIN, "disp-basic")!;

  // Membership edges STAY. (member1/member2 are bare ids with no
  // backing node — dangling targetRef edges; includeDangling: true
  // resolves them, same as `membersOf`'s own convention.)
  const groupsEdges = graph.edgesFrom(clusterNode.id, {
    type: GROUPS_EDGE_TYPE,
    includeDangling: true,
  });
  assert.equal(groupsEdges.length, 2);

  // New: analysis-disposition edges, one per member, single kind "groups".
  const dispositionEdges = graph.edgesFrom(clusterNode.id, {
    type: ANALYSIS_DISPOSITION_EDGE_TYPE,
    includeDangling: true,
  });
  assert.equal(dispositionEdges.length, 2);
  const targets = dispositionEdges
    .map((e) => e.targetId ?? e.targetRef)
    .sort();
  assert.deepEqual(targets, ["member1", "member2"]);
  for (const e of dispositionEdges) {
    assert.equal(e.subtype, "groups");
    assert.deepEqual(e.metadata?.kinds, ["groups"]);
  }
});

test("insertCluster — analysis-disposition edges idempotent on identical content-hash (no duplicates)", () => {
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);
  const input = {
    clusterId: "disp-idem",
    name: "cluster-disp-idem",
    memberCount: 1,
    contentHash: "ch_idem",
    memberElementIds: ["m1"],
  };
  overlay.insertCluster(input);
  overlay.insertCluster(input);
  const clusterNode = graph.getLiveNodeByNaturalKey(CLUSTER_DOMAIN, "disp-idem")!;
  const dispositionEdges = graph.edgesFrom(clusterNode.id, {
    type: ANALYSIS_DISPOSITION_EDGE_TYPE,
    includeDangling: true,
  });
  assert.equal(dispositionEdges.length, 1);
});

test("insertCluster — analysis-disposition edges reconcile on drift-down, mirroring groups edges (Fathom row 3.1.8.4 wave 3a)", () => {
  // Same shape as "insertCluster — drops members no longer in input
  // (drift-down)" above, but for the new disposition-edge family: a
  // stale disposition edge to a member that left the cluster must
  // tombstone, not linger — a lingering edge would silently misstate
  // provenance (cluster claims a member it no longer has).
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);

  graph.transaction(
    { kind: "test-elements", producerDomain: "analysis", summary: "init" },
    () => {
      graph.insertNode({ domain: "analysis", naturalKey: "m1", contentHash: "h1" });
      graph.insertNode({ domain: "analysis", naturalKey: "m2", contentHash: "h2" });
      graph.insertNode({ domain: "analysis", naturalKey: "m3", contentHash: "h3" });
    },
  );
  const m1 = graph.getLiveNodeByNaturalKey("analysis", "m1")!;
  const m2 = graph.getLiveNodeByNaturalKey("analysis", "m2")!;
  const m3 = graph.getLiveNodeByNaturalKey("analysis", "m3")!;

  overlay.insertCluster({
    clusterId: "disp-drift",
    name: "cluster-disp-drift",
    memberCount: 3,
    contentHash: "ch-drift-v1",
    memberElementIds: [m1.id, m2.id, m3.id],
  });
  const clusterNode = graph.getLiveNodeByNaturalKey(CLUSTER_DOMAIN, "disp-drift")!;
  assert.equal(
    graph.edgesFrom(clusterNode.id, { type: ANALYSIS_DISPOSITION_EDGE_TYPE }).length,
    3,
  );

  // Re-cluster with only m1; m2/m3 left the community.
  overlay.insertCluster({
    clusterId: "disp-drift",
    name: "cluster-disp-drift",
    memberCount: 1,
    contentHash: "ch-drift-v1",
    memberElementIds: [m1.id],
  });
  const liveDispositionEdges = graph.edgesFrom(clusterNode.id, {
    type: ANALYSIS_DISPOSITION_EDGE_TYPE,
  });
  assert.equal(liveDispositionEdges.length, 1);
  assert.equal(liveDispositionEdges[0]!.targetId, m1.id);
});

test("renameCluster — PRESERVES analysis-disposition edges through supersede, mirroring groups edges (Fathom row 3.1.8.4 wave 3a)", () => {
  const graph = makeGraph();
  const overlay = makeClusterOverlay(graph);
  overlay.insertCluster({
    clusterId: "disp-rename",
    name: "cluster-disp-rename",
    memberCount: 3,
    contentHash: "h1",
    memberElementIds: ["m1", "m2", "m3"],
  });
  overlay.renameCluster("disp-rename", "Operator-Picked Name");
  const clusterNode = graph.getLiveNodeByNaturalKey(CLUSTER_DOMAIN, "disp-rename")!;
  const dispositionEdges = graph.edgesFrom(clusterNode.id, {
    type: ANALYSIS_DISPOSITION_EDGE_TYPE,
    includeDangling: true,
  });
  assert.equal(
    dispositionEdges.length,
    3,
    "renameCluster lost analysis-disposition edges — same class of bug 5.0.39 fixed for groups edges",
  );
});
