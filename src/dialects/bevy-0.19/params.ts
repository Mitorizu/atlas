import type Parser from 'tree-sitter';
import { STRUCTURAL_STATE_ID, type AccessMode, type FilterExpr, type StateCategory } from '../../core/ir.ts';
import { baseName, isMutableRef, renderType, typeArgs, wasScoped } from './types.ts';
import {
  DATA_WRAPPERS,
  EXCLUDED_PARAMS,
  FILTER_KINDS,
  MESSAGE_PARAMS,
  NON_ACCESS_DATA,
  OBSERVER_PARAM,
  PARAMSET_PARAM,
  QUERY_PARAMS,
  RESOURCE_PARAMS,
  STRUCTURAL_PARAMS,
} from './vocabulary.ts';

export interface RawAccess {
  state: string;
  category: StateCategory;
  mode: AccessMode;
  optional: boolean;
  scoped: boolean;
  filters?: FilterExpr;
  /** The custom SystemParam this access was expanded from (§7.2). */
  viaParam?: string;
}

export interface ParamResult {
  accesses: RawAccess[];
  /** Set when the parameter is `On<E>`, making the function an observer. */
  observes?: string;
}

/** Custom `#[derive(SystemParam)]` structs, by type name, with their field types. */
export type SystemParamRegistry = ReadonlyMap<string, Parser.SyntaxNode[]>;

/**
 * Parses a `Query` filter term into a FilterExpr (§6). A bare tuple is an implicit AND;
 * `Or<(..)>` and `And<(..)>` nest, which a flat list could not represent.
 */
