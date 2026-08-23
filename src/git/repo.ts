import { execFileSync } from 'node:child_process';

/**
 * Read-only git plumbing (DESIGN.md §5).
 *
 * The base revision is read with `cat-file --batch` rather than checked out: no worktree,
 * no stash, the working tree is never touched. Nothing here writes to the repository.
 */

export class GitError extends Error {}

function git(dir: string, args: string[], input?: string): Buffer {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      input,
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new GitError(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

export function isGitRepo(dir: string): boolean {
  try {
    return git(dir, ['rev-parse', '--is-inside-work-tree']).toString().trim() === 'true';
  } catch {
    return false;
  }
}

export function repoRoot(dir: string): string {
  return git(dir, ['rev-parse', '--show-toplevel']).toString().trim();
}

/** Resolves a revision to a full SHA; the SHA is what the base-graph cache is keyed on. */
export function resolveRev(dir: string, rev: string): string {
  return git(dir, ['rev-parse', '--verify', `${rev}^{commit}`]).toString().trim();
}

/** Repo-relative paths of Rust files present at a revision. */
export function rustFilesAtRev(dir: string, rev: string): string[] {
  return git(dir, ['ls-tree', '-r', '--name-only', '-z', rev])
    .toString()
    .split('\0')
    .filter((p) => p.endsWith('.rs'));
}

/**
 * Reads many blobs in one `cat-file --batch` call.
 *
 * Batch output per entry is `<oid> <type> <size>\n<payload>\n`, or `<name> missing\n`.
 * Parsing is done over the Buffer because sizes are byte counts, not character counts.
 */
export function readBlobsAtRev(dir: string, rev: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;

  const buffer = git(dir, ['cat-file', '--batch'], paths.map((p) => `${rev}:${p}`).join('\n') + '\n');
  let offset = 0;
  for (const path of paths) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline === -1) break;
    const header = buffer.toString('utf8', offset, newline);
    offset = newline + 1;

    const parts = header.split(' ');
    const size = Number(parts[2]);
    if (parts[1] !== 'blob' || !Number.isFinite(size)) continue; // missing / not a blob
    out.set(path, buffer.toString('utf8', offset, offset + size));
    offset += size + 1; // payload plus the trailing newline
  }
  return out;
}

/** Paths that differ between two trees, or between a tree and the working tree. */
export function changedFiles(dir: string, baseRev: string, headRev: string | null): string[] {
  const args = headRev === null ? ['diff', '--name-only', '-z', baseRev] : ['diff', '--name-only', '-z', baseRev, headRev];
  const tracked = git(dir, args).toString().split('\0').filter(Boolean);
  if (headRev !== null) return tracked.filter((p) => p.endsWith('.rs'));

  // Untracked files are part of "the working tree" for review purposes.
  const untracked = git(dir, ['ls-files', '--others', '--exclude-standard', '-z'])
    .toString()
    .split('\0')
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])].filter((p) => p.endsWith('.rs'));
}

export interface RevSpec {
  base: string;
  /** null means "the working tree", the default and the case that matters for review. */
  head: string | null;
}

/**
 * Parses the `atlas diff` revision argument.
 *
 * Bare `atlas diff` compares the working tree against HEAD — the moment you review code
 * an assistant just wrote, before any commit exists.
 */
export function parseRevSpec(arg: string | undefined): { baseRef: string; headRef: string | null } {
  if (arg === undefined) return { baseRef: 'HEAD', headRef: null };
  const dots = arg.indexOf('..');
  if (dots === -1) return { baseRef: arg, headRef: null };
  const baseRef = arg.slice(0, dots);
  const headRef = arg.slice(dots + 2).replace(/^\./, '');
  return { baseRef: baseRef || 'HEAD', headRef: headRef || null };
}
