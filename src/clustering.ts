/**
 * Louvain community detection over an L0 element-dependency graph,
 * producing recovered clusters with content-hash identity + TF-IDF
 * naming. Deterministic — same input + same seed = same output.
 *
 * The algorithm is from Blondel et al. 2008, with the graphology
 * implementation. Inputs are folded to an undirected graph by
 * summing edge weights across both directions (so a unidirectional
 * dependency `A -> B` and a bidirectional pair `A <-> B` differ).
 */

import { createRequire } from "node:module";
import type { AbstractGraph } from "graphology-types";
import type { LouvainOptions } from "graphology-communities-louvain";

/**
 * `graphology` and `graphology-communities-louvain` are CJS-only
 * modules (the `.d.ts` files name `export default` for both, but at
 * runtime each is a single `module.exports = ...`). NodeNext's ESM
 * resolver cannot reach the callable / constructable value via a
 * normal `import default from ...` — the type-checker sees a
 * namespace. `createRequire` gives us the actual runtime values;
 * types come from `graphology-types` (the underlying abstract
 * interface) so the rest of the file stays well-typed.
 */
const requireFromHere = createRequire(import.meta.url);
type GraphInstance = AbstractGraph;
type GraphCtor = new (options?: {
  type?: "directed" | "undirected" | "mixed";
  multi?: boolean;
  allowSelfLoops?: boolean;
}) => GraphInstance;
const Graph = requireFromHere("graphology") as GraphCtor;
const louvain = requireFromHere("graphology-communities-louvain") as (
  graph: GraphInstance,
  options?: LouvainOptions,
) => Record<string, number>;
import { computeClusterId } from "./identity.js";
import { nameClustersTfIdf } from "./naming.js";
import type { ClusterDependency } from "./types.js";

/**
 * One L0 element participating in clustering. `id` is the substrate
 * node id (UUID or natural key — caller's choice; must be unique within
 * the input set). `name` is the identifier for naming purposes
 * (typically the element's local name, e.g., `OrchestratorRunner`).
 * `contentHash` feeds cluster-identity computation; matched against
 * the analyzer's `contentHash` for the element.
 */
export interface ElementInput {
  id: string;
  /**
   * Stable identity for cluster-id computation; defaults to `id`.
   * Pass the element's substrate naturalKey when `id` is a transient
   * UUID — keeps clusterIds stable across clean rebuilds while still
   * distinguishing content-identical members (Fathom row 5.0.48.2).
   */
  identityKey?: string;
  name: string;
  contentHash: string;
  /**
   * Optional language tag. When all members of a cluster share the
   * same language the cluster records it; mixed-language clusters
   * are left untagged (cross-language clustering is not produced in
   * v1 in any case — see Fathom Trade-off list).
   */
  language?: string;
  /**
   * Every non-administrative L0 facet the substrate carries for this
   * element (annotations, baseTypes, isStatic, scalars, ...), projected
   * by the caller's shared `projectElementFacets` helper (Fathom row
   * `overlay-projection-discards-14-of-19-facets`, 3.1.0.7). Plain
   * `Record<string, unknown>` rather than an imported type — this
   * package has no peer-dependency on `@kepello/nodegraph-analysis`
   * (same decoupling rationale as every other plain-data field on this
   * interface). Currently unconsumed by `computeClusters` — this row
   * makes the facts ARRIVE; wiring a consumer is later work. Optional:
   * making it required would force editing every hand-built `ElementInput`
   * literal across this package's test suite for a field nothing reads
   * yet (unlike `nodegraph-patterns`' `overridesByTarget`, which went
   * required at a ≤2-touchpoint cost, this field's touchpoint count runs
   * into the dozens — see the CHANGELOG entry for this version).
   */
  facets?: Readonly<Record<string, unknown>>;
}

/**
 * One directed dependency edge between two L0 elements. Cross-cluster
 * boundaries are detected automatically; intra-cluster edges
 * contribute to the Louvain modularity score but don't produce
 * output `dependsOn` entries.
 */
export interface DependencyInput {
  source: string;
  target: string;
  /** Weight for Louvain modularity. Defaults to 1 when omitted. */
  weight?: number;
}

/**
 * Clustering result. `assignments` maps every input element's id to
 * its assigned `clusterId`; `clusters` lists the unique clusters
 * with full metadata (name, dependsOn, member ids).
 */
