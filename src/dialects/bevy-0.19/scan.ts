import type Parser from 'tree-sitter';
import type { SourceLoc } from '../../core/ir.ts';
import type { SourceFile } from '../types.ts';
import { collectDeclarations, descend, enclosingModules, type Declarations } from './declarations.ts';
import { analyzeParam, type RawAccess } from './params.ts';
import { leafLabel, methodCalls, walkTerm, OBSERVER_SCHEDULE, type Modifiers } from './registration.ts';
import { baseName } from './types.ts';
import type {
  CandidateFact,
  DeclaredAccess,
  FileFacts,
  Owner,
  PluginEdgeFact,
  RegistrationFact,
  SetOrderingFact,
} from './facts.ts';

function loc(file: SourceFile, node: Parser.SyntaxNode): SourceLoc {
  return {
    file: file.path,
    line: node.startPosition.row + 1,
    col: node.startPosition.column + 1,
    byteStart: node.startIndex,
    byteEnd: node.endIndex,
  };
}

function signatureOf(node: Parser.SyntaxNode, text: string): string {
  const body = node.childForFieldName('body');
  const end = body ? body.startIndex : node.endIndex;
  return text.slice(node.startIndex, end).trim().replace(/\s+/g, ' ');
}

export function modulePathOf(node: Parser.SyntaxNode, base: string): string {
  const inner = enclosingModules(node);
  return inner.length > 0 ? `${base}::${inner.join('::')}` : base;
}

/** The plugin type whose `impl Plugin for X` (or `impl PluginGroup for X`) encloses a node. */
function enclosingPlugin(node: Parser.SyntaxNode): string | null {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type !== 'impl_item') continue;
    const trait = current.childForFieldName('trait')?.text;
    if (trait !== 'Plugin' && trait !== 'PluginGroup') continue;
    const typeNode = current.childForFieldName('type');
    if (typeNode) return baseName(typeNode);
  }
  return null;
}

function ownerOf(node: Parser.SyntaxNode, appRoot: string | null): Owner {
  const plugin = enclosingPlugin(node);
  if (plugin) return { kind: 'plugin', plugin };
  if (appRoot) return { kind: 'app', scope: appRoot };
  return { kind: 'free' };
}

