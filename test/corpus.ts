import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Locates the pinned Bevy 0.19 corpus in the local Cargo registry cache (DESIGN.md §3).
 * Returns null when absent so the suite degrades to a clear skip rather than a failure
 * on a machine that has never built Bevy.
 */
export function findBevyExamples(): string | null {
  const base = join(homedir(), '.cargo', 'registry', 'src');
  if (!existsSync(base)) return null;
  for (const registry of readdirSync(base)) {
    const dir = join(base, registry, 'bevy-0.19.0', 'examples');
    if (existsSync(dir)) return dir;
  }
  return null;
}

export function rustFilesUnder(dir: string, limit: number): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (out.length >= limit) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (out.length >= limit) return;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.rs')) out.push(p);
    }
  };
  walk(dir);
  return out;
}
