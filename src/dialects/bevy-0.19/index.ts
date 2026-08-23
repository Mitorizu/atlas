import type Parser from 'tree-sitter';
import {
  STRUCTURAL_STATE_ID,
  structuralStateNode,
  type Access,
  type AccessMode,
  type ExecutorNode,
  type SourceLoc,
  type StateCategory,
  type StateNode,
} from '../../core/ir.ts';
import type { Dialect, DialectOutput, SourceFile } from '../types.ts';
import { baseName, isMutableRef, renderType, typeArgs, wasScoped } from './types.ts';

/**
 * Bevy 0.19 dialect (DESIGN.md §7).
 *
 * Milestone 1 implements the vertical slice: `Commands`, `Res`/`ResMut`, and `Query`
 * data terms, plus `add_systems` registration. The parameter vocabulary is completed at
 * Milestone 2 (`Single`, `Populated`, `MessageReader`/`Writer`, `On`, `ParamSet`,
 * `SystemParam` expansion) and plugin resolution at Milestone 3. A parameter whose type
 * this dialect does not recognise contributes no access — it is not state as far as the
 * declared-boundary invariant (§2) is concerned.
 */

/** Parameter types that resolve to a resource-category state node. */
const RESOURCE_PARAMS: Record<string, AccessMode> = { Res: 'read', ResMut: 'readwrite' };
/** Parameter types whose first type argument is a query data term. */
const QUERY_PARAMS = new Set(['Query']);
/** Parameter types that are private to one system and are never state nodes (§7.1). */
const EXCLUDED_PARAMS = new Set(['Local']);
/** Unbounded structural mutation (§7.4). */
const STRUCTURAL_PARAMS = new Set(['Commands']);

function loc(file: SourceFile, node: Parser.SyntaxNode): SourceLoc {
  return {
    file: file.path,
    line: node.startPosition.row + 1,
    col: node.startPosition.column + 1,
    byteStart: node.startIndex,
    byteEnd: node.endIndex,
  };
}

interface RawAccess {
  state: string;
  category: StateCategory;
  mode: AccessMode;
  optional: boolean;
  scoped: boolean;
}

/** Walks a `Query<D>` data term: `&T`, `&mut T`, `Option<&T>`, and tuples thereof. */
function queryData(node: Parser.SyntaxNode, optional: boolean, out: RawAccess[]): void {
  switch (node.type) {
    case 'tuple_type':
      for (const child of node.namedChildren) queryData(child, optional, out);
      return;
    case 'reference_type': {
      const inner = node.childForFieldName('type');
      if (!inner) return;
      out.push({
        state: renderType(inner),
        category: 'component',
        mode: isMutableRef(node) ? 'readwrite' : 'read',
        optional,
        scoped: wasScoped(inner),
      });
      return;
    }
    case 'generic_type': {
      // `Option<&T>` contributes the inner term, marked optional.
      if (baseName(node) === 'Option') {
        for (const arg of typeArgs(node)) queryData(arg, true, out);
      }
      return;
    }
    default:
      // `Entity`, `&mut Mut<T>` wrappers and other terms are completed at M2.
      return;
  }
}

/** Reads one function parameter's declared access. */
function paramAccess(typeNode: Parser.SyntaxNode): RawAccess[] {
  const name = baseName(typeNode);
  if (EXCLUDED_PARAMS.has(name)) return [];

  if (STRUCTURAL_PARAMS.has(name)) {
    return [{ state: STRUCTURAL_STATE_ID, category: 'synthetic', mode: 'structural', optional: false, scoped: false }];
  }

  const resourceMode = RESOURCE_PARAMS[name];
  if (resourceMode !== undefined) {
    const [arg] = typeArgs(typeNode);
    if (!arg) return [];
    return [{
      state: renderType(arg),
      category: 'resource',
      mode: resourceMode,
      optional: false,
      scoped: wasScoped(arg),
    }];
  }

  if (QUERY_PARAMS.has(name)) {
    const [data] = typeArgs(typeNode);
    if (!data) return [];
    const out: RawAccess[] = [];
    queryData(data, false, out);
    return out;
  }

  return [];
}

function descend(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node);
  for (const child of node.children) descend(child, visit);
}

/** Signature text without the body, for the detail tier. */
function signatureOf(fn: Parser.SyntaxNode, text: string): string {
  const body = fn.childForFieldName('body');
  const end = body ? body.startIndex : fn.endIndex;
  return text.slice(fn.startIndex, end).trim().replace(/\s+/g, ' ');
}

interface Candidate {
  name: string;
  node: Parser.SyntaxNode;
  accesses: RawAccess[];
}

/** Pass 2: every `fn` whose signature declares state access (§7). */
function candidates(root: Parser.SyntaxNode): Candidate[] {
  const found: Candidate[] = [];
  descend(root, (node) => {
    if (node.type !== 'function_item') return;
    const name = node.childForFieldName('name')?.text;
    const params = node.childForFieldName('parameters');
    if (!name || !params) return;

    const accesses: RawAccess[] = [];
    for (const param of params.namedChildren) {
      if (param.type !== 'parameter') continue;
      const typeNode = param.childForFieldName('type');
      if (typeNode) accesses.push(...paramAccess(typeNode));
    }
    if (accesses.length > 0) found.push({ name, node, accesses });
  });
  return found;
}

