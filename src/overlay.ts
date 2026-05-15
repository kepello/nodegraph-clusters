/**
 * Cluster overlay implementation over a `GraphLayer`. Registers the
 * `"cluster"` domain idempotently at construction time and provides
 * the write + read API surfaced by `ClusterOverlay`.
 *
 * Members are attached via outgoing `groups` edges on the cluster
 * node, addressed by the element's substrate UUID (when resolvable
 * via `getNodeById`) or natural key (otherwise, stored as `targetRef`
 * and resolved lazily by the substrate's dangling-edge mechanism).
 */

import type { Edge, GraphLayer, Node } from "@kepello/nodegraph-core";
import {
  CLUSTER_DOMAIN,
  CLUSTER_INDEXES,
  CLUSTER_METADATA_KIND,
  CLUSTER_METADATA_SCHEMA,
} from "./schema.js";
import type {
  ClusterInput,
  ClusterMetadata,
  ClusterNode,
  ClusterOverlay,
} from "./types.js";

/** Edge type emitted from a cluster node to each of its member elements. */
export const GROUPS_EDGE_TYPE = "groups";

export class ClusterOverlayImpl implements ClusterOverlay {
  constructor(private readonly graph: GraphLayer) {
    try {
      this.graph.registerOverlay({
        domain: CLUSTER_DOMAIN,
        metadataSchema: CLUSTER_METADATA_SCHEMA,
        indexes: CLUSTER_INDEXES,
      });
    } catch (err) {
      // Tolerate re-registration on a long-lived graph that already
      // carries the domain (same pattern as the analysis overlay).
      if (
        !(err instanceof Error) ||
        !err.message.includes("already registered for domain")
      ) {
        throw err;
      }
    }
  }

  insertCluster(input: ClusterInput): ClusterNode {
    return this.graph.transaction(
      {
        kind: "insert-cluster",
        producerDomain: CLUSTER_DOMAIN,
        summary: `insert cluster ${input.clusterId}`,
      },
      () => this.doInsertCluster(input),
    ).result;
  }

  private doInsertCluster(input: ClusterInput): ClusterNode {
    const metadata = buildMetadata(input);
    const existing = this.graph.getLiveNodeByNaturalKey(
      CLUSTER_DOMAIN,
      input.clusterId,
    );
    let clusterNode: Node;
    if (existing === undefined) {
      clusterNode = this.graph.insertNode({
        domain: CLUSTER_DOMAIN,
        naturalKey: input.clusterId,
        contentHash: input.contentHash,
        metadata: metadata as unknown,
      });
    } else if (existing.contentHash === input.contentHash) {
      // Same content — no-op upsert. Substrate insertNode would throw
      // on duplicate natural key, so we short-circuit.
      clusterNode = existing;
    } else {
      // Content changed — supersede the prior tip.
      clusterNode = this.graph.supersedeNode(existing.id, {
        contentHash: input.contentHash,
        metadata: metadata as unknown,
      });
    }

    // Write `groups` edges for each member. Deduplicate against any
    // edges that already exist (substrate's live-unique index enforces
    // this at write time, but checking first avoids transaction churn).
    const existingEdges = this.graph.edgesFrom(clusterNode.id, {
      type: GROUPS_EDGE_TYPE,
      includeDangling: true,
    });
    const existingTargets = new Set<string>();
    for (const e of existingEdges) {
      if (e.targetId !== null) existingTargets.add(e.targetId);
      if (e.targetRef !== null) existingTargets.add(e.targetRef);
    }
    for (const memberId of input.memberElementIds) {
      if (existingTargets.has(memberId)) continue;
      const byId = this.graph.getNodeById(memberId);
      if (byId !== undefined) {
        this.graph.insertEdge({
          sourceId: clusterNode.id,
          targetId: memberId,
          type: GROUPS_EDGE_TYPE,
        });
      } else {
        this.graph.insertEdge({
          sourceId: clusterNode.id,
          targetRef: memberId,
          type: GROUPS_EDGE_TYPE,
        });
      }
    }

    return asCluster(clusterNode);
  }

