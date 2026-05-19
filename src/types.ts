/**
 * Cluster overlay public types. Each cluster is a recovered grouping
 * of L0 element nodes (typically classes + top-level functions) that
 * the Louvain community-detection pass identifies as cohesively coupled.
 * Methods inherit their parent class's cluster transitively (the
 * overlay does not stamp every method individually).
 */

import type { Node, Edge } from "@kepello/nodegraph-core";
import { CLUSTER_METADATA_KIND } from "./schema.js";

/**
 * Per-cluster aggregate dependency to another cluster. Computed from
 * the underlying element-level edges that cross cluster boundaries.
 *
 * Fathom row 5.0.28 (d): split into `rawEdgeCount` (integer count
 * of distinct contributing edges) + `weightedEdgeCount` (sum of
 * per-edge weights, often fractional after edge-type weighting
 * introduced in row 5.0.14). The legacy `edgeCount` field is
 * removed — consumers must read the new names. Round-5 pilot F14
 * surfaced fractional values like `15.400000000000007` leaking
 * through a field named "edgeCount"; explicit weighted-vs-raw split
 * resolves the ambiguity.
 */
export interface ClusterDependency {
  targetClusterId: string;
  /** Count of distinct element-level edges crossing the cluster boundary (integer). */
  rawEdgeCount: number;
  /** Sum of per-edge weights (may be fractional after edge-type weighting). */
  weightedEdgeCount: number;
}

/**
 * Cluster node metadata. The substrate validates this against
 * `CLUSTER_METADATA_SCHEMA` at write time when `nodegraph-core@0.5.0+`.
 */
export interface ClusterMetadata {
  kind: typeof CLUSTER_METADATA_KIND;
  /** Content-hash identity. Survives membership drift up to ~50%. */
  clusterId: string;
  /** TF-IDF-derived name. 1-3 distinguishing terms joined by '-'. */
  name: string;
  /** Operator-supplied override; takes precedence over `name` in renders. */
  displayName?: string;
  /** Source language; absent for cross-language clusters (none in v1). */
  language?: string;
  /** Number of L0 elements grouped. */
  memberCount: number;
  /** Heuristic confidence rank ∈ [0, 1]; not calibrated to external benchmarks. */
  confidenceScore?: number;
  /** Per-target aggregate edge counts to other clusters. */
  dependsOn?: ClusterDependency[];
  /**
   * Canonical-member-set hash — content-hash over the sorted set of
   * member naturalKeys. Stable across content changes (member
   * naturalKeys don't shift when source files change; contentHashes
   * do). Two clusters with the same `canonicalMemberSetHash` are
   * "the same cluster" for enrichment-preservation purposes. Fathom
   * row 5.0.31: enables `llmEnrichment` to lift forward across
   * Louvain re-emissions.
   *
   * Optional for backward compatibility — when absent, no
   * enrichment-preservation happens (current pre-5.0.31 behavior).
   */
  canonicalMemberSetHash?: string;
  /**
   * LLM-produced naming enrichment (Haiku-namer pipeline output).
   * Persisted on the cluster's metadata; survives Louvain
   * re-emissions when `canonicalMemberSetHash` matches a prior live
   * cluster (Fathom row 5.0.31).
   */
  llmEnrichment?: {
    name?: string;
    displayName?: string;
    summary?: string;
    provenance?: { model?: string; generatedAt?: string };
  };
}

/**
 * Input to `insertCluster`. Identity is the natural key — equal to
 * `metadata.clusterId` — so re-inserting an identical cluster is a
 * no-op upsert at the substrate level.
 */
export interface ClusterInput {
  clusterId: string;
  name: string;
  displayName?: string;
  language?: string;
  memberCount: number;
  confidenceScore?: number;
  dependsOn?: ClusterDependency[];
  /** Stable content-hash this cluster's identity was derived from. */
  contentHash: string;
  /**
   * Member element ids the overlay should attach via outgoing `groups`
   * edges at write time. May be UUIDs (resolved) or natural-key strings
   * (substrate stores as `targetRef` and resolves lazily).
   */
  memberElementIds: readonly string[];
  /**
   * Canonical-member-set hash — see ClusterMetadata. Caller-supplied;
   * the cluster overlay does not compute it (it doesn't know the
   * member naturalKeys, only their UUIDs). The runner (fathom-cli's
   * `runAbstractions`) computes from sorted member naturalKeys.
   * Fathom row 5.0.31.
   */
  canonicalMemberSetHash?: string;
  /**
   * Fresh LLM enrichment to write on this cluster. When omitted AND
   * the cluster has a `canonicalMemberSetHash` matching a prior live
   * cluster's, that prior cluster's `llmEnrichment` is lifted forward.
   * When supplied, the input wins. Fathom row 5.0.31.
   */
  llmEnrichment?: {
    name?: string;
    displayName?: string;
    summary?: string;
    provenance?: { model?: string; generatedAt?: string };
  };
}

/**
 * Read projection. Same shape as `Node` but with typed metadata.
 */
export interface ClusterNode extends Omit<Node, "metadata"> {
  metadata: ClusterMetadata;
}

/**
 * Public cluster overlay. Returned by `makeClusterOverlay(graph)`;
 * registers the `"cluster"` domain plus indexes against the graph
 * layer at construction time.
 */
export interface ClusterOverlay {
  /**
   * Insert (or upsert at the substrate level) a cluster node + its
   * `groups` member edges. Returns the persisted cluster node.
   * Idempotent on identical input.
   */
  insertCluster(input: ClusterInput): ClusterNode;

  /**
   * Replace a cluster's metadata (e.g., to record an operator-supplied
   * `displayName`) without changing identity. Underlying substrate
   * supersession is used — prior tip becomes historical.
   */
  renameCluster(clusterId: string, displayName: string): ClusterNode;

  /** Tombstone (logically delete) a cluster node. */
  tombstoneCluster(clusterId: string): void;

  // Reads

  /** All live cluster nodes in this graph. */
  listClusters(): ClusterNode[];

  /** Lookup by content-hash identity. */
  getCluster(clusterId: string): ClusterNode | undefined;

  /**
   * Resolve the cluster (if any) that groups a given element id.
   * Walks the `groups` edges; returns undefined when the element
   * has not been assigned to any cluster.
   */
  clusterForElement(elementId: string): ClusterNode | undefined;

  /**
   * Outgoing `groups` edges for a cluster — the element ids it owns.
   * Returns substrate edges; targetId is set for resolved members,
   * targetRef for unresolved (dangling) ones.
   */
  membersOf(clusterId: string): Edge[];

  /**
   * Current live-member count derived from `groups` edges. Closes
   * Fathom row 5.1.4.3: cluster metadata's `memberCount` is set at
   * insert time and goes stale as member elements are tombstoned by
   * downstream analyzer runs (substrate's `tombstoneNode` cascade
   * also tombstones incoming edges, including this cluster's
   * `groups` edges to that element). Consumers wanting the *current*
   * count must read this instead of `metadata.memberCount`.
   *
   * Returns 0 when the cluster doesn't exist or has no live members.
   */
  liveMemberCount(clusterId: string): number;
}
