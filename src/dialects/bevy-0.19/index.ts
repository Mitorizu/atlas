import type Parser from 'tree-sitter';
import {
  STRUCTURAL_STATE_ID,
  structuralStateNode,
  type Access,
  type ExecutorNode,
  type Registration,
  type SourceLoc,
  type StateNode,
} from '../../core/ir.ts';
import type { Dialect, DialectOutput, SourceFile } from '../types.ts';
import { collectDeclarations, descend, enclosingModules, type Declarations } from './declarations.ts';
import { analyzeParam, type RawAccess } from './params.ts';
import {
  collectObservers,
  collectRegistrations,
  collectSetOrderings,
  leafLabel,
  OBSERVER_SCHEDULE,
  type RegistrationLeaf,
} from './registration.ts';

/**
 * Bevy 0.19 dialect (DESIGN.md §7). Passes 1-3 complete as of Milestone 2:
 *   1. declarations  — derives, `SystemParam` structs, `impl Plugin`
 *   2. candidates    — every `fn` whose signature declares access, SystemParams expanded
 *   3. registration  — `add_systems`, `add_observer`, `configure_sets`, with §7.6 propagation
 *
 * Pass 4 (plugin -> App resolution, so `appScope` is real for plugin-registered systems)
 * is Milestone 3; until then a file that does not build an App reports scope `unknown`
 * and its executors are excluded from ambiguity analysis rather than guessed into a scope.
 */

function loc(file: SourceFile, node: Parser.SyntaxNode): SourceLoc {
  return {
    file: file.path,
    line: node.startPosition.row + 1,
    col: node.startPosition.column + 1,
    byteStart: node.startIndex,
    byteEnd: node.endIndex,
  };
}

function signatureOf(fn: Parser.SyntaxNode, text: string): string {
  const body = fn.childForFieldName('body');
  const end = body ? body.startIndex : fn.endIndex;
  return text.slice(fn.startIndex, end).trim().replace(/\s+/g, ' ');
}

/** What a parameter list yields, independent of which function declared it. */
interface DeclaredAccess {
  accesses: RawAccess[];
  observes?: string;
}

interface Candidate extends DeclaredAccess {
  name: string;
  /** Full module path including enclosing `mod` blocks (§6.2). */
  modPath: string;
  node: Parser.SyntaxNode;
}

/** Reads declared access from a parameter list (`parameters` or `closure_parameters`). */
function accessesFromParams(params: Parser.SyntaxNode, decls: Declarations): DeclaredAccess {
  const accesses: RawAccess[] = [];
  let observes: string | undefined;
  for (const param of params.namedChildren) {
    if (param.type !== 'parameter') continue;
    const typeNode = param.childForFieldName('type');
    if (!typeNode) continue;
    const result = analyzeParam(typeNode, decls.systemParams);
    accesses.push(...result.accesses);
    if (result.observes !== undefined) observes = result.observes;
  }
  return observes === undefined ? { accesses } : { accesses, observes };
}

function modulePathOf(node: Parser.SyntaxNode, base: string): string {
  const inner = enclosingModules(node);
  return inner.length > 0 ? `${base}::${inner.join('::')}` : base;
}

/** Pass 2: every `fn` whose signature declares state access. */
function collectCandidates(root: Parser.SyntaxNode, decls: Declarations, base: string): Candidate[] {
  const found: Candidate[] = [];
  descend(root, (node) => {
    if (node.type !== 'function_item') return;
    const name = node.childForFieldName('name')?.text;
    const params = node.childForFieldName('parameters');
    if (!name || !params) return;
    const result = accessesFromParams(params, decls);
    if (result.accesses.length > 0) found.push({ name, modPath: modulePathOf(node, base), node, ...result });
  });
  return found;
}

/**
 * Resolves a registration reference to a candidate, innermost module first.
 *
 * A registration inside `mod a` naming `setup` means `a::setup` when that exists, so
 * resolution walks outward from the registration's own module before falling back to a
 * corpus-unique bare name. Ambiguous bare names resolve to nothing rather than to an
 * arbitrary match — a wrong binding corrupts §8, a missing one merely under-reports.
 */
function resolveCandidate(
  leafModPath: string,
  name: string,
  byQualified: ReadonlyMap<string, Candidate>,
  byName: ReadonlyMap<string, Candidate[]>,
): Candidate | undefined {
  const segments = leafModPath.split('::');
  for (let i = segments.length; i > 0; i--) {
    const found = byQualified.get(`${segments.slice(0, i).join('::')}::${name}`);
    if (found) return found;
  }
  const sameName = byName.get(name);
  return sameName?.length === 1 ? sameName[0] : undefined;
}

function registrationFrom(leaf: RegistrationLeaf): Registration {
  return {
    schedule: leaf.schedule,
    before: leaf.modifiers.before,
    after: leaf.modifiers.after,
    inSets: leaf.modifiers.inSets,
    chained: leaf.chained,
    runConditions: leaf.modifiers.runConditions,
    ...(leaf.modifiers.ambiguousWith ? { ambiguousWith: leaf.modifiers.ambiguousWith } : {}),
  };
}

