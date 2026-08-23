import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMain } from '../is-main.ts';
import {
  GitError,
  changedFiles,
  isGitRepo,
  parseRevSpec,
  readBlobsAtRev,
  repoRoot,
  resolveRev,
  rustFilesAtRev,
} from '../git/repo.ts';
import { extractSources } from '../core/pipeline.ts';
import { computeDelta, type GraphDelta } from '../core/delta.ts';
import { readCachedIR, writeCachedIR } from './cache.ts';
import { bevy019 } from '../dialects/bevy-0.19/index.ts';
import type { AtlasIR } from '../core/ir.ts';
import { buildFocus, type FocusResult } from '../core/focus.ts';
import { buildGraph } from '../core/graph.ts';
import { layout } from '../layout/elk.ts';

export interface DiffResult {
  delta: GraphDelta;
  base: AtlasIR;
  head: AtlasIR;
  changed: string[];
  baseFromCache: boolean;
  repoRoot: string;
}

/**
 * The artefact the viewer loads for a review (DESIGN.md §9.1). `mode` lets one viewer
 * render either this or a whole-codebase map.
 */
export interface FocusArtifact {
  meta: {
    mode: 'focus';
    dialect: string;
    repoRoot: string;
    base: string;
    head: string;
    changedFiles: string[];
    hops: number;
  };
  focus: Omit<FocusResult, 'ir'>;
  delta: GraphDelta;
  ir: AtlasIR;
  layout: Awaited<ReturnType<typeof layout>>;
}

/** Builds the focus subgraph and lays it out for the viewer. */
export async function buildFocusArtifact(result: DiffResult, hops = 2): Promise<FocusArtifact> {
  const focus = buildFocus(result.base, result.head, result.delta, { hops });
  const { ir, ...rest } = focus;

  // The state a review is ABOUT must stay visible even when it is a corpus-wide hub.
  const keepHubs = new Set<string>();
  for (const found of result.delta.ambiguities.introduced) keepHubs.add(found.stateId);
  for (const id of rest.seeds) keepHubs.add(id);

  const positioned = await layout(buildGraph(ir, { keepHubs }));
  return {
    meta: {
      mode: 'focus',
      dialect: ir.dialect,
      repoRoot: result.repoRoot,
      base: result.delta.base.rev,
      head: result.delta.head.rev,
      changedFiles: result.changed,
      hops,
    },
    focus: rest,
    delta: result.delta,
    ir,
    layout: positioned,
  };
}

/** Reads a whole tree at a revision through git plumbing; never touches the working tree. */
function irAtRev(root: string, rev: string, sha: string, useCache: boolean): { ir: AtlasIR; cached: boolean } {
  if (useCache) {
    const cached = readCachedIR(root, bevy019.id, sha);
    if (cached) return { ir: cached, cached: true };
  }
  const paths = rustFilesAtRev(root, rev);
  const blobs = readBlobsAtRev(root, rev, paths);
  const { ir } = extractSources([...blobs].map(([path, text]) => ({ path, text })));
  if (useCache) writeCachedIR(root, bevy019.id, sha, ir);
  return { ir, cached: false };
}

/** Reads the working tree: tracked files from disk, so uncommitted edits are included. */
function irAtWorkingTree(root: string, headRev: string): AtlasIR {
  const tracked = rustFilesAtRev(root, headRev);
  const untracked = changedFiles(root, headRev, null);
  const paths = [...new Set([...tracked, ...untracked])];
  const sources: Array<{ path: string; text: string }> = [];
  for (const path of paths) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) continue; // deleted in the working tree
    sources.push({ path, text: readFileSync(absolute, 'utf8') });
  }
  return extractSources(sources).ir;
}

