/**
 * Public API surface for `@kepello/nodegraph-clusters`.
 */

// Schema
export {
  CLUSTER_DOMAIN,
  CLUSTER_INDEXES,
  CLUSTER_METADATA_KIND,
  CLUSTER_METADATA_SCHEMA,
  CLUSTER_SCHEMA_VERSION,
} from "./schema.js";

// Types
export type {
  ClusterDependency,
  ClusterInput,
  ClusterMetadata,
  ClusterNode,
  ClusterOverlay,
} from "./types.js";

// Identity
export { computeClusterId } from "./identity.js";

// Naming
export {
  nameClusterFromIdentifiers,
  nameClustersTfIdf,
  splitIdentifier,
} from "./naming.js";

// Clustering algorithm
export {
  computeClusters,
  type ClusteringResult,
  type ComputedCluster,
  type ComputeClustersOptions,
  type DependencyInput,
  type ElementInput,
} from "./clustering.js";

// Overlay
export {
  ClusterOverlayImpl,
  makeClusterOverlay,
} from "./overlay.js";