export interface ClusteringResult {
  clusters: ComputedCluster[];
  assignments: Map<string, string>;
}

export interface ComputedCluster {
  clusterId: string;
  name: string;
  language?: string;
  memberElementIds: string[];
  memberCount: number;
  /** Cluster's content hash (the input to `computeClusterId`). */
  contentHash: string;
  /**
   * Confidence ∈ [0, 1] — share of the cluster's edges that stay
   * intra-cluster. High values indicate cohesive clusters; values
   * near 0 mean the cluster mostly talks to outside.
   *
   * Honest-null contract (Fathom row
   * `l3-confidence-honest-null-for-edgeless-clusters` 5.4.0.1, mirrors
   * `nodegraph-analysis/src/engine/derivations/cohesion.ts`'s
   * `methodPairCohesion` null-on-insufficient-input shape): `null` when
   * the ratio would be structurally forced by insufficient
   * evidence — an edge-less cluster OR an inbound-only cluster (the
   * denominator only tallies SOURCE-side edges, so a cluster that only
   * ever appears as a dependency `target` also has zero counted
   * edges). A forced 1.0 in that case is indistinguishable from
   * genuine full cohesion — measured at 88% of live clusters sitting
   * at exactly 1.0 before this fix. Real ratio, unchanged, whenever
   * the cluster has at least one counted (source-side) edge.
   */
  confidenceScore: number | null;
  dependsOn: ClusterDependency[];
}

export interface ComputeClustersOptions {
  /**
   * Seed for the deterministic Mulberry32 RNG passed to Louvain.
   * Same seed = same clustering on the same graph. Defaults to
   * a stable value (0x9e3779b1) so consumers get reproducible
   * results without specifying.
   */
  seed?: number;
  /**
   * Louvain resolution parameter. >1 favors smaller clusters; <1
   * favors larger. Defaults to 1.0 (standard modularity).
   */
  resolution?: number;
}

/**
 * Mulberry32 — small fast deterministic 32-bit PRNG. Returns a
 * function that yields uniform [0, 1) on each call. Single seed in,
 * stateful out — same seed = same sequence forever.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Compute recovered clusters from an L0 element-dependency graph.
 * Pure function — no side effects, no graph-substrate IO. Callers
 * insert the result into the cluster overlay separately via
 * `ClusterOverlay.insertCluster`.
 */
