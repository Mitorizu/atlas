import { STRUCTURAL_STATE_ID, type Access, type AtlasIR, type ExecutorNode, type FilterExpr } from '../core/ir.ts';

export interface Ambiguity {
  a: string;
  b: string;
  stateId: string;
  schedule: string;
  appScope: string;
}

export interface AmbiguityReport {
  ambiguities: Ambiguity[];
  /** Executors excluded because their app scope could not be resolved (DESIGN.md §7.3). */
  excludedForScope: number;
  comparisons: number;
}

const WRITE_MODES = new Set(['write', 'readwrite']);

/**
 * Collects a filter tree into the components it requires present and requires absent.
 * `Or` is not decomposable this way, so it clears `exact` and the caller falls back to
 * "not provably disjoint".
 */
function polarity(filter: FilterExpr | undefined): { with: Set<string>; without: Set<string>; exact: boolean } {
  const present = new Set<string>();
  const absent = new Set<string>();
  let exact = true;
  const walk = (f: FilterExpr | undefined): void => {
    if (!f) return;
    switch (f.kind) {
      case 'with':
        present.add(f.state);
        return;
      case 'without':
        absent.add(f.state);
        return;
      case 'added':
      case 'changed':
        // Change detection narrows matches but proves nothing about disjointness.
        return;
      case 'and':
        for (const operand of f.operands) walk(operand);
        return;
      case 'or':
        exact = false;
        return;
    }
  };
  walk(filter);
  return { with: present, without: absent, exact };
}

/**
 * Condition 4: `With<A>` versus `Without<A>` can never match the same entity.
 *
 * Deliberately conservative — returns true only when disjointness is PROVEN. Claiming
 * disjointness wrongly hides a real conflict, which is worse than reporting an extra one.
 */
export function provablyDisjoint(a: FilterExpr | undefined, b: FilterExpr | undefined): boolean {
  const left = polarity(a);
  const right = polarity(b);
  if (!left.exact || !right.exact) return false;
  for (const component of left.with) if (right.without.has(component)) return true;
  for (const component of right.with) if (left.without.has(component)) return true;
  return false;
}

/** Names an executor can be referred to by in an ordering constraint. */
function aliasesOf(executor: ExecutorNode): string[] {
  const last = executor.id.split('::').pop() ?? executor.id;
  return [...new Set([executor.display, executor.id, last, executor.display.replace(/::<.*/, '')])];
}

interface Group {
  scope: string;
  schedule: string;
  executors: ExecutorNode[];
}

function groupByScopeAndSchedule(ir: AtlasIR): { groups: Group[]; excludedForScope: number } {
  const groups = new Map<string, Group>();
  let excludedForScope = 0;
  for (const executor of ir.executors) {
    const schedule = executor.registration?.schedule;
    if (schedule === undefined) continue;
    if (executor.appScopes.length === 0) {
      excludedForScope++;
      continue;
    }
    for (const scope of executor.appScopes) {
      const key = `${scope} ${schedule}`;
      const existing = groups.get(key);
      if (existing) existing.executors.push(executor);
      else groups.set(key, { scope, schedule, executors: [executor] });
    }
  }
  return { groups: [...groups.values()], excludedForScope };
}

/**
 * Ordering reachability for one group (condition 2).
 *
 * Walks system-level constraints (`before`/`after`/`chain`) AND set-level ones
 * (`configure_sets` combined with `in_set` membership) as one graph: two systems ordered
 * only through their sets are still ordered, and missing that reads plugin-structured
 * code as unordered.
 */
