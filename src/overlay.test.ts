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
import { CLUSTER_DOMAIN, CLUSTER_METADATA_KIND } from "./schema.js";
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