export function runDiff(dir: string, revArg: string | undefined, useCache = true): DiffResult {
  if (!isGitRepo(dir)) throw new GitError(`not a git repository: ${dir}`);
  const root = repoRoot(dir);
  const { baseRef, headRef } = parseRevSpec(revArg);

  const baseSha = resolveRev(root, baseRef);
  const { ir: base, cached } = irAtRev(root, baseSha, baseSha, useCache);

  let head: AtlasIR;
  let headLabel: string;
  if (headRef === null) {
    head = irAtWorkingTree(root, baseSha);
    headLabel = 'working tree';
  } else {
    const headSha = resolveRev(root, headRef);
    head = irAtRev(root, headSha, headSha, useCache).ir;
    headLabel = headSha.slice(0, 8);
  }

  return {
    delta: computeDelta(base, head, { base: baseSha.slice(0, 8), head: headLabel }),
    base,
    head,
    changed: changedFiles(root, baseSha, headRef === null ? null : resolveRev(root, headRef)),
    baseFromCache: cached,
    repoRoot: root,
  };
}

function short(id: string): string {
  return id.split('::').slice(-2).join('::');
}

export function formatDelta(result: DiffResult): string[] {
  const { delta, changed, baseFromCache } = result;
  const lines: string[] = [];
  lines.push(`${delta.base.rev} -> ${delta.head.rev}   ${changed.length} Rust file(s) changed${baseFromCache ? '  (base cached)' : ''}`);

  const { added, removed, modified, moved } = delta.executors;
  lines.push(
    `  systems  +${added.length} -${removed.length} ~${modified.length}` +
      (moved.length > 0 ? ` (${moved.length} moved)` : ''),
  );
  lines.push(
    `  state    +${delta.states.added.length} -${delta.states.removed.length}` +
      `   access +${delta.accesses.added.length} -${delta.accesses.removed.length}`,
  );

  for (const change of delta.accesses.modeChanged) {
    lines.push(`  ACCESS WIDENED  ${short(change.executorId)}: ${change.stateId} ${change.from} -> ${change.to}`);
  }

  const { introduced, resolved, persisting } = delta.ambiguities;
  if (introduced.length > 0) {
    lines.push(`  ${introduced.length} AMBIGUITY INTRODUCED:`);
    for (const found of introduced.slice(0, 10)) {
      lines.push(`    ${short(found.a)} vs ${short(found.b)} on ${found.stateId} [${found.schedule}]`);
    }
    if (introduced.length > 10) lines.push(`    ... and ${introduced.length - 10} more`);
  } else {
    lines.push('  no new ambiguities');
  }
  if (resolved.length > 0) lines.push(`  ${resolved.length} ambiguity resolved`);
  if (persisting.length > 0) lines.push(`  ${persisting.length} pre-existing (unchanged)`);
  return lines;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonFlag = args.includes('--json');
  const viewFlag = args.includes('--view');
  const hopsArg = args.indexOf('--hops');
  const hops = hopsArg >= 0 ? Number(args[hopsArg + 1] ?? 2) : 2;
  const outArg = args.indexOf('-o');
  const out = outArg >= 0 ? args[outArg + 1] : 'src/web/public/graph.json';
  const positional = args.filter(
    (a, i) => !a.startsWith('-') && i !== outArg + 1 && i !== hopsArg + 1,
  );
  const dir = process.env['ATLAS_DIR'] ?? process.cwd();

  try {
    const result = runDiff(dir, positional[0]);

    if (viewFlag) {
      if (!out) throw new Error('-o requires a path');
      const artifact = await buildFocusArtifact(result, hops);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(artifact, null, 2) + '\n');
      for (const line of formatDelta(result)) console.log(line);
      const nodes = artifact.layout.nodes.length;
      console.log(
        `  focus: ${nodes} nodes within ${hops} hop(s) of the change ` +
          `(of ${artifact.focus.totalExecutors} executors) -> ${out}`,
      );
      console.log('  view with: npm run dev');
      return;
    }

    if (jsonFlag) console.log(JSON.stringify(result.delta, null, 2));
    else for (const line of formatDelta(result)) console.log(line);
  } catch (error) {
    console.error(error instanceof GitError ? error.message : error);
    process.exit(1);
  }
}

if (isMain(import.meta.filename)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