function buildOrdering(group: Group, ir: AtlasIR): (a: string, b: string) => boolean {
  const byAlias = new Map<string, ExecutorNode[]>();
  for (const executor of group.executors) {
    for (const alias of aliasesOf(executor)) {
      const list = byAlias.get(alias);
      if (list) list.push(executor);
      else byAlias.set(alias, [executor]);
    }
  }
  const bySet = new Map<string, ExecutorNode[]>();
  for (const executor of group.executors) {
    for (const set of executor.registration?.inSets ?? []) {
      const list = bySet.get(set);
      if (list) list.push(executor);
      else bySet.set(set, [executor]);
    }
  }

  /** A reference may name a system or a whole set; both expand to concrete executors. */
  const membersOf = (label: string): ExecutorNode[] => byAlias.get(label) ?? bySet.get(label) ?? [];

  const edges = new Map<string, Set<string>>();
  const link = (from: string, to: string): void => {
    if (from === to) return;
    const set = edges.get(from);
    if (set) set.add(to);
    else edges.set(from, new Set([to]));
  };

  for (const executor of group.executors) {
    for (const target of executor.registration?.before ?? []) {
      for (const other of membersOf(target)) link(executor.id, other.id);
    }
    for (const target of executor.registration?.after ?? []) {
      for (const other of membersOf(target)) link(other.id, executor.id);
    }
  }
  for (const ordering of ir.setOrderings) {
    if (!ordering.appScopes.includes(group.scope)) continue;
    for (const earlier of membersOf(ordering.before)) {
      for (const later of membersOf(ordering.after)) link(earlier.id, later.id);
    }
  }

  const memo = new Map<string, Set<string>>();
  const reachable = (from: string): Set<string> => {
    const cached = memo.get(from);
    if (cached) return cached;
    const out = new Set<string>();
    memo.set(from, out);
    const stack = [...(edges.get(from) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (out.has(next)) continue;
      out.add(next);
      for (const onward of edges.get(next) ?? []) if (!out.has(onward)) stack.push(onward);
    }
    return out;
  };

  return (a, b) => reachable(a).has(b) || reachable(b).has(a);
}

function suppressed(a: ExecutorNode, b: ExecutorNode): boolean {
  const check = (x: ExecutorNode, y: ExecutorNode): boolean => {
    const list = x.registration?.ambiguousWith;
    if (list === undefined) return false;
    if (list === 'all') return true;
    const names = new Set(aliasesOf(y));
    return list.some((entry) => names.has(entry));
  };
  return check(a, b) || check(b, a);
}

/**
 * Static ambiguity analysis (DESIGN.md §8) — a reimplementation of the check Bevy runs
 * dynamically as `ScheduleBuildSettings::ambiguity_detection`, validated against it by the
 * oracle in `harness/`.
 *
 * Two executors are ambiguous iff all five hold:
 *   1. same app scope and schedule;
 *   2. no transitive ordering constraint, system-level or set-level;
 *   3. overlapping state access with at least one write;
 *   4. filters not provably disjoint;
 *   5. not suppressed by `ambiguous_with`.
 */
export function findAmbiguities(ir: AtlasIR): AmbiguityReport {
  const { groups, excludedForScope } = groupByScopeAndSchedule(ir);
  const accessesByExecutor = new Map<string, Access[]>();
  for (const access of ir.accesses) {
    // `Commands` is deferred: each system gets its own queue, so two systems both using
    // Commands do not race. Bevy does not report it, and neither may we.
    if (access.stateId === STRUCTURAL_STATE_ID) continue;
    const list = accessesByExecutor.get(access.executorId);
    if (list) list.push(access);
    else accessesByExecutor.set(access.executorId, [access]);
  }

  const ambiguities: Ambiguity[] = [];
  let comparisons = 0;

  for (const group of groups) {
    const ordered = buildOrdering(group, ir);

    // Only compare executors that share a state, and only where one of them writes.
    const byState = new Map<string, Array<{ executor: ExecutorNode; access: Access }>>();
    for (const executor of group.executors) {
      for (const access of accessesByExecutor.get(executor.id) ?? []) {
        const list = byState.get(access.stateId);
        if (list) list.push({ executor, access });
        else byState.set(access.stateId, [{ executor, access }]);
      }
    }

    const seen = new Set<string>();
    for (const [stateId, touchers] of byState) {
      for (let i = 0; i < touchers.length; i++) {
        for (let j = i + 1; j < touchers.length; j++) {
          const left = touchers[i]!;
          const right = touchers[j]!;
          if (left.executor.id === right.executor.id) continue;
          comparisons++;

          if (!WRITE_MODES.has(left.access.mode) && !WRITE_MODES.has(right.access.mode)) continue;
          if (provablyDisjoint(left.access.filters, right.access.filters)) continue;
          if (suppressed(left.executor, right.executor)) continue;
          if (ordered(left.executor.id, right.executor.id)) continue;

          const [a, b] = [left.executor.id, right.executor.id].sort() as [string, string];
          const key = `${group.scope} ${group.schedule} ${a} ${b} ${stateId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          ambiguities.push({ a, b, stateId, schedule: group.schedule, appScope: group.scope });
        }
      }
    }
  }

  return { ambiguities, excludedForScope, comparisons };
}
