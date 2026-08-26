import type { AtlasIR } from './ir.ts';

/**
 * Deterministic subsystem clustering.
 *
 * Groups executors that traffic in the same state. Where the module tree tells you how code
 * is *filed*, this tells you how it actually *couples* — and the interesting output is the
 * disagreement between the two.
 *
 * Determinism matters more than cluster quality here: a grouping that shifts between runs
 * cannot be reasoned about or diffed. Label propagation is run over a sorted node order
 * with lowest-label tie-breaking, so the same IR always yields the same clusters.
 */

export interface ClusterOptions {
  /**
   * State touched by at least this fraction of executors is treated as ubiquitous and
   * excluded from the similarity graph. Hubs connect everything to everything, so leaving
   * them in produces one giant cluster that means nothing.
   */
  hubFraction?: number;
  maxPasses?: number;
}

export interface ClusterResult {
  /** Executor id -> cluster id. Executors that clustered with nothing are absent. */
  assignment: Map<string, string>;
  /** Cluster id -> member executor ids, sorted. */
  clusters: Map<string, string[]>;
  /** State excluded as ubiquitous, for reporting. */
  hubs: string[];
}

export function clusterExecutors(ir: AtlasIR, options: ClusterOptions = {}): ClusterResult {
  const hubFraction = options.hubFraction ?? 0.05;
  const executorIds = ir.executors.map((e) => e.id).sort();
  const cutoff = Math.max(8, Math.ceil(executorIds.length * hubFraction));

  const touching = new Map<string, Set<string>>();
  for (const access of ir.accesses) {
    const set = touching.get(access.stateId);
    if (set) set.add(access.executorId);
    else touching.set(access.stateId, new Set([access.executorId]));
  }

  const hubs: string[] = [];
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (a === b) return;
    const set = adjacency.get(a);
    if (set) set.add(b);
    else adjacency.set(a, new Set([b]));
  };

  for (const [stateId, executors] of [...touching].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (executors.size >= cutoff) {
      hubs.push(stateId);
      continue;
    }
    const members = [...executors].sort();
    for (const a of members) for (const b of members) link(a, b);
  }

  const label = new Map(executorIds.map((id) => [id, id]));
  const passes = options.maxPasses ?? 20;
  for (let pass = 0; pass < passes; pass++) {
    let changed = 0;
    for (const id of executorIds) {
      const neighbours = adjacency.get(id);
      if (!neighbours || neighbours.size === 0) continue;

      const counts = new Map<string, number>();
      for (const neighbour of neighbours) {
        const value = label.get(neighbour);
        if (value !== undefined) counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      // Most common label wins; ties break on the lexicographically smallest, so the
      // result never depends on Map iteration order.
      const best = [...counts.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0];
      if (best && best[0] !== label.get(id)) {
        label.set(id, best[0]);
        changed++;
      }
    }
    if (changed === 0) break;
  }

  const clusters = new Map<string, string[]>();
  for (const id of executorIds) {
    if (!adjacency.has(id)) continue; // clustered with nothing
    const value = label.get(id)!;
    const list = clusters.get(value);
    if (list) list.push(id);
    else clusters.set(value, [id]);
  }

  const assignment = new Map<string, string>();
  for (const [value, members] of clusters) {
    if (members.length < 2) {
      clusters.delete(value);
      continue;
    }
    members.sort();
    for (const id of members) assignment.set(id, value);
  }

  return { assignment, clusters, hubs: hubs.sort() };
}

/**
 * Where clustering disagrees with the module tree.
 *
 * This is the part worth reading. "These 39 functions form one cluster spread across three
 * crates" is a finding; "the orchestrator crate appears everywhere" is not, which is why
 * single-crate clusters are dropped from the report.
 */
export interface Mismatch {
  cluster: string;
  size: number;
  spread: Array<{ group: string; count: number }>;
}

export function crossGroupClusters(
  result: ClusterResult,
  groupOfExecutor: (id: string) => string,
): Mismatch[] {
  const out: Mismatch[] = [];
  for (const [cluster, members] of result.clusters) {
    const counts = new Map<string, number>();
    for (const id of members) {
      const group = groupOfExecutor(id);
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    if (counts.size < 2) continue;
    out.push({
      cluster,
      size: members.length,
      spread: [...counts]
        .map(([group, count]) => ({ group, count }))
        .sort((a, b) => b.count - a.count || (a.group < b.group ? -1 : 1)),
    });
  }
  return out.sort((a, b) => b.size - a.size || (a.cluster < b.cluster ? -1 : 1));
}