function hasAppRoot(root: Parser.SyntaxNode): boolean {
  let found = false;
  descend(root, (node) => {
    if (node.type === 'scoped_identifier' && node.text.replace(/\s+/g, '') === 'App::new') found = true;
  });
  return found;
}

export const bevy019: Dialect = {
  id: 'bevy-0.19',
  language: 'rust',

  matches(file: SourceFile): boolean {
    return file.path.endsWith('.rs');
  },

  extract(tree: Parser.Tree, file: SourceFile): DialectOutput {
    const root = tree.rootNode;
    const decls = collectDeclarations(root);
    const appScope = hasAppRoot(root) ? file.modulePath : 'unknown';

    const candidates = collectCandidates(root, decls, file.modulePath);
    const byQualified = new Map<string, Candidate>();
    const byName = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
      const key = `${candidate.modPath}::${candidate.name}`;
      if (!byQualified.has(key)) byQualified.set(key, candidate);
      const list = byName.get(candidate.name);
      if (list) list.push(candidate);
      else byName.set(candidate.name, [candidate]);
    }

    const leaves = [...collectRegistrations(root), ...collectObservers(root)];
    const registrationsFor = new Map<Candidate, RegistrationLeaf[]>();
    for (const leaf of leaves) {
      if (leaf.systemName === null) continue;
      const target = resolveCandidate(modulePathOf(leaf.node, file.modulePath), leaf.systemName, byQualified, byName);
      if (!target) continue;
      const list = registrationsFor.get(target);
      if (list) list.push(leaf);
      else registrationsFor.set(target, [leaf]);
    }

    const executors: ExecutorNode[] = [];
    const accesses: Access[] = [];
    const states = new Map<string, StateNode>();

    const noteState = (raw: RawAccess): void => {
      if (raw.state === STRUCTURAL_STATE_ID) {
        states.set(STRUCTURAL_STATE_ID, structuralStateNode());
        return;
      }
      const existing = states.get(raw.state);
      if (existing) {
        if (raw.scoped) existing.ambiguousKey = true;
        return;
      }
      // Usage position infers the category; a local `#[derive(..)]` is authoritative (§7.3).
      const declared = decls.categories.get(raw.state);
      states.set(raw.state, {
        id: raw.state,
        display: raw.state,
        category: declared ?? raw.category,
        ubiquitous: false,
        ...(raw.scoped ? { ambiguousKey: true } : {}),
      });
    };

    const emit = (
      id: string,
      display: string,
      kind: ExecutorNode['kind'],
      node: Parser.SyntaxNode,
      candidate: DeclaredAccess,
      typeArgs: string[],
      leaf: RegistrationLeaf | undefined,
    ): void => {
      executors.push({
        id,
        display,
        kind,
        ...(typeArgs.length > 0 ? { typeArgs } : {}),
        appScope,
        loc: loc(file, node),
        ...(leaf ? { registration: registrationFrom(leaf) } : {}),
        ...(candidate.observes !== undefined ? { observes: candidate.observes } : {}),
        unregistered: leaf === undefined,
        signature: signatureOf(node, file.text),
      });
      for (const raw of candidate.accesses) {
        noteState(raw);
        accesses.push({
          executorId: id,
          stateId: raw.state,
          mode: raw.mode,
          optional: raw.optional,
          ...(raw.filters ? { filters: raw.filters } : {}),
          ...(raw.viaParam !== undefined ? { viaParam: raw.viaParam } : {}),
          loc: loc(file, node),
        });
      }
    };

    for (const candidate of candidates) {
      const registrations = registrationsFor.get(candidate) ?? [];
      const kind: ExecutorNode['kind'] =
        candidate.observes !== undefined || registrations.some((r) => r.schedule === OBSERVER_SCHEDULE)
          ? 'observer'
          : 'system';

      // One executor per distinct instantiation; identity includes type args (§6.2).
      const instantiations = registrations.length > 0 ? registrations.map((r) => r.typeArgs) : [[] as string[]];
      const seen = new Set<string>();

      for (const args of instantiations) {
        const suffix = args.length > 0 ? `::<${args.join(', ')}>` : '';
        const id = `${candidate.modPath}::${candidate.name}${suffix}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const leaf = registrations.find((r) => r.typeArgs.join(',') === args.join(','));
        emit(id, `${candidate.name}${suffix}`, kind, candidate.node, candidate, args, leaf);
      }
    }

    // Inline closure systems: registered by definition, and named by position (§7.6).
    for (const leaf of leaves) {
      if (!leaf.closure) continue;
      const params = leaf.closure.childForFieldName('parameters');
      if (!params) continue;
      const result = accessesFromParams(params, decls);
      if (result.accesses.length === 0) continue;
      const label = leafLabel(leaf);
      emit(`${modulePathOf(leaf.closure, file.modulePath)}::${label}`, label, 'closure', leaf.closure, result, [], leaf);
    }

    return {
      executors,
      states: [...states.values()],
      accesses,
      setOrderings: collectSetOrderings(root, appScope),
    };
  },
};
