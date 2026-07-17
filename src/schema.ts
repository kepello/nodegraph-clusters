/**
 * Cluster overlay domain + IndexSpecs + JSON Schema. Registered against
 * the substrate at overlay construction time. Mirrors the analysis
 * overlay's schema shape (per `@kepello/nodegraph-analysis/overlay`).
 */

import type { IndexSpec, MetadataSchema } from "@kepello/nodegraph-core";

export const CLUSTER_DOMAIN = "cluster";

/**
 * Per-overlay schema version (substrate 1.12.2). Part of this domain's
 * public contract — every registrant of `CLUSTER_DOMAIN` passes this so
 * the substrate's version stamp/tripwire stays in lockstep. Bump when
 * `CLUSTER_METADATA_SCHEMA` changes shape; V1 baseline is `1`.
 */
export const CLUSTER_SCHEMA_VERSION = 1;

/**
 * Discriminator stamped on every node this overlay writes. Reserved
 * value `"cluster"`; consumers must not overload the cluster domain
 * with other metadata kinds.
 */
export const CLUSTER_METADATA_KIND = "cluster";

/**
 * JSON Schema for the `ClusterMetadata` blob. Consumed by the
 * substrate's metadata-validation pass and by the inspector for
 * side-panel rendering.
 */
export const CLUSTER_METADATA_SCHEMA: MetadataSchema = {
  type: "object",
  title: "Recovered cluster",
  description:
    "A cohesive grouping of L0 element nodes recovered by Louvain community detection over their dependency edges. One node per cluster; `dependsOn` carries per-target aggregate counts to other clusters; members are reachable via outgoing `analysis-disposition` edges (kind `groups`) this overlay writes.",
  required: ["kind", "clusterId", "name", "memberCount"],
  properties: {
    kind: {
      type: "string",
      enum: ["cluster"],
      title: "Discriminator",
      description: "Always 'cluster' for nodes this overlay writes.",
    },
    clusterId: {
      type: "string",
      title: "Stable cluster id",
      description:
        "Content-hash identity. Equals `hash(sorted contentHashes of member elements)` — survives membership drift up to ~50%, drifts the id on larger churn.",
    },
    name: {
      type: "string",
      title: "Auto-generated name",
      description:
        "TF-IDF-derived label drawn from member identifier vocabulary. 1-3 distinguishing terms joined by '-' (e.g., 'cluster-orchestrator-subprocess'). Operator-overrideable via `displayName`.",
    },
    displayName: {
      type: "string",
      title: "Operator-supplied display name",
      description:
        "Optional override that takes precedence over `name` in human-facing renders. Operator sets via `.fathom/fathom.config.json` `clusters.rename` or future MCP tool.",
    },
    language: {
      type: "string",
      title: "Language",
      description:
        "Source language of the cluster members. Set when the cluster is single-language; absent for cross-language clusters (not produced in v1 — clusters stay per-language).",
    },
    memberCount: {
      type: "number",
      title: "Member count",
      description: "Number of L0 elements (classes / top-level functions) the cluster groups.",
    },
    confidenceScore: {
      type: "number",
      title: "Confidence score",
      description:
        "Internal modularity-quality contribution of the cluster, scaled to [0, 1]. Heuristic rank, not calibrated against external benchmarks. Operator threshold via `clusters.minConfidence`. null when structurally forced by insufficient evidence — an edge-less or inbound-only cluster (Fathom row 5.4.0.1, honest-null contract); a forced 1.0 there would be indistinguishable from genuine full cohesion.",
    },
    dependsOn: {
      type: "array",
      title: "Cluster-to-cluster aggregate dependencies",
      description:
        "Per-target aggregate counts of element-level dependency edges that cross cluster boundaries. Each entry: `{ targetClusterId: string, rawEdgeCount: number, weightedEdgeCount: number }`. Fathom 5.0.28 (d) split: `rawEdgeCount` is integer count of distinct contributing edges; `weightedEdgeCount` is the sum of per-edge weights (fractional when edge-type weighting is in play per row 5.0.14).",
    },
  },
};

/**
 * Indexes for the `cluster` domain. The substrate scopes each by
 * domain at translation time so they don't collide with overlay
 * indexes from other domains.
 */
export const CLUSTER_INDEXES: IndexSpec[] = [
  {
    name: "clusters_by_clusterId",
    fields: ["metadata.clusterId"],
    scope: {
      domain: CLUSTER_DOMAIN,
      lifecycleState: "live",
      nonNull: ["metadata.clusterId"],
    },
    unique: true,
  },
  {
    name: "clusters_by_language",
    fields: ["metadata.language"],
    scope: {
      domain: CLUSTER_DOMAIN,
      lifecycleState: "live",
      nonNull: ["metadata.language"],
    },
  },
  // Fathom row 5.0.31: enrichment-preservation lookup index. Used by
  // `insertCluster` to find the prior live cluster (if any) with the
  // same canonical member set, so its `llmEnrichment` can lift forward
  // onto the new cluster. NOT unique — Louvain re-emissions may
  // briefly have two clusters with the same canonical member set live
  // before the tombstone-stale pass clears the old one.
  {
    name: "clusters_by_canonicalMemberSetHash",
    fields: ["metadata.canonicalMemberSetHash"],
    scope: {
      domain: CLUSTER_DOMAIN,
      lifecycleState: "live",
      nonNull: ["metadata.canonicalMemberSetHash"],
    },
  },
];
