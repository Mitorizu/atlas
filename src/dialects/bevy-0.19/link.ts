import {
  STRUCTURAL_STATE_ID,
  structuralStateNode,
  type Access,
  type ExecutorNode,
  type Registration,
  type SetOrdering,
  type StateNode,
} from '../../core/ir.ts';
import type { Coverage, DialectOutput, LinkResult } from '../types.ts';
import type { CandidateFact, FileFacts, Owner, RegistrationFact } from './facts.ts';
import type { RawAccess } from './params.ts';

/**
 * Marks state that is touched by so many executors that drawing it as a node would
 * dominate the layout (§7.4). Measured at M2: unmitigated, the examples corpus lays out
 * to ~32,000x61,000px because hubs weld every app into one component, so this is a
 * tractability requirement rather than a cosmetic one.
 *
 * The threshold scales with corpus size — a percentile-style rule rather than a constant,
 * so it transfers between a 40-system repo and a 1,400-system one.
 */
export function markUbiquitous(states: StateNode[], accesses: Access[], executorCount: number): number {
  const threshold = Math.max(15, Math.ceil(executorCount * 0.02));
  const degree = new Map<string, Set<string>>();
  for (const a of accesses) {
    const set = degree.get(a.stateId);
    if (set) set.add(a.executorId);
    else degree.set(a.stateId, new Set([a.executorId]));
  }
  for (const state of states) {
    state.ubiquitous = (degree.get(state.id)?.size ?? 0) >= threshold;
  }
  return threshold;
}

/** Scope name used when a corpus contains no `App::new()` at all (§7.3 fallback 2). */
export const WHOLE_REPO_SCOPE = '<repo>';

/**
 * Scope for a plugin that no `App::new()` in this corpus ever adds (§7.3 fallback 2b).
 *
 * A library crate exports plugins that downstream binaries add, so its systems have no
 * app here. Leaving them scopeless excludes them from ambiguity analysis entirely — on
 * the Bevy engine crates that is 93% of executors, because 35 incidental `App::new()`
 * calls in tests suppress the whole-repo fallback while resolving almost nothing.
 *
 * A plugin is itself a valid unit of co-execution: two systems registered by the same
 * plugin do run together whenever that plugin is added. Scoping them to the plugin
 * under-approximates (cross-plugin conflicts stay invisible) but never fabricates.
 */
export function orphanPluginScope(plugin: string): string {
  return `plugin:${plugin}`;
}

/** Terminal segment of a possibly-qualified type name, generics preserved. */
function terminalName(id: string): string {
  const head = id.indexOf('<');
  const base = head === -1 ? id : id.slice(0, head);
  const tail = head === -1 ? '' : id.slice(head);
  return base.split('::').pop()! + tail;
}

/**
 * Corpus-level state key unification (§6.2).
 *
 * `bevy_asset::Assets` and a bare `Assets` are the same type written two ways, and keying
 * them apart fragments a top-five hub. But blind truncation to the terminal identifier
 * fuses genuinely distinct types — `Node`, `State`, `Handle` collide across crates. So:
 * merge a terminal name only when the corpus offers exactly ONE qualified spelling for it;
 * where two or more compete, keep them apart and flag every member.
 */
export function unifyStateKeys(ids: Iterable<string>): Map<string, { id: string; ambiguous: boolean }> {
  const groups = new Map<string, Set<string>>();
  for (const id of ids) {
    const key = terminalName(id);
    const group = groups.get(key);
    if (group) group.add(id);
    else groups.set(key, new Set([id]));
  }

  const mapping = new Map<string, { id: string; ambiguous: boolean }>();
  for (const [terminal, members] of groups) {
    const qualified = [...members].filter((m) => m.includes('::'));
    if (qualified.length <= 1) {
      for (const member of members) mapping.set(member, { id: terminal, ambiguous: false });
    } else {
      for (const member of members) mapping.set(member, { id: member, ambiguous: true });
    }
  }
  return mapping;
}

/** Apps reachable from each plugin, by walking `add_plugins` edges from every App root. */
function resolvePluginScopes(facts: FileFacts[], declaredPlugins: ReadonlySet<string>): Map<string, Set<string>> {
  const addedBy = new Map<string, Owner[]>();
  for (const file of facts) {
    for (const edge of file.pluginEdges) {
      const list = addedBy.get(edge.to);
      if (list) list.push(edge.from);
      else addedBy.set(edge.to, [edge.from]);
    }
  }

  const scopes = new Map<string, Set<string>>();
  const resolve = (plugin: string, seen: Set<string>): Set<string> => {
    const cached = scopes.get(plugin);
    if (cached) return cached;
    if (seen.has(plugin)) return new Set();
    seen.add(plugin);

    const out = new Set<string>();
    for (const from of addedBy.get(plugin) ?? []) {
      if (from.kind === 'app') out.add(from.scope);
      else if (from.kind === 'plugin') for (const s of resolve(from.plugin, seen)) out.add(s);
    }
    scopes.set(plugin, out);
    return out;
  };

  for (const plugin of addedBy.keys()) resolve(plugin, new Set());
  for (const plugin of declaredPlugins) {
    const reached = scopes.get(plugin);
    if (!reached || reached.size === 0) scopes.set(plugin, new Set([orphanPluginScope(plugin)]));
  }
  return scopes;
}

