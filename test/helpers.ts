import { readFileSync } from 'node:fs';
import { createRustParser } from '../src/parser.ts';
import { bevy019 } from '../src/dialects/bevy-0.19/index.ts';
import type { DialectOutput, LinkResult, SourceFile } from '../src/dialects/types.ts';

/** Scan + link a single source string, as one file. */
export function extractSource(src: string, modulePath = 'x'): DialectOutput {
  const file: SourceFile = { path: `${modulePath}.rs`, modulePath, text: src };
  return bevy019.link([bevy019.scan(createRustParser().parse(src), file)]).output;
}

/** Scan + link several files, as a corpus. */
export function extractFiles(files: Array<{ path: string; modulePath: string }>): LinkResult {
  const parser = createRustParser();
  return bevy019.link(
    files.map((f) => {
      const text = readFileSync(f.path, 'utf8');
      return bevy019.scan(parser.parse(text), { ...f, text });
    }),
  );
}

/** Scan + link several in-memory sources, as a corpus. */
export function extractSources(sources: Record<string, string>): LinkResult {
  const parser = createRustParser();
  return bevy019.link(
    Object.entries(sources).map(([modulePath, text]) =>
      bevy019.scan(parser.parse(text), { path: `${modulePath}.rs`, modulePath, text }),
    ),
  );
}
