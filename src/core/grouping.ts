import type { AtlasIR } from './ir.ts';
import { clusterExecutors } from './cluster.ts';

/**
 * How the orientation view carves a codebase into regions (DESIGN.md §9.2).
 *
 * `crate` follows the module tree; `cluster` derives regions from shared state. Grouping is
 * separate from layout: `src/layout/scene.ts` decides where regions go, this decides what
 * they contain.
 */

/**
 * Path segments carrying no architectural meaning. `crates/movement/src/x.rs` groups as
 * `movement`, not `crates` — which is what a naive first-segment rule produced, filing an
 * entire ten-crate workspace under one region.
 */
const STRUCTURAL_SEGMENTS = new Set(['crates', 'src', 'lib', 'source', 'packages', 'apps']);

/** The region a node belongs to: its first meaningful module segment. */
export function groupOf(modulePath: string): string {
  const segments = modulePath.split('::');
  for (const segment of segments) {
    if (!STRUCTURAL_SEGMENTS.has(segment)) return segment;
  }
  return segments[0] ?? modulePath;
}

export type GroupMode = 'crate' | 'cluster';

/**
 * A cluster is named after its most common module, so a region carries some meaning rather
 * than an opaque id. Deterministic: the seed id breaks ties.
 */
function clusterLabel(clusterId: string, ir: AtlasIR): string {
  const executorIds = new Set(ir.executors.map((e) => e.id));
  if (!executorIds.has(clusterId)) return clusterId;
  return `${groupOf(clusterId)}~${clusterId.split('::').pop() ?? clusterId}`;
}

/**
 * Assigns every executor to a region, and state to a region when exactly one touches it.
 *
 * State shared between regions deliberately stays unassigned: it is a bridge, and that
 * cross-cutting structure is what the orientation view exists to show.
 */
export function assignGroups(ir: AtlasIR, mode: GroupMode = 'crate'): Map<string, string> {
  const assignment = new Map<string, string>();

  if (mode === 'cluster') {
    const { assignment: clustered } = clusterExecutors(ir);
    for (const executor of ir.executors) {
      // An executor that clustered with nothing keeps its module as a fallback region,
      // rather than vanishing from a view meant to show the whole codebase.
      const cluster = clustered.get(executor.id);
      assignment.set(executor.id, cluster === undefined ? groupOf(executor.id) : clusterLabel(cluster, ir));
    }
  } else {
    for (const executor of ir.executors) assignment.set(executor.id, groupOf(executor.id));
  }

  const touchedBy = new Map<string, Set<string>>();
  for (const access of ir.accesses) {
    const group = assignment.get(access.executorId);
    if (group === undefined) continue;
    const set = touchedBy.get(access.stateId);
    if (set) set.add(group);
    else touchedBy.set(access.stateId, new Set([group]));
  }
  for (const [stateId, groups] of touchedBy) {
    if (groups.size === 1) assignment.set(stateId, [...groups][0]!);
  }
  return assignment;
}