export function parseFilters(node: Parser.SyntaxNode): FilterExpr | undefined {
  switch (node.type) {
    case 'tuple_type': {
      const operands = node.namedChildren.map(parseFilters).filter((f): f is FilterExpr => f !== undefined);
      if (operands.length === 0) return undefined;
      return operands.length === 1 ? operands[0] : { kind: 'and', operands };
    }
    case 'generic_type': {
      const name = baseName(node);
      const simple = FILTER_KINDS[name];
      if (simple) {
        const [arg] = typeArgs(node);
        return arg ? { kind: simple, state: renderType(arg) } : undefined;
      }
      if (name === 'Or' || name === 'And') {
        const [inner] = typeArgs(node);
        if (!inner) return undefined;
        const operands =
          inner.type === 'tuple_type'
            ? inner.namedChildren.map(parseFilters).filter((f): f is FilterExpr => f !== undefined)
            : [parseFilters(inner)].filter((f): f is FilterExpr => f !== undefined);
        if (operands.length === 0) return undefined;
        return { kind: name === 'Or' ? 'or' : 'and', operands };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Walks a query DATA term: `&T`, `&mut T`, `Option<..>`, `Ref`/`Mut` wrappers, and tuples. */
function queryData(node: Parser.SyntaxNode, optional: boolean, out: RawAccess[]): void {
  switch (node.type) {
    case 'tuple_type':
      for (const child of node.namedChildren) queryData(child, optional, out);
      return;

    case 'reference_type': {
      const inner = node.childForFieldName('type');
      if (!inner) return;
      // `&mut Mut<T>` / `&Ref<T>` are unusual but legal; unwrap to the component.
      queryTerm(inner, isMutableRef(node) ? 'readwrite' : 'read', optional, out);
      return;
    }

    case 'generic_type': {
      const name = baseName(node);
      if (name === 'Option') {
        for (const arg of typeArgs(node)) queryData(arg, true, out);
        return;
      }
      const wrapper = DATA_WRAPPERS[name];
      if (wrapper) {
        const [arg] = typeArgs(node);
        if (arg) queryTerm(arg, wrapper, optional, out);
        return;
      }
      if (NON_ACCESS_DATA.has(name)) return;
      // A bare generic component in data position, e.g. `Has<T>` handled above; anything
      // else is treated as a read of that type.
      queryTerm(node, 'read', optional, out);
      return;
    }

    case 'type_identifier':
    case 'scoped_type_identifier':
      if (NON_ACCESS_DATA.has(baseName(node))) return;
      queryTerm(node, 'read', optional, out);
      return;

    default:
      return;
  }
}

function queryTerm(node: Parser.SyntaxNode, mode: AccessMode, optional: boolean, out: RawAccess[]): void {
  const name = baseName(node);
  if (NON_ACCESS_DATA.has(name)) return;
  const wrapper = DATA_WRAPPERS[name];
  if (wrapper && node.type === 'generic_type') {
    const [arg] = typeArgs(node);
    if (arg) queryTerm(arg, wrapper, optional, out);
    return;
  }
  out.push({
    state: renderType(node),
    category: 'component',
    mode,
    optional,
    scoped: wasScoped(node),
  });
}

/**
 * Reads one parameter's declared access (DESIGN.md §7, pass 2).
 *
 * Custom `SystemParam` structs are expanded transitively through `registry`, guarded
 * against cycles by `expanding`. 1,017 such derives exist in the engine crates, so a
 * dialect that skipped them would silently under-report most real access.
 */
export function analyzeParam(
  typeNode: Parser.SyntaxNode,
  registry: SystemParamRegistry,
  expanding: ReadonlySet<string> = new Set(),
): ParamResult {
  const name = baseName(typeNode);

  if (EXCLUDED_PARAMS.has(name)) return { accesses: [] };

  if (STRUCTURAL_PARAMS.has(name)) {
    return {
      accesses: [
        { state: STRUCTURAL_STATE_ID, category: 'synthetic', mode: 'structural', optional: false, scoped: false },
      ],
    };
  }

  if (name === OBSERVER_PARAM) {
    const [arg] = typeArgs(typeNode);
    if (!arg) return { accesses: [] };
    const state = renderType(arg);
    return {
      observes: state,
      accesses: [{ state, category: 'event', mode: 'read', optional: false, scoped: wasScoped(arg) }],
    };
  }

  const resourceMode = RESOURCE_PARAMS[name];
  if (resourceMode !== undefined) {
    const [arg] = typeArgs(typeNode);
    if (!arg) return { accesses: [] };
    return {
      accesses: [
        { state: renderType(arg), category: 'resource', mode: resourceMode, optional: false, scoped: wasScoped(arg) },
      ],
    };
  }

  const messageMode = MESSAGE_PARAMS[name];
  if (messageMode !== undefined) {
    const [arg] = typeArgs(typeNode);
    if (!arg) return { accesses: [] };
    return {
      accesses: [
        { state: renderType(arg), category: 'message', mode: messageMode, optional: false, scoped: wasScoped(arg) },
      ],
    };
  }

  if (QUERY_PARAMS.has(name)) {
    const [data, filterTerm] = typeArgs(typeNode);
    if (!data) return { accesses: [] };
    const accesses: RawAccess[] = [];
    queryData(data, false, accesses);
    const filters = filterTerm ? parseFilters(filterTerm) : undefined;
    return { accesses: filters ? accesses.map((a) => ({ ...a, filters })) : accesses };
  }

  if (name === PARAMSET_PARAM) {
    const [inner] = typeArgs(typeNode);
    if (!inner) return { accesses: [] };
    const members = inner.type === 'tuple_type' ? inner.namedChildren : [inner];
    const accesses: RawAccess[] = [];
    for (const member of members) accesses.push(...analyzeParam(member, registry, expanding).accesses);
    return { accesses };
  }

  // Custom SystemParam: expand its fields (§7.2).
  const fields = registry.get(name);
  if (fields && !expanding.has(name)) {
    const nested = new Set([...expanding, name]);
    const accesses: RawAccess[] = [];
    for (const field of fields) {
      for (const access of analyzeParam(field, registry, nested).accesses) {
        // The OUTERMOST struct is what appears in the signature, so that is what the
        // Inspector should cite when explaining where an access came from.
        accesses.push({ ...access, viaParam: name });
      }
    }
    return { accesses };
  }

  // Unrecognised parameter: not declared state under §2, so it contributes nothing.
  return { accesses: [] };
}
