/**
 * The atlas intermediate representation (DESIGN.md §6).
 *
 * Three normalised tables plus a delta. Nothing downstream of a Dialect may reference
 * Rust, Bevy, or ECS concepts; this file is the entire contract between them.
 */

/** Fully-qualified, generic arguments included: `bevy_asset::Assets<Mesh>` (§6.2). */
export type StateId = string;
/** Keyed on (module path, function name, type arguments) — never on file path (§6.2). */
export type ExecutorId = string;

export type AccessMode =
  | 'read'
  | 'write'
  | 'readwrite'
  /** Unbounded mutation via `Commands`; targets the synthetic structural node (§7.4). */
  | 'structural'
  /** Declared dependency with undeclared direction; for DI-style dialects (§4.2). */
  | 'unknown';

export type StateCategory = 'component' | 'resource' | 'message' | 'event' | 'synthetic';

export interface SourceLoc {
  file: string;
  line: number;
  col: number;
  byteStart: number;
  byteEnd: number;
}

/** Recursive so `Or<(With<A>, Without<B>)>` nests correctly (§6). */
export type FilterExpr =
  | { kind: 'with' | 'without' | 'added' | 'changed'; state: StateId }
  | { kind: 'or' | 'and'; operands: FilterExpr[] };

export interface StateNode {
  id: StateId;
  display: string;
  category: StateCategory;
  declaredAt?: SourceLoc;
  /** Demoted to a badge on consumers rather than drawn as a node (§7.4). */
  ubiquitous: boolean;
  /** Key fell back to the terminal identifier because `use` resolution failed (§6.2). */
  ambiguousKey?: boolean;
}

export interface Registration {
  schedule: string;
  before: ExecutorId[];
  after: ExecutorId[];
  inSets: string[];
  chained: boolean;
  runConditions: string[];
  ambiguousWith?: ExecutorId[] | 'all';
  viaPlugin?: string;
}

export interface ExecutorNode {
  id: ExecutorId;
  display: string;
  kind: 'system' | 'observer' | 'closure';
  /** Turbofish at the registration site; part of identity (§6.2). */
  typeArgs?: string[];
  /** Type arguments are themselves generic params (`::<S>`) — excluded from §8. */
  genericUnresolved?: boolean;
  appScope: string;
  loc: SourceLoc;
  registration?: Registration;
  /** For `kind: 'observer'` — the `On<E>` type. */
  observes?: StateId;
  /** Signature qualifies but nothing ever registered it (§7). */
  unregistered: boolean;
  signature: string;
}

export interface Access {
  executorId: ExecutorId;
  stateId: StateId;
  mode: AccessMode;
  optional: boolean;
  filters?: FilterExpr;
  /** The custom `SystemParam` this access was expanded from (§7.2). */
  viaParam?: string;
  loc: SourceLoc;
}

export interface AtlasIR {
  dialect: string;
  rev?: string;
  executors: ExecutorNode[];
  states: StateNode[];
  accesses: Access[];
}

/** The synthetic node representing unbounded structural mutation via `Commands` (§7.4). */
export const STRUCTURAL_STATE_ID: StateId = '«structural»';

export function structuralStateNode(): StateNode {
  return {
    id: STRUCTURAL_STATE_ID,
    display: '«structural»',
    category: 'synthetic',
    ubiquitous: true,
  };
}

export function emptyIR(dialect: string): AtlasIR {
  return { dialect, executors: [], states: [], accesses: [] };
}
