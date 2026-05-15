/**
 * TF-IDF cluster naming over identifier vocabulary. Given the
 * identifier names of cluster members (plus, optionally, the
 * identifier names of all other clusters' members as the background
 * corpus), pick the 1-3 distinguishing terms and join them with '-'
 * after a `cluster-` prefix.
 *
 * Example: a cluster whose members are `OrchestratorRunner`,
 * `SubprocessSpawner`, `SubprocessReader` against a workspace
 * background of varied identifiers might be named
 * `cluster-subprocess-orchestrator`.
 *
 * Heuristic only — names are advisory; operator-supplied `displayName`
 * always takes precedence in renders.
 */

/** Split a camelCase / PascalCase / snake_case identifier into lower-case terms. */
export function splitIdentifier(identifier: string): string[] {
  // Insert a separator before every uppercase letter that follows a
  // lowercase or digit; also between consecutive uppercase + lowercase
  // (e.g., "HTTPSession" -> "HTTP Session").
  const split = identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .toLowerCase()
    .trim();
  return split.split(/\s+/).filter((t) => t.length > 1);
}

/** Tokens that almost never carry distinguishing semantic content. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "from", "into", "out",
  "get", "set", "is", "has", "can", "should",
  "to", "of", "by", "on", "at",
  "new", "old",
  "value", "name", "type", "kind", "data", "info",
  "object", "instance", "item", "list", "set", "map",
  "result", "input", "output", "args", "options",
  "func", "function", "method", "class", "interface",
  "impl", "default",
]);

/**
 * Term-frequency map for a single document (cluster). Tokens are
 * lower-cased identifier parts; stopwords + length-1 are dropped.
 */
function termFrequency(identifiers: Iterable<string>): Map<string, number> {
  const tf = new Map<string, number>();
  for (const id of identifiers) {
    for (const term of splitIdentifier(id)) {
      if (STOPWORDS.has(term)) continue;
      tf.set(term, (tf.get(term) ?? 0) + 1);
    }
  }
  return tf;
}

/**
 * TF-IDF score for one cluster against a background corpus. The
 * background may be empty — in which case the score reduces to
 * frequency, and the top-N terms are simply the most common.
 *
 * IDF formula: `log((1 + N) / (1 + df))` where N = total clusters in
 * the corpus and df = number of clusters the term appears in. The
 * +1 smoothing prevents division-by-zero and rare-term explosion.
 */
function scoreTerms(
  tf: Map<string, number>,
  documentFrequency: Map<string, number>,
  totalDocuments: number,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const [term, count] of tf) {
    const df = documentFrequency.get(term) ?? 0;
    const idf = Math.log((1 + totalDocuments) / (1 + df));
    scores.set(term, count * idf);
  }
  return scores;
}

/**
 * Pick the top-N terms from a score map, ordered by descending score
 * with alphabetical tie-break. Returns at most `n` terms; may return
 * fewer when the cluster has no distinguishing vocabulary.
 */
function topN(scores: Map<string, number>, n: number): string[] {
  return [...scores.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, n)
    .map(([term]) => term);
}

/**
 * Name a single cluster from its member identifiers, without a
 * background corpus. Useful when there's only one cluster, or as a
 * stand-alone helper.
 */
export function nameClusterFromIdentifiers(
  identifiers: Iterable<string>,
  options: { maxTerms?: number } = {},
): string {
  const max = options.maxTerms ?? 3;
  const tf = termFrequency(identifiers);
  // No corpus → all-1 idf; score reduces to frequency.
  const topTerms = topN(tf, max);
  return topTerms.length === 0
    ? "cluster-unnamed"
    : `cluster-${topTerms.join("-")}`;
}

/**
 * Name each cluster in a batch, using the rest of the batch as the
 * background corpus so distinguishing terms surface. Returns a map
 * from cluster ordinal (index in the input array) to the chosen name.
 *
 * Use this when computing cluster names for a whole workspace — it
 * gives cleaner names than calling `nameClusterFromIdentifiers` per
 * cluster, because terms shared by many clusters get down-weighted.
 */
export function nameClustersTfIdf(
  clusters: ReadonlyArray<{ identifiers: readonly string[] }>,
  options: { maxTerms?: number } = {},
): string[] {
  const max = options.maxTerms ?? 3;
  const tfs = clusters.map((c) => termFrequency(c.identifiers));
  const documentFrequency = new Map<string, number>();
  for (const tf of tfs) {
    for (const term of tf.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  return tfs.map((tf) => {
    const scores = scoreTerms(tf, documentFrequency, tfs.length);
    const topTerms = topN(scores, max);
    return topTerms.length === 0
      ? "cluster-unnamed"
      : `cluster-${topTerms.join("-")}`;
  });
}
