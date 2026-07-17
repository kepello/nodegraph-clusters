/**
 * Cluster overlay implementation over a `GraphLayer`. Registers the
 * `"cluster"` domain idempotently at construction time and provides
 * the write + read API surfaced by `ClusterOverlay`.
 *
 * Members are attached via outgoing `analysis-disposition` edges
 * (kind `"groups"`, per `@kepello/nodegraph-dispositions`) on the
 * cluster node, addressed by the element's substrate UUID (when
 * resolvable via `getNodeById`) or natural key (otherwise, stored as
 * `targetRef` and resolved lazily by the substrate's dangling-edge
 * mechanism). Fathom row 3.1.8.4 (disposition-layer wave 4): this is
 * THE membership record — the legacy `groups` edge type this overlay
 * used to emit alongside it (wave 3a, additive) is retired.
 */

import type { Edge, GraphLayer, GraphMutator, Node } from "@kepello/nodegraph-core";
import {
  ANALYSIS_DISPOSITION_EDGE_TYPE,
  makeDispositionOverlay,
  type DispositionCandidate,
  type DispositionOverlay,
  type PositiveKind,
} from "@kepello/nodegraph-dispositions";
import {
  CLUSTER_DOMAIN,
  CLUSTER_INDEXES,
  CLUSTER_METADATA_KIND,
  CLUSTER_METADATA_SCHEMA,
  CLUSTER_SCHEMA_VERSION,
} from "./schema.js";
import type {
  ClusterInput,
  ClusterMetadata,
  ClusterNode,
  ClusterOverlay,
} from "./types.js";

export class ClusterOverlayImpl implements ClusterOverlay {
  private readonly mutator: GraphMutator<typeof CLUSTER_DOMAIN>;
  // Fathom row 3.1.8.4 (disposition-layer wave 4): the shared
  // disposition overlay, used ONLY to call `recordDispositions` with
  // THIS overlay's own CLUSTER_DOMAIN-scoped mutator (see that
  // package's overlay.ts doc comment — `analysis-disposition` edges
  // are sourced in the PRODUCING domain, never `disposition`, per
  // substrate rule 5.0.42). Construction is idempotent (mirrors this
  // class's own `registerOverlay` idempotency, pinned above).
  private readonly dispositions: DispositionOverlay;

  constructor(private readonly graph: GraphLayer) {
    // Per Fathom row 5.0.42: registerOverlay returns the domain-scoped
    // mutator; this overlay holds it for all substrate writes. Reads
    // continue via `this.graph` (GraphReader surface).
    this.mutator = this.graph.registerOverlay({
      domain: CLUSTER_DOMAIN,
      schemaVersion: CLUSTER_SCHEMA_VERSION,
      metadataSchema: CLUSTER_METADATA_SCHEMA,
      indexes: CLUSTER_INDEXES,
    });
    this.dispositions = makeDispositionOverlay(this.graph);
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

    this.reconcileDispositionEdges(clusterNode.id, input.memberElementIds);
    return asCluster(clusterNode);
  }

