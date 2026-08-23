/**
 * Extraction statistics over a corpus, without layout. Used as the Milestone 2 snapshot
 * guard: `npm run corpus:stats -- <path>`.
 */
import { isMain } from '../src/is-main.ts';
import { readFileSync, statSync } from 'node:fs';
import { createRustParser } from '../src/parser.ts';
import { bevy019 } from '../src/dialects/bevy-0.19/index.ts';
import { rustFiles, modulePathFor } from '../src/cli/extract.ts';
import type { Coverage, SourceFile } from '../src/dialects/types.ts';
import type { FileFacts } from '../src/dialects/bevy-0.19/index.ts';
import type { AtlasIR } from '../src/core/ir.ts';

export function extractIR(root: string): { ir: AtlasIR; files: number; parseErrors: number; coverage: Coverage } {
  const parser = createRustParser();
  const rootIsFile = statSync(root).isFile();
  const files = rustFiles(root);
  const facts: FileFacts[] = [];
  let parseErrors = 0;
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    const file: SourceFile = { path, modulePath: modulePathFor(root, path, rootIsFile), text };
    const tree = parser.parse(text);
    if (tree.rootNode.hasError) parseErrors++;
    facts.push(bevy019.scan(tree, file));
  }
  const { output, coverage } = bevy019.link(facts);
  return { ir: { dialect: bevy019.id, ...output }, files: files.length, parseErrors, coverage };
}

export function summarise(ir: AtlasIR) {
  const byKind = (k: string) => ir.executors.filter((e) => e.kind === k).length;
  const byCategory = (c: string) => ir.states.filter((s) => s.category === c).length;
  const byMode = (m: string) => ir.accesses.filter((a) => a.mode === m).length;
  return {
    executors: ir.executors.length,
    systems: byKind('system'),
    observers: byKind('observer'),
    closures: byKind('closure'),
    registered: ir.executors.filter((e) => !e.unregistered).length,
    unregistered: ir.executors.filter((e) => e.unregistered).length,
    generic: ir.executors.filter((e) => e.typeArgs !== undefined).length,
    states: ir.states.length,
    components: byCategory('component'),
    resources: byCategory('resource'),
    messages: byCategory('message'),
    events: byCategory('event'),
    accesses: ir.accesses.length,
    reads: byMode('read'),
    writes: byMode('write'),
    readwrites: byMode('readwrite'),
    structural: byMode('structural'),
    withFilters: ir.accesses.filter((a) => a.filters !== undefined).length,
    viaSystemParam: ir.accesses.filter((a) => a.viaParam !== undefined).length,
    optional: ir.accesses.filter((a) => a.optional).length,
    setOrderings: ir.setOrderings.length,
    ubiquitous: ir.states.filter((s) => s.ubiquitous).length,
    scopeResolved: ir.executors.filter((e) => e.appScopes.length > 0).length,
    ordered: ir.executors.filter((e) => (e.registration?.before.length ?? 0) + (e.registration?.after.length ?? 0) > 0).length,
    runConditions: ir.executors.filter((e) => (e.registration?.runConditions.length ?? 0) > 0).length,
    inSets: ir.executors.filter((e) => (e.registration?.inSets.length ?? 0) > 0).length,
    suppressed: ir.executors.filter((e) => e.registration?.ambiguousWith !== undefined).length,
  };
}

if (isMain(import.meta.filename)) {
  const target = process.argv[2];
  if (!target) { console.error('usage: corpus-stats <path>'); process.exit(2); }
  const started = Date.now();
  const { ir, files, parseErrors } = extractIR(target);
  const stats = summarise(ir);
  console.log(`${files} files, ${parseErrors} with parse errors, ${Date.now() - started}ms`);
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k.padEnd(16)} ${v}`);
}
