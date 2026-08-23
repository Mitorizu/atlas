import { isMain } from '../is-main.ts';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { createRustParser } from '../parser.ts';
import { bevy019 } from '../dialects/bevy-0.19/index.ts';
import { mergeOutputs } from '../core/build.ts';
import { buildGraph } from '../core/graph.ts';
import { layout, type LayoutedGraph } from '../layout/elk.ts';
import type { AtlasIR } from '../core/ir.ts';
import type { DialectOutput, SourceFile } from '../dialects/types.ts';

const SKIP_DIRS = new Set(['target', '.git', 'node_modules', '.cache', 'dist']);

export interface Artifact {
  meta: {
    dialect: string;
    corpus: string;
    extractedAt: string;
    files: number;
    /** Files the grammar could not fully parse; recovery is local (§7.6). */
    filesWithParseErrors: number;
  };
  ir: AtlasIR;
  layout: LayoutedGraph;
}

export function rustFiles(root: string): string[] {
  if (statSync(root).isFile()) return [root];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.name.endsWith('.rs')) {
        out.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return out.sort();
}

/**
 * `2d/move_sprite.rs` under the corpus root becomes module path `2d::move_sprite`.
 * Pure: `rootIsFile` is resolved once by the caller rather than stat'ed per file.
 */
export function modulePathFor(root: string, file: string, rootIsFile: boolean): string {
  const rel = rootIsFile ? file.split(sep).pop()! : relative(root, file);
  return rel.replace(/\.rs$/, '').split(sep).join('::');
}

export async function extractCorpus(root: string): Promise<Artifact> {
  const parser = createRustParser();
  const rootIsFile = statSync(root).isFile();
  const files = rustFiles(root);
  const outputs: DialectOutput[] = [];
  let filesWithParseErrors = 0;

  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    const file: SourceFile = { path, modulePath: modulePathFor(root, path, rootIsFile), text };
    if (!bevy019.matches(file)) continue;
    const tree = parser.parse(text);
    if (tree.rootNode.hasError) filesWithParseErrors++;
    outputs.push(bevy019.extract(tree, file));
  }

  const ir = mergeOutputs(bevy019.id, outputs);
  const positioned = await layout(buildGraph(ir));

  return {
    meta: {
      dialect: bevy019.id,
      corpus: resolve(root),
      extractedAt: new Date().toISOString(),
      files: files.length,
      filesWithParseErrors,
    },
    ir,
    layout: positioned,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outFlag = args.indexOf('-o');
  const out = outFlag >= 0 ? args[outFlag + 1] : 'src/web/public/graph.json';
  const positional = args.filter((a, i) => !a.startsWith('-') && !(outFlag >= 0 && i === outFlag + 1));
  const target = positional[0];

  if (!target || !out) {
    console.error('usage: atlas extract <path> [-o graph.json]');
    process.exit(2);
  }

  const artifact = await extractCorpus(target);
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify(artifact, null, 2) + '\n');

  const { ir, meta } = artifact;
  console.log(`dialect ${meta.dialect}  ${meta.files} file(s), ${meta.filesWithParseErrors} with parse errors`);
  console.log(`  executors ${ir.executors.length}  states ${ir.states.length}  accesses ${ir.accesses.length}`);
  console.log(`  layout ${Math.round(artifact.layout.width)}x${Math.round(artifact.layout.height)} -> ${out}`);
}

if (isMain(import.meta.filename)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