  renameCluster(clusterId: string, displayName: string): ClusterNode {
    return this.graph.transaction(
      {
        kind: "rename-cluster",
        producerDomain: CLUSTER_DOMAIN,
        summary: `rename cluster ${clusterId}`,
      },
      () => this.doRenameCluster(clusterId, displayName),
    ).result;
  }

  private doRenameCluster(clusterId: string, displayName: string): ClusterNode {
    const existing = this.graph.getLiveNodeByNaturalKey(
      CLUSTER_DOMAIN,
      clusterId,
    );
    if (existing === undefined) {
      throw new Error(`No live cluster with clusterId=${clusterId}`);
    }
    const priorMetadata = existing.metadata as ClusterMetadata | null;
    if (priorMetadata === null) {
      throw new Error(`Cluster ${clusterId} has no metadata`);
    }
    const next: ClusterMetadata = {
      ...priorMetadata,
      displayName,
    };
    const node = this.graph.supersedeNode(existing.id, {
      contentHash: existing.contentHash,
      metadata: next as unknown,
    });
    return asCluster(node);
  }

  tombstoneCluster(clusterId: string): void {
    this.graph.transaction(
      {
        kind: "tombstone-cluster",
        producerDomain: CLUSTER_DOMAIN,
        summary: `tombstone cluster ${clusterId}`,
      },
      () => {
        const existing = this.graph.getLiveNodeByNaturalKey(
          CLUSTER_DOMAIN,
          clusterId,
        );
        if (existing === undefined) return;
        this.graph.tombstoneNode(existing.id);
      },
    );
  }

  listClusters(): ClusterNode[] {
    return this.graph
      .queryNodes({ domain: CLUSTER_DOMAIN, lifecycleState: "live" })
      .map(asCluster);
  }

  getCluster(clusterId: string): ClusterNode | undefined {
    const node = this.graph.getLiveNodeByNaturalKey(CLUSTER_DOMAIN, clusterId);
    return node === undefined ? undefined : asCluster(node);
  }

  clusterForElement(elementId: string): ClusterNode | undefined {
    const edges = this.graph.edgesTo(elementId, {
      type: GROUPS_EDGE_TYPE,
    });
    if (edges.length === 0) {
      // Try natural-key form for elements not yet resolved to a UUID.
      const edgesByRef = this.graph
        .queryEdges({ targetRef: elementId, type: GROUPS_EDGE_TYPE });
      if (edgesByRef.length === 0) return undefined;
      edges.push(...edgesByRef);
    }
    // Each member belongs to at most one cluster (per the algorithm),
    // so we expect a single live source. If multiple show up, return
    // the first live one.
    for (const edge of edges) {
      const node = this.graph.getNodeById(edge.sourceId);
      if (node !== undefined && node.lifecycleState === "live") {
        return asCluster(node);
      }
    }
    return undefined;
  }

  membersOf(clusterId: string): Edge[] {
    const cluster = this.graph.getLiveNodeByNaturalKey(
      CLUSTER_DOMAIN,
      clusterId,
    );
    if (cluster === undefined) return [];
    return this.graph.edgesFrom(cluster.id, {
      type: GROUPS_EDGE_TYPE,
      includeDangling: true,
    });
  }
}

function buildMetadata(input: ClusterInput): ClusterMetadata {
  const meta: ClusterMetadata = {
    kind: CLUSTER_METADATA_KIND,
    clusterId: input.clusterId,
    name: input.name,
    memberCount: input.memberCount,
  };
  if (input.displayName !== undefined) meta.displayName = input.displayName;
  if (input.language !== undefined) meta.language = input.language;
  if (input.confidenceScore !== undefined) {
    meta.confidenceScore = input.confidenceScore;
  }
  if (input.dependsOn !== undefined && input.dependsOn.length > 0) {
    meta.dependsOn = [...input.dependsOn];
  }
  return meta;
}

function asCluster(node: Node): ClusterNode {
  return node as ClusterNode;
}

/**
 * Convenience factory that mirrors the existing
 * `makeElementOverlay(graph)` pattern in `@kepello/nodegraph-analysis`.
 */
export function makeClusterOverlay(graph: GraphLayer): ClusterOverlay {
  return new ClusterOverlayImpl(graph);
}
