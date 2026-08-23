import { createRustParser } from '../parser.ts';
import { bevy019 } from '../dialects/bevy-0.19/index.ts';
import type { FileFacts } from '../dialects/bevy-0.19/index.ts';
import type { Coverage, SourceFile } from '../dialects/types.ts';
import type { AtlasIR } from './ir.ts';

export interface ExtractResult {
  ir: AtlasIR;
  coverage: Coverage;
  parseErrors: number;
}

/**
 * Repo-relative path to Rust module path: `src/player/movement.rs` -> `src::player::movement`.
 *
 * Both sides of a diff must derive module paths the same way and from repo-relative
 * paths. Mixing absolute and relative would change every ExecutorId between base and
 * head, and the entire diff would read as removed-and-added.
 */
export function modulePathFromRepoPath(repoRelative: string): string {
  return repoRelative.replace(/\.rs$/, '').split('/').join('::');
}

/** Scan + link a set of in-memory sources. Used for both the working tree and a git tree. */
export function extractSources(sources: Array<{ path: string; text: string }>): ExtractResult {
  const parser = createRustParser();
  const facts: FileFacts[] = [];
  let parseErrors = 0;

  for (const source of sources) {
    const file: SourceFile = {
      path: source.path,
      modulePath: modulePathFromRepoPath(source.path),
      text: source.text,
    };
    if (!bevy019.matches(file)) continue;
    const tree = parser.parse(source.text);
    if (tree.rootNode.hasError) parseErrors++;
    facts.push(bevy019.scan(tree, file));
  }

  const { output, coverage } = bevy019.link(facts);
  return { ir: { dialect: bevy019.id, ...output }, coverage, parseErrors };
}
