import type Parser from 'tree-sitter';
import type { Dialect, LinkResult, SourceFile } from '../types.ts';
import type { FileFacts } from './facts.ts';
import { scanFile } from './scan.ts';
import { linkFacts } from './link.ts';

/**
 * Bevy 0.19 dialect (DESIGN.md §7).
 *
 *   scan  — pass 1 declarations, pass 2 candidates (SystemParams expanded),
 *           pass 3 registration with §7.6 propagation, and the raw plugin-graph edges.
 *   link  — pass 4: binds registrations across files, walks `add_plugins` from every
 *           `App::new()` root so plugin-registered systems get a real scope, unifies
 *           state keys (§6.2), and reports coverage.
 */
export const bevy019: Dialect<FileFacts> = {
  id: 'bevy-0.19',
  language: 'rust',

  matches(file: SourceFile): boolean {
    return file.path.endsWith('.rs');
  },

  scan(tree: Parser.Tree, file: SourceFile): FileFacts {
    return scanFile(tree, file);
  },

  link(facts: FileFacts[]): LinkResult {
    return linkFacts(this.id, facts);
  },
};

export { WHOLE_REPO_SCOPE } from './link.ts';
export type { FileFacts } from './facts.ts';
