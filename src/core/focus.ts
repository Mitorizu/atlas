import type { AtlasIR, Access, ExecutorNode, StateNode } from './ir.ts';
import type { GraphDelta } from './delta.ts';
import type { Ambiguity } from '../analysis/ambiguity.ts';

/** How an element relates to the change under review (DESIGN.md §9.1). */
export type DiffRole = 'added' | 'removed' | 'modified' | 'moved' | 'context';

export interface FocusMeta {
  role: DiffRole;
  /** True for elements the change touched directly, rather than pulled in by expansion. */
  seed: boolean;
  /** Hops from the nearest seed; 0 for seeds themselves. */
  distance: number;
  /** Involved in an ambiguity this change introduced. */
  conflicted: boolean;
}

export interface FocusResult {
  /** Head IR plus the removed elements from base, so deletions stay visible as ghosts. */
  ir: AtlasIR;
  meta: Record<string, FocusMeta>;
  seeds: string[];
  introduced: Ambiguity[];
  /** Everything in the merged graph before the hop limit was applied. */
  totalExecutors: number;
}

export interface FocusOptions {
  /** How far to expand from the change. Two hops reaches "who else touches what I touched". */
  hops?: number;
}

/**
 * Merges head with the elements base had and head does not, so a deletion is something
 * you can see rather than an absence you have to notice.
 */
function mergeForReview(base: AtlasIR, head: AtlasIR, delta: GraphDelta): AtlasIR {
  const removedExecutors = new Set(delta.executors.removed);
  const baseById = new Map(base.executors.map((e) => [e.id, e]));
  const executors: ExecutorNode[] = [
    ...head.executors,
    ...[...removedExecutors].map((id) => baseById.get(id)).filter((e): e is ExecutorNode => e !== undefined),
  ];

  const stateIds = new Set(head.states.map((s) => s.id));
  const states: StateNode[] = [...head.states];
  for (const state of base.states) {
    if (!stateIds.has(state.id)) states.push(state);
  }

  const accesses: Access[] = [
    ...head.accesses,
    ...base.accesses.filter((a) => removedExecutors.has(a.executorId)),
  ];

  return { dialect: head.dialect, executors, states, accesses, setOrderings: head.setOrderings };
}

function rolesFrom(delta: GraphDelta): Map<string, DiffRole> {
  const roles = new Map<string, DiffRole>();
  for (const id of delta.executors.added) roles.set(id, 'added');
  for (const id of delta.executors.removed) roles.set(id, 'removed');
  for (const id of delta.executors.modified) roles.set(id, 'modified');
  for (const move of delta.executors.moved) {
    roles.set(move.to, 'moved');
    roles.set(move.from, 'moved');
  }
  return roles;
}

/**
 * Seed-and-expand focus subgraph (DESIGN.md §4.1).
 *
 * Seeds are what the change touched: executors added, removed, modified or moved, state
 * whose access changed, and both ends of every ambiguity the change introduced. Expansion
 * then walks the bipartite access graph outward a bounded number of hops, which is what
 * turns "here is your diff" into "here is who else cares".
 *
 * The result is tens of nodes rather than thousands — that is the whole point, and why
 * this is the primary view rather than the whole-codebase map.
 */