function scopesFor(owner: Owner, pluginScopes: ReadonlyMap<string, Set<string>>): string[] {
  if (owner.kind === 'app') return [owner.scope];
  if (owner.kind === 'plugin') return [...(pluginScopes.get(owner.plugin) ?? [])];
  return [];
}

/**
 * Resolves a registration reference to a candidate: innermost module outward, then a
 * corpus-unique bare name. An ambiguous bare name resolves to NOTHING — a wrong binding
 * corrupts §8, a missing one merely under-reports (§6.2).
 */
function resolveCandidate(
  modPath: string,
  name: string,
  byQualified: ReadonlyMap<string, CandidateFact>,
  byName: ReadonlyMap<string, CandidateFact[]>,
): CandidateFact | undefined {
  const segments = modPath.split('::');
  for (let i = segments.length; i > 0; i--) {
    const found = byQualified.get(`${segments.slice(0, i).join('::')}::${name}`);
    if (found) return found;
  }
  const sameName = byName.get(name);
  return sameName?.length === 1 ? sameName[0] : undefined;
}

function registrationFrom(fact: RegistrationFact): Registration {
  return {
    schedule: fact.schedule,
    before: fact.modifiers.before,
    after: fact.modifiers.after,
    inSets: fact.modifiers.inSets,
    chained: fact.chained,
    runConditions: fact.modifiers.runConditions,
    ...(fact.modifiers.ambiguousWith ? { ambiguousWith: fact.modifiers.ambiguousWith } : {}),
  };
}

/**
 * Phase 2 (DESIGN.md §7, pass 4): whole-corpus resolution.
 *
 * Binds registrations across files, walks the plugin graph so plugin-registered systems
 * get a real app scope, unifies state keys, and reports what could not be resolved.
 */