export interface RegistrationSite {
  systemName: string;
  typeArgs: string[];
  schedule: string;
  modifiers: string[];
}

/**
 * Walks one member of a registration tuple. Modifier chains are descended to their
 * receiver; full propagation semantics (§7.6) land at Milestone 2.
 *
 * Skips `ERROR` and `array_expression`, the deterministic artifacts left by an
 * unparseable `#[cfg(...)]` in expression position (M0 finding, §7.6).
 */
function systemTerms(node: Parser.SyntaxNode, modifiers: string[], out: RegistrationSite[], schedule: string): void {
  switch (node.type) {
    case 'ERROR':
    case 'array_expression':
      return;
    case 'tuple_expression':
      for (const child of node.namedChildren) systemTerms(child, modifiers, out, schedule);
      return;
    case 'identifier':
      out.push({ systemName: node.text, typeArgs: [], schedule, modifiers: [...modifiers] });
      return;
    case 'scoped_identifier':
      out.push({
        systemName: node.childForFieldName('name')?.text ?? node.text,
        typeArgs: [],
        schedule,
        modifiers: [...modifiers],
      });
      return;
    case 'generic_function': {
      const fn = node.childForFieldName('function');
      const args = node.childForFieldName('type_arguments');
      if (!fn) return;
      out.push({
        systemName: fn.type === 'scoped_identifier' ? (fn.childForFieldName('name')?.text ?? fn.text) : fn.text,
        typeArgs: (args?.namedChildren ?? []).filter((c) => c.type !== 'lifetime').map(renderType),
        schedule,
        modifiers: [...modifiers],
      });
      return;
    }
    case 'call_expression': {
      const fn = node.childForFieldName('function');
      if (fn?.type === 'field_expression') {
        const modifier = fn.childForFieldName('field')?.text;
        const receiver = fn.childForFieldName('value');
        if (receiver) systemTerms(receiver, modifier ? [...modifiers, modifier] : modifiers, out, schedule);
      }
      return;
    }
    default:
      return;
  }
}

/** Pass 3: `add_systems(Schedule, systems)` sites. */
export function registrationSites(root: Parser.SyntaxNode): RegistrationSite[] {
  const sites: RegistrationSite[] = [];
  descend(root, (node) => {
    if (node.type !== 'call_expression') return;
    const fn = node.childForFieldName('function');
    if (fn?.type !== 'field_expression') return;
    if (fn.childForFieldName('field')?.text !== 'add_systems') return;

    const args = node.childForFieldName('arguments')?.namedChildren ?? [];
    const [scheduleNode, ...systems] = args;
    if (!scheduleNode) return;
    const schedule = scheduleNode.text.replace(/\s+/g, '');
    for (const term of systems) systemTerms(term, [], sites, schedule);
  });
  return sites;
}

/** Does this file build an App? Used for the Milestone 1 appScope rule (§7.3). */
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
    const sites = registrationSites(root);
    const byName = new Map<string, RegistrationSite[]>();
    for (const site of sites) {
      const list = byName.get(site.systemName);
      if (list) list.push(site);
      else byName.set(site.systemName, [site]);
    }

    // §7.3: a file that builds an App is its own scope. Files that register systems into
    // someone else's App cannot be resolved until plugin resolution at M3, so they are
    // marked unknown and excluded from ambiguity analysis rather than guessed into a scope.
    const appScope = hasAppRoot(root) ? file.modulePath : 'unknown';

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
        // A component seen through a resource slot (or vice versa) would be a real
        // conflict; first declaration wins and the discrepancy is left visible.
        if (raw.scoped) existing.ambiguousKey = true;
        return;
      }
      states.set(raw.state, {
        id: raw.state,
        display: raw.state,
        category: raw.category,
        ubiquitous: false,
        ...(raw.scoped ? { ambiguousKey: true } : {}),
      });
    };

    for (const candidate of candidates(root)) {
      const registrations = byName.get(candidate.name) ?? [];
      // One executor per distinct instantiation; identity includes type args (§6.2).
      const instantiations =
        registrations.length > 0
          ? registrations.map((r) => r.typeArgs)
          : [[] as string[]];
      const seen = new Set<string>();

      for (const args of instantiations) {
        const suffix = args.length > 0 ? `::<${args.join(', ')}>` : '';
        const id = `${file.modulePath}::${candidate.name}${suffix}`;
        if (seen.has(id)) continue;
        seen.add(id);

        const site = registrations.find((r) => r.typeArgs.join(',') === args.join(','));
        executors.push({
          id,
          display: `${candidate.name}${suffix}`,
          kind: 'system',
          ...(args.length > 0 ? { typeArgs: args } : {}),
          appScope,
          loc: loc(file, candidate.node),
          ...(site
            ? {
                registration: {
                  schedule: site.schedule,
                  before: [],
                  after: [],
                  inSets: [],
                  chained: site.modifiers.includes('chain'),
                  runConditions: site.modifiers.filter((m) => m === 'run_if'),
                },
              }
            : {}),
          unregistered: registrations.length === 0,
          signature: signatureOf(candidate.node, file.text),
        });

        for (const raw of candidate.accesses) {
          noteState(raw);
          accesses.push({
            executorId: id,
            stateId: raw.state,
            mode: raw.mode,
            optional: raw.optional,
            loc: loc(file, candidate.node),
          });
        }
      }
    }

    return { executors, states: [...states.values()], accesses };
  },
};