function declaredAccess(params: Parser.SyntaxNode, decls: Declarations): DeclaredAccess {
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

function hasAppRoot(root: Parser.SyntaxNode): boolean {
  let found = false;
  descend(root, (node) => {
    if (node.type === 'scoped_identifier' && node.text.replace(/\s+/g, '') === 'App::new') found = true;
  });
  return found;
}

/** Plugin references inside an `add_plugins(..)` / `.add(..)` argument. */
function pluginNames(node: Parser.SyntaxNode, out: string[]): void {
  switch (node.type) {
    case 'tuple_expression':
      for (const child of node.namedChildren) pluginNames(child, out);
      return;
    case 'identifier':
      out.push(node.text);
      return;
    case 'scoped_identifier':
      out.push(node.childForFieldName('name')?.text ?? node.text);
      return;
    case 'generic_function': {
      const fn = node.childForFieldName('function');
      if (fn) out.push(fn.type === 'scoped_identifier' ? (fn.childForFieldName('name')?.text ?? fn.text) : fn.text);
      return;
    }
    case 'call_expression': {
      // `Other::default()` and `.set(..)` builders: take the receiver's type name.
      const fn = node.childForFieldName('function');
      if (!fn) return;
      if (fn.type === 'scoped_identifier') {
        const path = fn.childForFieldName('path');
        if (path) out.push(path.text.replace(/\s+/g, '').split('::').pop()!);
        return;
      }
      if (fn.type === 'field_expression') {
        const receiver = fn.childForFieldName('value');
        if (receiver) pluginNames(receiver, out);
      }
      return;
    }
    case 'struct_expression': {
      const name = node.childForFieldName('name');
      if (name) out.push(baseName(name));
      return;
    }
    default:
      return;
  }
}

/**
 * Phase 1 (DESIGN.md §7): everything derivable from one file, with each registration
 * tagged by the owner that will determine its app scope once the plugin graph is walked.
 */
export function scanFile(tree: Parser.Tree, file: SourceFile): FileFacts {
  const root = tree.rootNode;
  const decls = collectDeclarations(root);
  const appRoot = hasAppRoot(root) ? file.modulePath : null;

  const candidates: CandidateFact[] = [];
  descend(root, (node) => {
    if (node.type !== 'function_item') return;
    const name = node.childForFieldName('name')?.text;
    const params = node.childForFieldName('parameters');
    if (!name || !params) return;
    const declared = declaredAccess(params, decls);
    if (declared.accesses.length === 0) return;
    candidates.push({
      name,
      modPath: modulePathOf(node, file.modulePath),
      loc: loc(file, node),
      signature: signatureOf(node, file.text),
      ...declared,
    });
  });

  const registrations: RegistrationFact[] = [];
  const collect = (method: string, scheduleOverride?: string): void => {
    for (const call of methodCalls(root, method)) {
      const args = call.childForFieldName('arguments')?.namedChildren ?? [];
      const [first, ...rest] = args;
      if (!first) continue;
      const terms = scheduleOverride === undefined ? rest : args;
      const schedule = scheduleOverride ?? first.text.replace(/\s+/g, '');
      const owner = ownerOf(call, appRoot);
      for (const term of terms) {
        for (const leaf of walkTerm(term, { runConditions: [], inSets: [], before: [], after: [] }, schedule)) {
          const base: RegistrationFact = {
            systemName: leaf.systemName,
            typeArgs: leaf.typeArgs,
            schedule: leaf.schedule,
            modifiers: leaf.modifiers,
            chained: leaf.chained,
            modPath: modulePathOf(leaf.node, file.modulePath),
            owner,
          };
          if (leaf.closure) {
            const params = leaf.closure.childForFieldName('parameters');
            const declared = params ? declaredAccess(params, decls) : { accesses: [] };
            if (declared.accesses.length === 0) continue;
            base.closure = {
              name: leafLabel(leaf),
              modPath: modulePathOf(leaf.closure, file.modulePath),
              loc: loc(file, leaf.closure),
              signature: signatureOf(leaf.closure, file.text),
              ...declared,
            };
          }
          registrations.push(base);
        }
      }
    }
  };
  collect('add_systems');
  collect('add_observer', OBSERVER_SCHEDULE);

  const pluginEdges: PluginEdgeFact[] = [];
  for (const method of ['add_plugins', 'add']) {
    for (const call of methodCalls(root, method)) {
      const owner = ownerOf(call, appRoot);
      // `.add(..)` is only a plugin edge inside a PluginGroup builder.
      if (method === 'add' && owner.kind !== 'plugin') continue;
      const names: string[] = [];
      for (const arg of call.childForFieldName('arguments')?.namedChildren ?? []) pluginNames(arg, names);
      for (const to of names) pluginEdges.push({ from: owner, to });
    }
  }

  const setOrderings: SetOrderingFact[] = [];
  const seen = new Set<string>();
  for (const call of methodCalls(root, 'configure_sets')) {
    const args = call.childForFieldName('arguments')?.namedChildren ?? [];
    const [scheduleNode, ...terms] = args;
    if (!scheduleNode) continue;
    const schedule = scheduleNode.text.replace(/\s+/g, '');
    const owner = ownerOf(call, appRoot);
    const add = (before: string, after: string): void => {
      const key = `${schedule}|${before}|${after}`;
      if (before === after || seen.has(key)) return;
      seen.add(key);
      setOrderings.push({ before, after, schedule, owner });
    };
    for (const term of terms) {
      for (const leaf of walkTerm(term, { runConditions: [], inSets: [], before: [], after: [] }, schedule)) {
        const self = leafLabel(leaf);
        for (const target of leaf.modifiers.before) add(self, target);
        for (const target of leaf.modifiers.after) add(target, self);
      }
    }
  }

  return {
    file,
    appRoot,
    pluginDefs: [...decls.plugins.keys()],
    declaredCategories: [...decls.categories],
    pluginEdges,
    candidates,
    registrations,
    setOrderings,
  };
}

export type { Modifiers };
