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

/**
 * The only framework-aware code in atlas (DESIGN.md §4.2). Nothing downstream may
 * reference Rust, Bevy, or ECS concepts.
 */
export interface Dialect {
  readonly id: string;
  readonly language: 'rust';
  matches(file: SourceFile): boolean;
  extract(tree: Parser.Tree, file: SourceFile): DialectOutput;
}