export function buildFocus(
  base: AtlasIR,
  head: AtlasIR,
  delta: GraphDelta,
  options: FocusOptions = {},
): FocusResult {
  const hops = options.hops ?? 2;
  const merged = mergeForReview(base, head, delta);
  const roles = rolesFrom(delta);

  const executorIds = new Set(merged.executors.map((e) => e.id));
  const conflicted = new Set<string>();
  for (const found of delta.ambiguities.introduced) {
    conflicted.add(found.a);
    conflicted.add(found.b);
  }

  const seeds = new Set<string>();
  for (const id of roles.keys()) if (executorIds.has(id)) seeds.add(id);
  for (const id of conflicted) if (executorIds.has(id)) seeds.add(id);
  for (const access of [...delta.accesses.added, ...delta.accesses.removed]) seeds.add(access.stateId);
  for (const change of delta.accesses.modeChanged) seeds.add(change.stateId);
  for (const id of [...delta.states.added, ...delta.states.removed]) seeds.add(id);

  // Bipartite adjacency: executor <-> state, both directions.
  const neighbours = new Map<string, Set<string>>();
  const connect = (a: string, b: string): void => {
    const forward = neighbours.get(a);
    if (forward) forward.add(b);
    else neighbours.set(a, new Set([b]));
  };
  for (const access of merged.accesses) {
    connect(access.executorId, access.stateId);
    connect(access.stateId, access.executorId);
  }

  /**
   * Expansion is scope-aware (§7.3).
   *
   * Hubs are where everything meets: `Transform` has 154 consumers, so expanding through it
   * naively pulled 418 nodes into a review of an 8-line change. But those consumers live in
   * 400 different apps and can never interact — only systems sharing an app scope can. So
   * the graph is filtered to the scopes the change actually touches, which keeps the hub
   * traversable (you still see who else cares) without dragging in unrelated apps.
   */
  const executorById = new Map(merged.executors.map((e) => [e.id, e]));
  const seedScopes = new Set<string>();
  for (const id of seeds) {
    for (const scope of executorById.get(id)?.appScopes ?? []) seedScopes.add(scope);
  }
  const inScope = (id: string): boolean => {
    const executor = executorById.get(id);
    if (!executor) return true; // state nodes are not scoped
    if (seedScopes.size === 0) return true; // nothing to filter against
    // An executor with no resolvable scope cannot be shown to co-run with the change, so
    // it is not pulled in by expansion. Seeds are added before this filter and survive.
    return executor.appScopes.some((scope) => seedScopes.has(scope));
  };

  const distance = new Map<string, number>();
  let frontier = [...seeds].filter((id) => executorIds.has(id) || neighbours.has(id));
  for (const id of frontier) distance.set(id, 0);

  for (let hop = 1; hop <= hops; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbour of neighbours.get(id) ?? []) {
        if (distance.has(neighbour) || !inScope(neighbour)) continue;
        distance.set(neighbour, hop);
        next.push(neighbour);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  const included = new Set(distance.keys());
  const ir: AtlasIR = {
    dialect: merged.dialect,
    executors: merged.executors.filter((e) => included.has(e.id)),
    states: merged.states.filter((s) => included.has(s.id)),
    accesses: merged.accesses.filter((a) => included.has(a.executorId) && included.has(a.stateId)),
    setOrderings: merged.setOrderings,
  };

  const meta: Record<string, FocusMeta> = {};
  for (const id of included) {
    meta[id] = {
      role: roles.get(id) ?? 'context',
      seed: seeds.has(id),
      distance: distance.get(id) ?? 0,
      conflicted: conflicted.has(id),
    };
  }

  return {
    ir,
    meta,
    seeds: [...seeds].filter((id) => included.has(id)),
    introduced: delta.ambiguities.introduced,
    totalExecutors: merged.executors.length,
  };
}

/**
 * Blast radius for the Inspector (§9.1): who writes this, who reads it, in depth rings.
 *
 * Breadth-first with a visited set and a depth cap because the graph is cyclic — every
 * `&mut T` system forms a 2-cycle with its state (§7.5) — and an executor's own self-cycle
 * is excluded from its own upstream list.
 */
export function blastRadius(ir: AtlasIR, rootId: string, maxDepth = 2): Array<{ depth: number; ids: string[] }> {
  const neighbours = new Map<string, Set<string>>();
  const connect = (a: string, b: string): void => {
    const set = neighbours.get(a);
    if (set) set.add(b);
    else neighbours.set(a, new Set([b]));
  };
  for (const access of ir.accesses) {
    connect(access.executorId, access.stateId);
    connect(access.stateId, access.executorId);
  }

  const seen = new Set([rootId]);
  const rings: Array<{ depth: number; ids: string[] }> = [];
  let frontier = [rootId];

  for (let depth = 1; depth <= maxDepth; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbour of neighbours.get(id) ?? []) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        next.push(neighbour);
      }
    }
    if (next.length === 0) break;
    rings.push({ depth, ids: next.sort() });
    frontier = next;
  }
  return rings;
}
