import type Parser from 'tree-sitter';
import type { Access, ExecutorNode, SetOrdering, StateNode } from '../core/ir.ts';

export interface SourceFile {
  /** Path as atlas was given it, used for SourceLoc and display. */
  path: string;
  /** Rust module path derived from the file's position, e.g. `crate::player::movement`. */
  modulePath: string;
  text: string;
}

/** What one dialect produces from one file. Merged into an AtlasIR by the graph builder. */
export interface DialectOutput {
  executors: ExecutorNode[];
  states: StateNode[];
  accesses: Access[];
  setOrderings: SetOrdering[];
}

/** How much of the corpus resolution actually succeeded (§7.3). */
export interface Coverage {
  files: number;
  executors: number;
  scopeResolved: number;
  scopeUnresolved: number;
  registrations: number;
  registrationsResolved: number;
  plugins: number;
  pluginsReachable: number;
  appRoots: string[];
  /** True when no `App::new()` existed anywhere and the whole repo became one scope. */
  wholeRepoFallback: boolean;
  unresolvedSamples: string[];
}

export interface LinkResult {
  output: DialectOutput;
  coverage: Coverage;
}

/**
 * The only framework-aware code in atlas (DESIGN.md §4.2). Nothing downstream may
 * reference Rust, Bevy, or ECS concepts.
 *
 * Extraction is two-phase because resolution is inherently whole-corpus: which App a
 * system belongs to depends on a plugin graph that spans files (§7.3). `scan` gathers
 * per-file facts; `link` resolves them into an IR.
 */
export interface Dialect<Facts = unknown> {
  readonly id: string;
  readonly language: 'rust';
  matches(file: SourceFile): boolean;
  scan(tree: Parser.Tree, file: SourceFile): Facts;
  link(facts: Facts[]): LinkResult;
}
