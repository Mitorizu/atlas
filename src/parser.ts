import Parser from 'tree-sitter';
import Rust from 'tree-sitter-rust';

/** A parser configured for the Rust grammar. Cheap to create; not thread-safe, so one per worker. */
export function createRustParser(): Parser {
  const parser = new Parser();
  parser.setLanguage(Rust);
  return parser;
}

/** Node-type metadata shipped with the grammar; the source of truth for query authoring. */
export interface NodeTypeInfo {
  type: string;
  named: boolean;
  fields?: Record<string, unknown>;
  subtypes?: Array<{ type: string; named: boolean }>;
}

export function rustNodeTypes(): NodeTypeInfo[] {
  const info = (Rust as { nodeTypeInfo?: NodeTypeInfo[] }).nodeTypeInfo;
  if (!info) throw new Error('tree-sitter-rust exposed no nodeTypeInfo; grammar package is unusable');
  return info;
}

export type { default as Parser } from 'tree-sitter';
