import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AtlasIR } from '../core/ir.ts';

/**
 * Base-graph cache, keyed by commit SHA (DESIGN.md §5).
 *
 * This is correctness-adjacent rather than a pure optimisation: an "introduced" conflict
 * requires the whole base graph, so every diff would otherwise re-extract the entire
 * corpus. A commit's tree is immutable, so the SHA is a sound cache key.
 */
export function cacheDir(repoRoot: string): string {
  return join(repoRoot, '.cache', 'atlas');
}

function cachePath(repoRoot: string, dialect: string, sha: string): string {
  return join(cacheDir(repoRoot), `${dialect}-${sha}.json`);
}

export function readCachedIR(repoRoot: string, dialect: string, sha: string): AtlasIR | null {
  const path = cachePath(repoRoot, dialect, sha);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AtlasIR;
  } catch {
    // A truncated or stale-format entry is a cache miss, never a failure.
    return null;
  }
}

export function writeCachedIR(repoRoot: string, dialect: string, sha: string, ir: AtlasIR): void {
  mkdirSync(cacheDir(repoRoot), { recursive: true });
  writeFileSync(cachePath(repoRoot, dialect, sha), JSON.stringify(ir));
}
