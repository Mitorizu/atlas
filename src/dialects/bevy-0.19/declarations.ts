import type Parser from 'tree-sitter';
import type { StateCategory } from '../../core/ir.ts';
import { DERIVE_CATEGORY } from './vocabulary.ts';
import { baseName } from './types.ts';

export interface Declarations {
  /** Type name -> category, from `#[derive(Component)]` and friends (§7.3). */
  categories: Map<string, StateCategory>;
  /** `#[derive(SystemParam)]` struct name -> field type nodes (§7.2). */
  systemParams: Map<string, Parser.SyntaxNode[]>;
  /** `impl Plugin for X` -> the impl body, consumed by plugin resolution at M3. */
  plugins: Map<string, Parser.SyntaxNode>;
}

/**
 * Names of the `mod` blocks enclosing a node, outermost first.
 *
 * Identity is (module path, name, type args) per §6.2, and inner modules are part of the
 * module path: `testbed/ui.rs` declares `pub fn setup` in 14 separate `mod` blocks, so
 * keying on the file alone fuses fourteen unrelated systems into one node.
 */
export function enclosingModules(node: Parser.SyntaxNode): string[] {
  const parts: string[] = [];
  for (let current = node.parent; current; current = current.parent) {
    if (current.type !== 'mod_item') continue;
    const name = current.childForFieldName('name')?.text;
    if (name) parts.unshift(name);
  }
  return parts;
}

export function descend(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node);
  for (const child of node.children) descend(child, visit);
}

/** Derive names sit as identifiers inside the attribute's `token_tree` (verified in M2). */
function deriveNames(attributeItem: Parser.SyntaxNode): string[] {
  const attribute = attributeItem.namedChildren.find((c) => c.type === 'attribute');
  if (!attribute) return [];
  const head = attribute.namedChildren[0];
  if (head?.text !== 'derive') return [];
  const args = attribute.childForFieldName('arguments');
  if (!args) return [];
  return args.namedChildren.filter((c) => c.type === 'identifier').map((c) => c.text);
}

/** Attribute items immediately preceding an item, in source order. */
function precedingAttributes(item: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = [];
  let sibling = item.previousNamedSibling;
  while (sibling && sibling.type === 'attribute_item') {
    out.push(sibling);
    sibling = sibling.previousNamedSibling;
  }
  return out;
}

function fieldTypes(item: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const body = item.childForFieldName('body');
  if (!body || body.type !== 'field_declaration_list') return [];
  return body.namedChildren
    .filter((c) => c.type === 'field_declaration')
    .map((c) => c.childForFieldName('type'))
    .filter((t): t is Parser.SyntaxNode => t !== null);
}

/**
 * Pass 1 (DESIGN.md §7): declaration sites.
 *
 * Category is primarily inferred from usage position — inside `Query` means component,
 * inside `Res` means resource — which is unambiguous. These derives corroborate that and
 * surface state that is declared but never accessed.
 */
export function collectDeclarations(root: Parser.SyntaxNode): Declarations {
  const categories = new Map<string, StateCategory>();
  const systemParams = new Map<string, Parser.SyntaxNode[]>();
  const plugins = new Map<string, Parser.SyntaxNode>();

  descend(root, (node) => {
    if (node.type === 'struct_item' || node.type === 'enum_item') {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      for (const attr of precedingAttributes(node)) {
        for (const derive of deriveNames(attr)) {
          const category = DERIVE_CATEGORY[derive];
          if (category && !categories.has(name)) categories.set(name, category);
          if (derive === 'SystemParam') systemParams.set(name, fieldTypes(node));
        }
      }
      return;
    }

    if (node.type === 'impl_item') {
      const traitName = node.childForFieldName('trait')?.text;
      const typeNode = node.childForFieldName('type');
      const body = node.childForFieldName('body');
      // Generic plugins (`impl<S> Plugin for StatePlugin<S>`) must key on the base name.
      if ((traitName === 'Plugin' || traitName === 'PluginGroup') && typeNode && body) {
        plugins.set(baseName(typeNode), body);
      }
    }
  });

  return { categories, systemParams, plugins };
}
