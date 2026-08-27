import { isMain } from '../is-main.ts';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { createRustParser } from '../parser.ts';
import { bevy019 } from '../dialects/bevy-0.19/index.ts';
import { buildGraph } from '../core/graph.ts';
import { layout, type LayoutedGraph } from '../layout/elk.ts';
import type { GroupMode } from '../layout/tiers.ts';
import { layoutScene, SCENE_VERSION, type Scene } from '../layout/scene.ts';
import { findAmbiguities, type AmbiguityReport } from '../analysis/ambiguity.ts';
import type { AtlasIR } from '../core/ir.ts';
import type { Coverage, SourceFile } from '../dialects/types.ts';
import type { FileFacts } from '../dialects/bevy-0.19/index.ts';

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
  coverage: Coverage;
  ambiguity: AmbiguityReport;
  ir: AtlasIR;
  layout: LayoutedGraph;
  /** One nested scene with progressive per-region reveal (§9.2). */
  scene: Scene;
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

export async function extractCorpus(root: string, groupMode: GroupMode = 'crate'): Promise<Artifact> {
  const parser = createRustParser();
  const rootIsFile = statSync(root).isFile();
  const files = rustFiles(root);
  const facts: FileFacts[] = [];
  let filesWithParseErrors = 0;

  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    const file: SourceFile = { path, modulePath: modulePathFor(root, path, rootIsFile), text };
    if (!bevy019.matches(file)) continue;
    const tree = parser.parse(text);
    if (tree.rootNode.hasError) filesWithParseErrors++;
    facts.push(bevy019.scan(tree, file));
  }

  const { output, coverage } = bevy019.link(facts);
  const ir: AtlasIR = { dialect: bevy019.id, ...output };
  const ambiguity = findAmbiguities(ir);
  const graph = buildGraph(ir);
  const positioned = await layout(graph);
  const scene = await layoutScene(graph, ir, groupMode);

  return {
    meta: {
      dialect: bevy019.id,
      corpus: resolve(root),
      extractedAt: new Date().toISOString(),
      files: files.length,
      filesWithParseErrors,
    },
    coverage,
    ambiguity,
    ir,
    layout: positioned,
    scene,
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

  const { ir, meta, coverage } = artifact;
  console.log(`dialect ${meta.dialect}  ${meta.files} file(s), ${meta.filesWithParseErrors} with parse errors`);
  console.log(`  executors ${ir.executors.length}  states ${ir.states.length}  accesses ${ir.accesses.length}`);
  console.log(
    `  scope: ${coverage.scopeResolved}/${coverage.executors} resolved` +
      (coverage.wholeRepoFallback ? ' (whole-repo fallback: no App::new found)' : '') +
      `  |  registrations ${coverage.registrationsResolved}/${coverage.registrations}` +
      `  |  plugins ${coverage.pluginsReachable}/${coverage.plugins} reachable`,
  );
  const { ambiguities, excludedForScope } = artifact.ambiguity;
  const pairs = new Set(ambiguities.map((a) => `${a.a}|${a.b}`)).size;
  console.log(
    `  ambiguities: ${pairs} unordered system pairs over ${ambiguities.length} state overlaps` +
      (excludedForScope > 0 ? `  (${excludedForScope} executors excluded: unresolved scope)` : ''),
  );
  for (const found of ambiguities.slice(0, 3)) {
    console.log(`    ${found.a.split('::').pop()} vs ${found.b.split('::').pop()} on ${found.stateId} [${found.schedule}]`);
  }

  const hubs = ir.states.filter((s) => s.ubiquitous);
  if (hubs.length > 0) {
    console.log(`  ubiquitous state demoted to badges: ${hubs.map((h) => h.display).slice(0, 8).join(', ')}` +
      (hubs.length > 8 ? ` +${hubs.length - 8} more` : ''));
  }
  if (coverage.unresolvedSamples.length > 0) {
    console.log(`  unresolved registrations e.g. ${coverage.unresolvedSamples.slice(0, 3).join(', ')}`);
  }
  console.log(
    `  scene v${SCENE_VERSION}: ${artifact.scene.regions.length} regions, ` +
      `${artifact.scene.shared.length} shared state, ` +
      `${Math.round(artifact.scene.width)}x${Math.round(artifact.scene.height)}`,
  );
  console.log(`  layout ${Math.round(artifact.layout.width)}x${Math.round(artifact.layout.height)} -> ${out}`);
}

if (isMain(import.meta.filename)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
