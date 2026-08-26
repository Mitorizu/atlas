import { mkdtempSync, mkdirSync, writeFileSync, watch } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isMain } from '../is-main.ts';
import { GitError } from '../git/repo.ts';
import { buildFocusArtifact, formatDelta, runDiff } from './diff.ts';
import { extractCorpus } from './extract.ts';
import type { GroupMode } from '../layout/tiers.ts';
import { serve } from './serve.ts';

/**
 * The `atlas` command (DESIGN.md §5).
 *
 *   atlas diff [<rev>..<rev>] [--view] [--hops N] [--json]
 *   atlas map <path>
 *   atlas extract <path> [-o graph.json]
 *   atlas serve <graph.json>
 *
 * `--view` on diff and map extracts, serves, and prints a URL, so reviewing a change is
 * one command from any directory.
 */

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLE_DIR = join(PACKAGE_ROOT, 'dist', 'web');

const USAGE = `atlas - map who touches what state, and what a change did to it

  atlas diff [<rev>..<rev>]   compare against HEAD (default: working tree)
  atlas map <path>            whole-codebase orientation view
  atlas extract <path>        write an artifact without serving
  atlas serve <graph.json>    serve an existing artifact

Options
  -C <dir>        run as if started in <dir> (like git -C); default: cwd
  --view          serve the result and print a URL (diff, map)
  --hops N        focus expansion distance (default 2)
  --json          print the delta as JSON (diff)
  -o <path>       artifact output path
  --port N        port for --view / serve (default: an unused one)
  --watch         re-extract when files change (with --view)
  --group MODE    map regions: 'crate' (default) or 'cluster' (map)
`;

export function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('-')) {
      if (['-o', '--hops', '--port', '-C', '--group'].includes(arg)) i++; // skip the value
      continue;
    }
    out.push(arg);
  }
  return out;
}

/**
 * Re-extracts when Rust files change. Debounced, because an editor save and a formatter
 * run land as several events within milliseconds and each rebuild walks the whole corpus.
 */
function watchRepo(root: string, rebuild: () => Promise<void>): void {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const trigger = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (running) return;
      running = true;
      const started = Date.now();
      rebuild()
        .then(() => console.log(`  rebuilt in ${Date.now() - started}ms`))
        .catch((error: unknown) => console.error(`  rebuild failed: ${String(error)}`))
        .finally(() => {
          running = false;
        });
    }, 250);
  };

  try {
    watch(root, { recursive: true }, (_event, filename) => {
      if (filename && filename.toString().endsWith('.rs')) trigger();
    });
    console.log('  watching for .rs changes');
  } catch {
    console.error('  --watch unavailable on this platform; continuing without it');
  }
}

async function serveArtifact(path: string, port: number | undefined): Promise<void> {
  const running = await serve({ bundleDir: BUNDLE_DIR, artifactPath: path, ...(port ? { port } : {}) });
  console.log(`\n  viewer ready at ${running.url}`);
  console.log('  press Ctrl+C to stop');
  const stop = (): void => {
    void running.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

export async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = argv.slice(1);
  const rest = positionals(args);
  const port = flagValue(args, '--port') ? Number(flagValue(args, '--port')) : undefined;
  const view = args.includes('--view');
  // `-C` mirrors `git -C`; ATLAS_DIR stays as a fallback for scripted use.
  const workdir = resolve(flagValue(args, '-C') ?? process.env['ATLAS_DIR'] ?? process.cwd());

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    return;
  }

  const defaultOut = (name: string): string => join(mkdtempSync(join(tmpdir(), 'atlas-')), name);

  switch (command) {
    case 'diff': {
      const result = runDiff(workdir, rest[0]);
      if (args.includes('--json')) {
        console.log(JSON.stringify(result.delta, null, 2));
        return;
      }
      for (const line of formatDelta(result)) console.log(line);
      if (!view) return;

      const hops = flagValue(args, '--hops') ? Number(flagValue(args, '--hops')) : 2;
      const out = flagValue(args, '-o') ?? defaultOut('diff.json');
      mkdirSync(dirname(out), { recursive: true });

      const rebuild = async (): Promise<void> => {
        const fresh = runDiff(workdir, rest[0]);
        const artifact = await buildFocusArtifact(fresh, hops);
        writeFileSync(out, JSON.stringify(artifact) + '\n');
        return;
      };

      const artifact = await buildFocusArtifact(result, hops);
      writeFileSync(out, JSON.stringify(artifact) + '\n');
      console.log(`  focus: ${artifact.layout.nodes.length} nodes within ${hops} hop(s) of the change`);

      if (args.includes('--watch')) watchRepo(workdir, rebuild);
      await serveArtifact(out, port);
      return;
    }

    case 'map':
    case 'extract': {
      const target = rest[0];
      if (target === undefined) {
        console.error(`usage: atlas ${command} <path>`);
        process.exit(2);
      }
      const out = flagValue(args, '-o') ?? defaultOut('map.json');
      const requested = flagValue(args, '--group') ?? 'crate';
      if (requested !== 'crate' && requested !== 'cluster') {
        console.error(`--group must be 'crate' or 'cluster', got '${requested}'`);
        process.exit(2);
      }
      const artifact = await extractCorpus(resolve(workdir, target), requested as GroupMode);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(artifact) + '\n');
      console.log(
        `${artifact.meta.files} file(s)  ${artifact.ir.executors.length} executors  ` +
          `${artifact.ir.states.length} state  ${artifact.tiers.street.groups.length} ${requested} regions  -> ${out}`,
      );
      if (command === 'map' || view) await serveArtifact(out, port);
      return;
    }

    case 'serve': {
      const target = rest[0];
      if (target === undefined) {
        console.error('usage: atlas serve <graph.json>');
        process.exit(2);
      }
      await serveArtifact(resolve(target), port);
      return;
    }

    default:
      console.error(`unknown command: ${command}\n`);
      console.log(USAGE);
      process.exit(2);
  }
}

/** Entry point. Exported because `bin/atlas.mjs` imports this module rather than being it. */
export function cli(): void {
  run().catch((error: unknown) => {
    console.error(error instanceof GitError || error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

if (isMain(import.meta.filename)) cli();