  /**
   * Reconcile a cluster node's outgoing `analysis-disposition` edges
   * (kind `"groups"`) to mirror `desiredMemberElementIds` exactly —
   * THE membership reconcile path since wave 4. Tombstones any live
   * disposition edge whose target isn't in the desired set (a member
   * that left the cluster — a lingering edge would silently misstate
   * provenance), then `recordDispositions` the full desired set (the
   * disposition overlay's own create-or-update collapse handles the
   * unchanged-member no-op).
   *
   * Per Fathom row 5.0.22 (initial `groups`-edge reconciliation) and
   * 5.0.39 (extracted into a shared helper so `renameCluster` +
   * `setEnrichment` can both call it after `supersedeNode`). Calling
   * raw `supersedeNode` on a cluster node cascades the prior tip's
   * outgoing edges to tombstoned — every method that supersedes the
   * cluster node MUST call this helper afterwards to re-establish
   * membership.
   *
   * Fathom row 3.1.8.4 (disposition-layer wave 4): retires the legacy
   * `groups`-edge family this method used to ALSO reconcile (wave 3a,
   * additive coexistence) — `analysis-disposition` edges are now the
   * ONLY membership record this overlay writes. Sourced through THIS
   * overlay's `mutator` (CLUSTER_DOMAIN) — per the disposition
   * package's own `overlay.ts` doc comment, `analysis-disposition`
   * edges must be authored by the PRODUCING overlay's domain-scoped
   * mutator, never `disposition`'s own.
   */
  private reconcileDispositionEdges(
    clusterNodeId: string,
    desiredMemberElementIds: readonly string[],
  ): void {
    const desiredMemberIds = new Set(desiredMemberElementIds);
    const existingDispositionEdges = this.graph.edgesFrom(clusterNodeId, {
      type: ANALYSIS_DISPOSITION_EDGE_TYPE,
      includeDangling: true,
    });
    for (const e of existingDispositionEdges) {
      const key = e.targetId ?? e.targetRef;
      if (key === null || !desiredMemberIds.has(key)) {
        this.mutator.tombstoneEdge(e.id);
      }
    }
    if (desiredMemberElementIds.length === 0) return;
    const desiredMemberNodes = this.graph.getNodesByIds(desiredMemberElementIds);
    const batch: DispositionCandidate[] = desiredMemberElementIds.map((memberId) =>
      desiredMemberNodes.has(memberId)
        ? { sourceId: clusterNodeId, targetId: memberId, kind: "groups" }
        : { sourceId: clusterNodeId, targetRef: memberId, kind: "groups" },
    );
    this.dispositions.recordDispositions(this.mutator, batch);
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
   * `analysis-disposition` (kind `groups`) edges from the new node
   * UUID against the live member set recovered from the prior tip's
   * outgoing edges. Per Fathom row 5.0.39 — raw `supersedeNode`
   * cascades the prior tip's outgoing edges to tombstoned, so every
   * metadata-only supersede MUST follow with edge re-reconciliation to
   * preserve membership.
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
    // Read the prior tip's live membership-edge targets BEFORE
    // supersede. `supersedeNode` will cascade-tombstone them; we
    // capture the member set now so the reconcile pass can re-emit
    // identical edges from the new tip's UUID. Filtered on kind
    // `groups` (never subtype equality — see `clusterForElement`'s
    // doc comment) in case a future disposition kind ever shares this
    // edge type from the same source; today it's the only kind this
    // overlay's mutator ever writes.
    const memberTargets: string[] = [];
    for (const e of this.graph.edgesFrom(existing.id, {
      type: ANALYSIS_DISPOSITION_EDGE_TYPE,
      includeDangling: true,
    })) {
      if (!hasGroupsKind(e)) continue;
      const key = e.targetId ?? e.targetRef;
      if (key !== null) memberTargets.push(key);
    }
    const next = transform(priorMetadata);
    const node = this.mutator.supersedeNode(existing.id, {
      contentHash: existing.contentHash,
      metadata: next as unknown,
    });
    this.reconcileDispositionEdges(node.id, memberTargets);
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
    // `analysis-disposition` is a shared edge type — an element can be
    // the target of many kinds from many producing domains (L2's
    // entry/composes/uses, L6's role, L7b's realizedBy, …), so reads
    // MUST filter on `metadata.kinds` CONTAINS `groups`, never subtype
    // equality (a co-occurring kind, were one ever added on this same
    // pair, would still carry `groups` in `kinds` but might not be the
    // PRIMARY/subtype).
    const edges = this.graph
      .edgesTo(elementId, { type: ANALYSIS_DISPOSITION_EDGE_TYPE })
      .filter(hasGroupsKind);
    if (edges.length === 0) {
      // Try natural-key form for elements not yet resolved to a UUID.
      const edgesByRef = this.graph
        .queryEdges({ targetRef: elementId, type: ANALYSIS_DISPOSITION_EDGE_TYPE })
        .filter(hasGroupsKind);
      if (edgesByRef.length === 0) return undefined;
      edges.push(...edgesByRef);
    }
    // Each member belongs to at most one cluster (per the algorithm),
    // so we expect a single live source. If multiple show up, return
    // the first live one.
    // Per Fathom row `perf-getbyid-consumer-migrations` (5.0.1.2.3.1):
    // batch the per-edge source-node hydration into one IN-clause query.
    const sourceNodes = this.graph.getNodesByIds(edges.map((e) => e.sourceId));
    for (const edge of edges) {
      const node = sourceNodes.get(edge.sourceId);
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
    return this.graph
      .edgesFrom(cluster.id, {
        type: ANALYSIS_DISPOSITION_EDGE_TYPE,
        includeDangling: true,
      })
      .filter(hasGroupsKind);
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
  // `!== undefined` (not a truthiness/nullish check) is deliberate:
  // honest-null contract (5.4.0.1) — an explicit `null` (edge-less or
  // inbound-only cluster) must persist as an observable `null`, distinct
  // from an omitted field (caller never computed a score at all).
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
 * Kinds carried on an `analysis-disposition` edge (`metadata.kinds`).
 * Mirrors `@kepello/nodegraph-domain-model/src/overlay.ts`'s own
 * `edgeKinds` helper — same shape, independently kept per-package
 * since the disposition package deliberately exposes no shared read
 * helper (each producing overlay owns its own read path).
 */
function edgeKinds(edge: Edge): PositiveKind[] {
  const metadata = edge.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return [];
  }
  const kinds = (metadata as { kinds?: unknown }).kinds;
  return Array.isArray(kinds) ? (kinds as PositiveKind[]) : [];
}

/**
 * True when `edge`'s `metadata.kinds` contains `"groups"`. Read
 * filter, never subtype equality — see `clusterForElement`'s doc
 * comment for why (an `analysis-disposition` edge's `subtype` is only
 * the PRIMARY kind when multiple co-occur on one pair).
 */
function hasGroupsKind(edge: Edge): boolean {
  return edgeKinds(edge).includes("groups");
}

/**
 * Convenience factory that mirrors the existing
 * `makeElementOverlay(graph)` pattern in `@kepello/nodegraph-analysis`.
 */
export function makeClusterOverlay(graph: GraphLayer): ClusterOverlay {
  return new ClusterOverlayImpl(graph);
}
