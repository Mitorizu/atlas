import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AtlasIR } from '../core/ir.ts';

/**
 * Base-graph cache, keyed by commit SHA **and an extractor fingerprint** (DESIGN.md §5).
 *
 * The SHA alone is not a sound key. A commit's tree is immutable, but the IR derived from
 * it is not: change the extractor and the cached base no longer matches what the head side
 * would produce. Found at M6 — a parser fix made the head see two registrations the cached
 * base had missed, and atlas reported three ambiguities that did not exist. For a tool
 * whose output is review findings, a stale cache is worse than no cache.
 *
 * Rather than a hand-maintained version constant (the discipline that just failed), the
 * fingerprint is a hash of the extraction sources themselves, so it invalidates on its own.
 */

const SOURCE_ROOTS = ['dialects', 'core/ir.ts', 'core/pipeline.ts', 'analysis'];

let fingerprintCache: string | null = null;

function hashPath(hash: ReturnType<typeof createHash>, path: string): void {
  if (!existsSync(path)) return;
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path).sort()) hashPath(hash, join(path, entry));
    return;
  }
  if (!path.endsWith('.ts')) return;
  hash.update(path);
  hash.update(readFileSync(path));
}

/** Short hash of the code that produces an IR. Computed once per process. */
export function extractorFingerprint(): string {
  if (fingerprintCache !== null) return fingerprintCache;
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const hash = createHash('sha256');
  for (const relative of SOURCE_ROOTS) hashPath(hash, join(srcDir, relative));
  fingerprintCache = hash.digest('hex').slice(0, 12);
  return fingerprintCache;
}

export function cacheDir(repoRoot: string): string {
  return join(repoRoot, '.cache', 'atlas');
}

function cachePath(repoRoot: string, dialect: string, sha: string): string {
  return join(cacheDir(repoRoot), `${dialect}-${extractorFingerprint()}-${sha}.json`);
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