export function computeClusters(
  input: {
    elements: ReadonlyArray<ElementInput>;
    dependencies: ReadonlyArray<DependencyInput>;
  },
  options: ComputeClustersOptions = {},
): ClusteringResult {
  const seed = options.seed ?? 0x9e3779b1;
  const resolution = options.resolution ?? 1.0;

  // Build an undirected weighted graphology graph. Sum both directions
  // when the dependency set has edges in both — this folds asymmetric
  // dependencies into a single undirected weight for modularity.
  // Sort inputs before constructing the graphology graph. Louvain's
  // output can shift on a graph with ambiguous community structure
  // when nodes or edges are inserted in different orders, even with a
  // seeded RNG — the algorithm walks nodes in insertion order during
  // community-merge iteration. The caller's input ordering is
  // non-deterministic in the typical case (e.g., SQLite `queryNodes`
  // without `ORDER BY`), so we canonicalize here. Closes Fathom row
  // 5.0.7.
  //
  // Sort by the REBUILD-STABLE key (identityKey ?? id), not by raw id
  // (L3-TS baseline M4, 2026-06-09): ids are typically substrate UUIDs
  // that differ between clean rebuilds of identical source, so an
  // id-keyed canonical order is a fresh shuffle per rebuild — measured
  // as 25/115 cluster-composition flips across two clean rebuilds of
  // the unchanged Fathom workspace. identityKey (the element
  // naturalKey) survives rebuilds, making the walk order — and
  // therefore the partition — reproducible. Tie-break by id so inputs
  // with duplicate identityKeys still get a total order.
  const stableKey = new Map<string, string>();
  for (const el of input.elements) {
    stableKey.set(el.id, el.identityKey ?? el.id);
  }
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const sortedElements = [...input.elements].sort(
    (a, b) =>
      cmp(a.identityKey ?? a.id, b.identityKey ?? b.id) || cmp(a.id, b.id),
  );
  const sortedDependencies = [...input.dependencies].sort((a, b) => {
    const bySource = cmp(stableKey.get(a.source) ?? a.source, stableKey.get(b.source) ?? b.source);
    if (bySource !== 0) return bySource;
    const byTarget = cmp(stableKey.get(a.target) ?? a.target, stableKey.get(b.target) ?? b.target);
    if (byTarget !== 0) return byTarget;
    return cmp(a.source, b.source) || cmp(a.target, b.target);
  });

  const graph = new Graph({ type: "undirected", multi: false });
  for (const el of sortedElements) {
    graph.addNode(el.id);
  }
  const edgeWeight = new Map<string, number>(); // canonical key -> weight
  for (const dep of sortedDependencies) {
    if (dep.source === dep.target) continue; // ignore self-loops
    if (!graph.hasNode(dep.source) || !graph.hasNode(dep.target)) continue;
    const [a, b] = dep.source < dep.target
      ? [dep.source, dep.target]
      : [dep.target, dep.source];
    const key = `${a}\u0000${b}`;
    const w = dep.weight ?? 1;
    edgeWeight.set(key, (edgeWeight.get(key) ?? 0) + w);
  }
  for (const [key, weight] of edgeWeight) {
    const [a, b] = key.split("\u0000");
    graph.addEdge(a, b, { weight });
  }

  // Run Louvain with a deterministic seeded RNG. The library reads
  // node order during community-merge iteration; with the same input
  // order + same RNG it produces identical assignments.
  const rng = mulberry32(seed);
  const assignments = louvain(graph, {
    resolution,
    randomWalk: false,
    rng,
    getEdgeWeight: "weight",
  }) as Record<string, number>;

  // Group elements by community number.
  const byCommunity = new Map<number, ElementInput[]>();
  for (const el of sortedElements) {
    const community = assignments[el.id] ?? 0;
    let bucket = byCommunity.get(community);
    if (bucket === undefined) {
      bucket = [];
      byCommunity.set(community, bucket);
    }
    bucket.push(el);
  }

  // Compute deterministic cluster output. Sort by community number
  // first so cluster order is stable across runs with the same input.
  const orderedCommunities = [...byCommunity.entries()].sort(
    (a, b) => a[0] - b[0],
  );
  const computedClusters: ComputedCluster[] = orderedCommunities.map(
    ([, members]) => {
      const sortedHashes = members
        .map((m) => m.contentHash)
        .sort();
      const contentHash = sortedHashes.join("\n");
      // Identity from member identityKey + contentHash pairs (Fathom
      // row 5.0.48.2) — content-only identity collided across disjoint
      // communities with identical content multisets.
      const clusterId = computeClusterId(
        members.map((m) => ({
          identityKey: m.identityKey ?? m.id,
          contentHash: m.contentHash,
        })),
      );
      const language = uniformOrUndefined(members.map((m) => m.language));
      return {
        clusterId,
        name: "", // filled in below after batch TF-IDF
        language,
        memberElementIds: members.map((m) => m.id).sort(),
        memberCount: members.length,
        contentHash,
        confidenceScore: 0, // filled in below
        dependsOn: [], // filled in below
      };
    },
  );

  // Batch TF-IDF naming across all clusters so distinguishing terms
  // surface (vs naming per-cluster in isolation).
  const namingInputs = orderedCommunities.map(([, members]) => ({
    identifiers: members.map((m) => m.name),
  }));
  const names = nameClustersTfIdf(namingInputs);
  computedClusters.forEach((c, i) => {
    c.name = names[i];
  });

  // Forcing function (5.0.48.2): communities are disjoint, so duplicate
  // clusterIds can only mean duplicate (identityKey, contentHash) pairs
  // across the input — a caller contract violation that would silently
  // merge clusters in the maps below and collapse nodes at persist
  // time. Fail loud instead.
  const seenClusterIds = new Set<string>();
  for (const c of computedClusters) {
    if (seenClusterIds.has(c.clusterId)) {
      throw new Error(
        `computeClusters: duplicate clusterId ${c.clusterId} across ` +
          `distinct communities — member identityKeys must be unique ` +
          `within the input set`,
      );
    }
    seenClusterIds.add(c.clusterId);
  }

  // Compute dependsOn aggregations + confidence scores from the
  // element-level dependency edges.
  const elementToCluster = new Map<string, string>();
  computedClusters.forEach((c) => {
    for (const memberId of c.memberElementIds) {
      elementToCluster.set(memberId, c.clusterId);
    }
  });
  const clusterById = new Map(computedClusters.map((c) => [c.clusterId, c]));

  // Tally inter-cluster edges per (sourceClusterId, targetClusterId).
  // Fathom row 5.0.28 (d): track raw count AND weighted sum separately
  // so consumers can distinguish "number of edges crossing the
  // boundary" from "sum of per-edge weights." The two diverge once
  // edge-type weighting (row 5.0.14) is in play.
  const rawEdgeCounts = new Map<string, Map<string, number>>();
  const weightedEdgeCounts = new Map<string, Map<string, number>>();
  const totalEdgesPerCluster = new Map<string, number>();
  const intraEdgesPerCluster = new Map<string, number>();
  for (const dep of sortedDependencies) {
    const srcCluster = elementToCluster.get(dep.source);
    const tgtCluster = elementToCluster.get(dep.target);
    if (srcCluster === undefined || tgtCluster === undefined) continue;
    if (dep.source === dep.target) continue;
    const weight = dep.weight ?? 1;
    totalEdgesPerCluster.set(
      srcCluster,
      (totalEdgesPerCluster.get(srcCluster) ?? 0) + weight,
    );
    if (srcCluster === tgtCluster) {
      intraEdgesPerCluster.set(
        srcCluster,
        (intraEdgesPerCluster.get(srcCluster) ?? 0) + weight,
      );
      continue;
    }
    let perTargetRaw = rawEdgeCounts.get(srcCluster);
    if (perTargetRaw === undefined) {
      perTargetRaw = new Map();
      rawEdgeCounts.set(srcCluster, perTargetRaw);
    }
    perTargetRaw.set(tgtCluster, (perTargetRaw.get(tgtCluster) ?? 0) + 1);
    let perTargetWeighted = weightedEdgeCounts.get(srcCluster);
    if (perTargetWeighted === undefined) {
      perTargetWeighted = new Map();
      weightedEdgeCounts.set(srcCluster, perTargetWeighted);
    }
    perTargetWeighted.set(
      tgtCluster,
      (perTargetWeighted.get(tgtCluster) ?? 0) + weight,
    );
  }
  for (const [clusterId, perTargetRaw] of rawEdgeCounts) {
    const cluster = clusterById.get(clusterId);
    if (cluster === undefined) continue;
    const perTargetWeighted = weightedEdgeCounts.get(clusterId);
    cluster.dependsOn = [...perTargetRaw.entries()]
      .map(([targetClusterId, rawEdgeCount]) => ({
        targetClusterId,
        rawEdgeCount,
        weightedEdgeCount: perTargetWeighted?.get(targetClusterId) ?? rawEdgeCount,
      }))
      .sort((a, b) => a.targetClusterId.localeCompare(b.targetClusterId));
  }
  for (const cluster of computedClusters) {
    const total = totalEdgesPerCluster.get(cluster.clusterId) ?? 0;
    const intra = intraEdgesPerCluster.get(cluster.clusterId) ?? 0;
    // Honest-null contract (5.4.0.1): total === 0 means no counted
    // (source-side) edges — edge-less OR inbound-only — so the ratio
    // is structurally undefined, not a forced max. See ComputedCluster
    // .confidenceScore's doc comment for the full rationale.
    cluster.confidenceScore = total === 0 ? null : intra / total;
  }

  // Final assignment map: element-id -> cluster-id. Iterate the
  // sorted element list so the Map's insertion order is deterministic.
  const flatAssignments = new Map<string, string>();
  for (const el of sortedElements) {
    const clusterId = elementToCluster.get(el.id);
    if (clusterId !== undefined) flatAssignments.set(el.id, clusterId);
  }

  return { clusters: computedClusters, assignments: flatAssignments };
}

/**
 * If all values in the iterable are the same (and non-undefined),
 * return that value. Otherwise return undefined. Used to determine
 * whether a cluster is uniformly single-language.
 */
function uniformOrUndefined<T>(
  values: Iterable<T | undefined>,
): T | undefined {
  let seen: T | undefined;
  let hasSeen = false;
  for (const v of values) {
    if (v === undefined) continue;
    if (!hasSeen) {
      seen = v;
      hasSeen = true;
      continue;
    }
    if (seen !== v) return undefined;
  }
  return hasSeen ? seen : undefined;
}
