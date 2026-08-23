import type Parser from 'tree-sitter';

/** Reconstructs a canonical type name from a type node: terminal name plus generic args.
 *  `bevy_asset::Assets<Mesh>` -> `Assets<Mesh>`; keeps generic args so §7.4 keying holds. */
export function renderType(node: Parser.SyntaxNode): string {
  switch (node.type) {
    case 'type_identifier':
    case 'primitive_type':
      return node.text;
    case 'scoped_type_identifier':
      return node.childForFieldName('name')?.text ?? node.text;
    case 'generic_type': {
      const base = node.childForFieldName('type');
      const args = node.childForFieldName('type_arguments');
      const rendered = base ? renderType(base) : node.text;
      const inner = (args?.namedChildren ?? [])
        .filter((c) => c.type !== 'lifetime')
        .map(renderType)
        .join(', ');
      return inner ? `${rendered}<${inner}>` : rendered;
    }
    case 'reference_type': {
      const inner = node.childForFieldName('type');
      return `&${isMutableRef(node) ? 'mut ' : ''}${inner ? renderType(inner) : ''}`;
    }
    case 'tuple_type':
      return `(${node.namedChildren.map(renderType).join(', ')})`;
    default:
      return node.text;
  }
}

/** `&mut T` carries a `mutable_specifier` child; `&T` does not (verified in M0). */
export function isMutableRef(node: Parser.SyntaxNode): boolean {
  return node.children.some((c) => c.type === 'mutable_specifier');
}

/** True when the type was written with a path (`bevy_asset::Assets`), so the key is a
 *  terminal-name fallback until `use` resolution lands at M3 (§6.2). */
export function wasScoped(node: Parser.SyntaxNode): boolean {
  if (node.type === 'scoped_type_identifier') return true;
  const base = node.type === 'generic_type' ? node.childForFieldName('type') : null;
  return base?.type === 'scoped_type_identifier';
}

/** The base (unparameterised) name of a type node: `Res<Time>` -> `Res`. */
export function baseName(node: Parser.SyntaxNode): string {
  if (node.type === 'generic_type') {
    const base = node.childForFieldName('type');
    return base ? baseName(base) : node.text;
  }
  if (node.type === 'scoped_type_identifier') return node.childForFieldName('name')?.text ?? node.text;
  return node.text;
}

/** Type arguments of a generic type node, lifetimes stripped. */
export function typeArgs(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  if (node.type !== 'generic_type') return [];
  const args = node.childForFieldName('type_arguments');
  return (args?.namedChildren ?? []).filter((c) => c.type !== 'lifetime');
}
