/**
 * Node kinds and fields the Bevy 0.19 dialect's queries depend on.
 *
 * DESIGN.md §7 requires that grammar node names are never guessed. This contract is
 * verified against the `nodeTypeInfo` shipped with tree-sitter-rust (see
 * scripts/grammar-report.ts and test/grammar.test.ts), so a grammar upgrade that
 * renames or removes a node fails loudly here rather than silently emitting an
 * empty graph.
 *
 * Each entry lists the fields the extractor reads from that node.
 */
export const REQUIRED_NODES: Readonly<Record<string, readonly string[]>> = {
  // ---- declarations (pass 1) -------------------------------------------------
  source_file: [],
  function_item: ['name', 'parameters', 'body', 'type_parameters'],
  struct_item: ['name', 'body'],
  enum_item: ['name'],
  impl_item: ['trait', 'type', 'body'],
  declaration_list: [],
  attribute_item: [],
  attribute: [],
  use_declaration: ['argument'],
  mod_item: ['name', 'body'],
  token_tree: [],
  field_declaration_list: [],
  field_declaration: ['name', 'type'],
  type_parameters: [],

  // ---- parameter types (pass 2) ---------------------------------------------
  parameters: [],
  parameter: ['pattern', 'type'],
  generic_type: ['type', 'type_arguments'],
  type_arguments: [],
  type_identifier: [],
  scoped_type_identifier: ['path', 'name'],
  reference_type: ['type'],
  tuple_type: [],
  mutable_specifier: [],
  lifetime: [],

  // ---- registration sites (pass 3 / §7.6) -----------------------------------
  call_expression: ['function', 'arguments'],
  field_expression: ['value', 'field'],
  field_identifier: [],
  arguments: [],
  tuple_expression: [],
  parenthesized_expression: [],
  identifier: [],
  scoped_identifier: ['path', 'name'],
  generic_function: ['function', 'type_arguments'],
  closure_expression: ['parameters', 'body'],
  closure_parameters: [],
} as const;

/** Node kinds that carry `&`/`&mut` distinction, per observed grammar shape. */
export const MUTABILITY_MARKER = 'mutable_specifier';

/** Turbofish at a registration site: `trigger_animation::<RightSprite>` (§6.2). */
export const TURBOFISH_NODE = 'generic_function';
