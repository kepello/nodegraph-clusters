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

import type { Edge, GraphLayer, GraphMutator, Node } from "@kepello/nodegraph-core";
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
  private readonly mutator: GraphMutator<typeof CLUSTER_DOMAIN>;

  constructor(private readonly graph: GraphLayer) {
    // Per Fathom row 5.0.42: registerOverlay returns the domain-scoped
    // mutator; this overlay holds it for all substrate writes. Reads
    // continue via `this.graph` (GraphReader surface).
    this.mutator = this.graph.registerOverlay({
      domain: CLUSTER_DOMAIN,
      metadataSchema: CLUSTER_METADATA_SCHEMA,
      indexes: CLUSTER_INDEXES,
    });
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
    // Fathom row 5.0.31: when the input doesn't carry a fresh
    // `llmEnrichment` AND has a `canonicalMemberSetHash`, look up any
    // live cluster with the same canonical member set and lift its
    // `llmEnrichment` forward. This survives Louvain re-emissions
    // that produce fresh clusterIds (different contentHashes) for the
    // same canonical membership.
    let liftedEnrichment: ClusterInput["llmEnrichment"] | undefined;
    if (
      input.canonicalMemberSetHash !== undefined &&
      input.llmEnrichment === undefined
    ) {
      const priors = this.graph.queryNodes({
        domain: CLUSTER_DOMAIN,
        lifecycleState: "live",
        "metadata.canonicalMemberSetHash": input.canonicalMemberSetHash,
      });
      for (const p of priors) {
        // Skip the cluster being inserted itself if it already exists
        // by clusterId (shouldn't happen — we check `existing` below
        // — but defensive).
        const pMeta = p.metadata as { clusterId?: string; llmEnrichment?: ClusterInput["llmEnrichment"] };
        if (pMeta.clusterId === input.clusterId) continue;
        if (pMeta.llmEnrichment !== undefined) {
          liftedEnrichment = pMeta.llmEnrichment;
          break;
        }
      }
    }
    const metadata = buildMetadata(input, liftedEnrichment);
    const existing = this.graph.getLiveNodeByNaturalKey(
      CLUSTER_DOMAIN,
      input.clusterId,
    );
    let clusterNode: Node;
    if (existing === undefined) {
      clusterNode = this.mutator.insertNode({
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
      clusterNode = this.mutator.supersedeNode(existing.id, {
        contentHash: input.contentHash,
        metadata: metadata as unknown,
      });
    }

    this.reconcileGroupsEdges(clusterNode.id, input.memberElementIds);
    return asCluster(clusterNode);
  }

  /**
   * Reconcile a cluster node's outgoing `groups` edges to mirror
   * `desiredMemberElementIds` exactly. Tombstones edges whose target
   * is non-live or not in the desired set; emits fresh edges for any
   * desired member not already represented.
   *
   * Per Fathom row 5.0.22 (initial reconciliation) and 5.0.39
   * (extracted into a shared helper so `renameCluster` + `setEnrichment`
   * can both call it after `supersedeNode`). Calling raw `supersedeNode`
   * on a cluster node cascades the prior tip's outgoing edges to
   * tombstoned — every method that supersedes the cluster node MUST
   * call this helper afterwards to re-establish membership.
   */
  private reconcileGroupsEdges(
    clusterNodeId: string,
    desiredMemberElementIds: readonly string[],
  ): void {
    const desiredMemberIds = new Set(desiredMemberElementIds);
    const existingEdges = this.graph.edgesFrom(clusterNodeId, {
      type: GROUPS_EDGE_TYPE,
      includeDangling: true,
    });
    const presentTargets = new Set<string>();
    for (const e of existingEdges) {
      const key = e.targetId ?? e.targetRef;
      if (key === null) continue;
      const targetIsNonLive =
        e.targetId !== null &&
        this.graph.getNodeById(e.targetId)?.lifecycleState !== "live";
      const notInDesired = !desiredMemberIds.has(key);
      if (targetIsNonLive || notInDesired) {
        this.mutator.tombstoneEdge(e.id);
      } else {
        presentTargets.add(key);
      }
    }
    for (const memberId of desiredMemberElementIds) {
      if (presentTargets.has(memberId)) continue;
      const byId = this.graph.getNodeById(memberId);
      if (byId !== undefined) {
        this.mutator.insertEdge({
          sourceId: clusterNodeId,
          targetId: memberId,
          type: GROUPS_EDGE_TYPE,
        });
      } else {
        this.mutator.insertEdge({
          sourceId: clusterNodeId,
          targetRef: memberId,
          type: GROUPS_EDGE_TYPE,
        });
      }
    }
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
    return this.supersedeWithMetadata(clusterId, (prior) => ({
      ...prior,
      displayName,
    }));
  }

  setEnrichment(
    clusterId: string,
    enrichment: ClusterMetadata["llmEnrichment"],
  ): ClusterNode {
    return this.graph.transaction(
      {
        kind: "set-cluster-enrichment",
        producerDomain: CLUSTER_DOMAIN,
        summary: `set llmEnrichment on cluster ${clusterId}`,
      },
      () =>
        this.supersedeWithMetadata(clusterId, (prior) => ({
          ...prior,
          llmEnrichment: enrichment,
        })),
    ).result;
  }

  /**
   * Shared supersede helper for cluster-metadata-only changes (rename,
   * enrichment writes). Reads the existing live cluster, supersedes
   * with the caller's transformed metadata, then re-reconciles
   * `groups` edges from the new node UUID against the live member set
   * recovered from the prior tip's outgoing edges. Per Fathom row
   * 5.0.39 — raw `supersedeNode` cascades the prior tip's outgoing
   * edges to tombstoned, so every metadata-only supersede MUST follow
   * with edge re-reconciliation to preserve membership.
   */
  private supersedeWithMetadata(
    clusterId: string,
    transform: (prior: ClusterMetadata) => ClusterMetadata,
  ): ClusterNode {
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
    // Read the prior tip's live group-edge targets BEFORE supersede.
    // `supersedeNode` will cascade-tombstone them; we capture the
    // member set now so the reconcile pass can re-emit identical edges
    // from the new tip's UUID.
    const memberTargets: string[] = [];
    for (const e of this.graph.edgesFrom(existing.id, {
      type: GROUPS_EDGE_TYPE,
      includeDangling: true,
    })) {
      const key = e.targetId ?? e.targetRef;
      if (key !== null) memberTargets.push(key);
    }
    const next = transform(priorMetadata);
    const node = this.mutator.supersedeNode(existing.id, {
      contentHash: existing.contentHash,
      metadata: next as unknown,
    });
    this.reconcileGroupsEdges(node.id, memberTargets);
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
        this.mutator.tombstoneNode(existing.id);
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

  liveMemberCount(clusterId: string): number {
    return this.membersOf(clusterId).length;
  }
}

function buildMetadata(
  input: ClusterInput,
  liftedEnrichment?: ClusterInput["llmEnrichment"],
): ClusterMetadata {
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
  if (input.canonicalMemberSetHash !== undefined) {
    meta.canonicalMemberSetHash = input.canonicalMemberSetHash;
  }
  // Fathom row 5.0.31: fresh input wins; lifted-forward fills in when
  // input is absent.
  const enrichment = input.llmEnrichment ?? liftedEnrichment;
  if (enrichment !== undefined) {
    meta.llmEnrichment = { ...enrichment };
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