export function linkFacts(dialect: string, facts: FileFacts[]): LinkResult {
  const byQualified = new Map<string, CandidateFact>();
  const byName = new Map<string, CandidateFact[]>();
  for (const file of facts) {
    for (const candidate of file.candidates) {
      const key = `${candidate.modPath}::${candidate.name}`;
      if (!byQualified.has(key)) byQualified.set(key, candidate);
      const list = byName.get(candidate.name);
      if (list) list.push(candidate);
      else byName.set(candidate.name, [candidate]);
    }
  }

  const appRoots = facts.map((f) => f.appRoot).filter((r): r is string => r !== null);
  const wholeRepoFallback = appRoots.length === 0;
  const pluginDefs = new Set(facts.flatMap((f) => f.pluginDefs));
  const pluginScopes = resolvePluginScopes(facts, pluginDefs);

  const registrationsFor = new Map<CandidateFact, RegistrationFact[]>();
  const closures: RegistrationFact[] = [];
  let registrations = 0;
  let registrationsResolved = 0;
  const unresolvedSamples: string[] = [];

  for (const file of facts) {
    for (const fact of file.registrations) {
      if (fact.closure) {
        closures.push(fact);
        registrations++;
        registrationsResolved++;
        continue;
      }
      if (fact.systemName === null) continue;
      registrations++;
      const target = resolveCandidate(fact.modPath, fact.systemName, byQualified, byName);
      if (!target) {
        if (unresolvedSamples.length < 10) unresolvedSamples.push(`${fact.modPath}::${fact.systemName}`);
        continue;
      }
      registrationsResolved++;
      const list = registrationsFor.get(target);
      if (list) list.push(fact);
      else registrationsFor.set(target, [fact]);
    }
  }

  // A local `#[derive(Component)]` outranks the category inferred from usage position.
  const declaredCategories = new Map<string, StateNode['category']>();
  for (const file of facts) for (const [name, category] of file.declaredCategories) declaredCategories.set(name, category);

  const rawStates = new Map<string, { category: StateNode['category']; scoped: boolean }>();
  const noteRaw = (raw: RawAccess): void => {
    const existing = rawStates.get(raw.state);
    if (existing) {
      if (raw.scoped) existing.scoped = true;
      return;
    }
    rawStates.set(raw.state, { category: raw.category, scoped: raw.scoped });
  };
  for (const file of facts) {
    for (const candidate of file.candidates) for (const raw of candidate.accesses) noteRaw(raw);
    for (const fact of file.registrations) {
      if (fact.closure) for (const raw of fact.closure.accesses) noteRaw(raw);
    }
  }
  const keyMap = unifyStateKeys(rawStates.keys());
  const canonical = (id: string): string => keyMap.get(id)?.id ?? id;

  const states = new Map<string, StateNode>();
  for (const [rawId, info] of rawStates) {
    const resolved = keyMap.get(rawId) ?? { id: rawId, ambiguous: false };
    if (rawId === STRUCTURAL_STATE_ID) {
      states.set(STRUCTURAL_STATE_ID, structuralStateNode());
      continue;
    }
    const existing = states.get(resolved.id);
    if (existing) {
      if (resolved.ambiguous || info.scoped) existing.ambiguousKey = true;
      continue;
    }
    const display = terminalName(resolved.id);
    states.set(resolved.id, {
      id: resolved.id,
      display,
      category: declaredCategories.get(display) ?? declaredCategories.get(resolved.id) ?? info.category,
      ubiquitous: false,
      ...(resolved.ambiguous ? { ambiguousKey: true } : {}),
    });
  }

  const executors: ExecutorNode[] = [];
  const accesses: Access[] = [];

  const emit = (
    id: string,
    display: string,
    kind: ExecutorNode['kind'],
    candidate: CandidateFact,
    typeArgs: string[],
    fact: RegistrationFact | undefined,
    scopes: string[],
  ): void => {
    executors.push({
      id,
      display,
      kind,
      ...(typeArgs.length > 0 ? { typeArgs } : {}),
      appScopes: wholeRepoFallback ? [WHOLE_REPO_SCOPE] : scopes,
      loc: candidate.loc,
      ...(fact ? { registration: registrationFrom(fact) } : {}),
      ...(candidate.observes !== undefined ? { observes: canonical(candidate.observes) } : {}),
      unregistered: fact === undefined,
      signature: candidate.signature,
    });
    for (const raw of candidate.accesses) {
      accesses.push({
        executorId: id,
        stateId: canonical(raw.state),
        mode: raw.mode,
        optional: raw.optional,
        ...(raw.filters ? { filters: raw.filters } : {}),
        ...(raw.viaParam !== undefined ? { viaParam: raw.viaParam } : {}),
        loc: candidate.loc,
      });
    }
  };

  for (const file of facts) {
    for (const candidate of file.candidates) {
      const bound = registrationsFor.get(candidate) ?? [];
      const kind: ExecutorNode['kind'] =
        candidate.observes !== undefined || bound.some((f) => f.schedule === 'Observer') ? 'observer' : 'system';
      const instantiations = bound.length > 0 ? bound.map((f) => f.typeArgs) : [[] as string[]];
      const seen = new Set<string>();

      for (const args of instantiations) {
        const suffix = args.length > 0 ? `::<${args.join(', ')}>` : '';
        const id = `${candidate.modPath}::${candidate.name}${suffix}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const matching = bound.filter((f) => f.typeArgs.join(',') === args.join(','));
        const scopes = [...new Set(matching.flatMap((f) => scopesFor(f.owner, pluginScopes)))];
        emit(id, `${candidate.name}${suffix}`, kind, candidate, args, matching[0], scopes);
      }
    }
  }

  for (const fact of closures) {
    const candidate = fact.closure;
    if (!candidate) continue;
    emit(
      `${candidate.modPath}::${candidate.name}`,
      candidate.name,
      'closure',
      candidate,
      [],
      fact,
      scopesFor(fact.owner, pluginScopes),
    );
  }

  const setOrderings: SetOrdering[] = facts.flatMap((file) =>
    file.setOrderings.map((o) => ({
      before: o.before,
      after: o.after,
      schedule: o.schedule,
      appScopes: wholeRepoFallback ? [WHOLE_REPO_SCOPE] : scopesFor(o.owner, pluginScopes),
    })),
  );

  markUbiquitous([...states.values()], accesses, executors.length);

  const output: DialectOutput = { executors, states: [...states.values()], accesses, setOrderings };
  const coverage: Coverage = {
    files: facts.length,
    executors: executors.length,
    scopeResolved: executors.filter((e) => e.appScopes.length > 0).length,
    scopeUnresolved: executors.filter((e) => e.appScopes.length === 0).length,
    registrations,
    registrationsResolved,
    plugins: pluginDefs.size,
    pluginsReachable: [...pluginDefs].filter((p) =>
      [...(pluginScopes.get(p) ?? [])].some((scope) => !scope.startsWith('plugin:')),
    ).length,
    appRoots,
    wholeRepoFallback,
    unresolvedSamples,
  };

  return { output, coverage };
}
