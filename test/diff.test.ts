import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseRevSpec, readBlobsAtRev, rustFilesAtRev, resolveRev } from '../src/git/repo.ts';
import { extractSources, modulePathFromRepoPath } from '../src/core/pipeline.ts';
import { computeDelta, pairMoves } from '../src/core/delta.ts';
import { runDiff } from '../src/cli/diff.ts';
import { cacheDir, extractorFingerprint } from '../src/cli/cache.ts';
import { readdirSync, renameSync } from 'node:fs';

const repos: string[] = [];
after(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-diff-'));
  repos.push(dir);
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'test']);
  write(dir, files);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'base']);
  return dir;
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    const absolute = join(dir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }
}

const GAME = (ordering: string, scoreParam: string) => `use bevy::prelude::*;
#[derive(Component)] pub struct Health(u32);
#[derive(Resource)] pub struct Score(u32);
fn damage(q: Query<&mut Health>) {}
fn report(q: Query<&Health>) {}
fn tally(r: ${scoreParam}<Score>) {}
fn main() { App::new().add_systems(Update, (damage, ${ordering}, tally)).run(); }
`;

const ORDERED = GAME('report.after(damage)', 'Res');
const UNORDERED = GAME('report', 'Res');

const ir = (files: Record<string, string>) =>
  extractSources(Object.entries(files).map(([path, text]) => ({ path, text }))).ir;

describe('M5: git plumbing (§5)', () => {
  test('reads blobs at a revision without touching the working tree', () => {
    const dir = makeRepo({ 'src/game.rs': ORDERED, 'README.md': 'x' });
    write(dir, { 'src/game.rs': UNORDERED });

    const sha = resolveRev(dir, 'HEAD');
    const paths = rustFilesAtRev(dir, sha);
    assert.deepEqual(paths, ['src/game.rs'], 'non-Rust files are filtered out');

    const blobs = readBlobsAtRev(dir, sha, paths);
    assert.match(blobs.get('src/game.rs')!, /report\.after\(damage\)/, 'committed content, not the edit');
    assert.equal(execFileSync('git', ['-C', dir, 'status', '--porcelain']).toString().trim().length > 0, true);
  });

  test('reads several blobs in one batch, in order', () => {
    const dir = makeRepo({ 'a.rs': '// a', 'b.rs': '// bb', 'c.rs': '// ccc' });
    const blobs = readBlobsAtRev(dir, resolveRev(dir, 'HEAD'), ['a.rs', 'b.rs', 'c.rs']);
    assert.deepEqual([...blobs.entries()].sort(), [['a.rs', '// a'], ['b.rs', '// bb'], ['c.rs', '// ccc']]);
  });

  test('bare `atlas diff` means working tree vs HEAD', () => {
    assert.deepEqual(parseRevSpec(undefined), { baseRef: 'HEAD', headRef: null });
    assert.deepEqual(parseRevSpec('main..HEAD'), { baseRef: 'main', headRef: 'HEAD' });
    assert.deepEqual(parseRevSpec('main'), { baseRef: 'main', headRef: null });
  });

  test('module paths come from repo-relative paths on both sides', () => {
    assert.equal(modulePathFromRepoPath('src/player/movement.rs'), 'src::player::movement');
  });
});

describe('M5: GraphDelta (§6.1)', () => {
  test('removing an ordering constraint is reported as an INTRODUCED ambiguity', () => {
    const delta = computeDelta(ir({ 'src/game.rs': ORDERED }), ir({ 'src/game.rs': UNORDERED }), {
      base: 'b',
      head: 'h',
    });
    assert.equal(delta.ambiguities.introduced.length, 1);
    assert.equal(delta.ambiguities.introduced[0]!.stateId, 'Health');
    assert.deepEqual(delta.ambiguities.resolved, []);
  });

  test('adding an ordering constraint is reported as RESOLVED', () => {
    const delta = computeDelta(ir({ 'src/game.rs': UNORDERED }), ir({ 'src/game.rs': ORDERED }), {
      base: 'b',
      head: 'h',
    });
    assert.equal(delta.ambiguities.resolved.length, 1);
    assert.deepEqual(delta.ambiguities.introduced, []);
  });

  test('a pre-existing ambiguity is persisting, not introduced', () => {
    const delta = computeDelta(ir({ 'src/game.rs': UNORDERED }), ir({ 'src/game.rs': UNORDERED }), {
      base: 'b',
      head: 'h',
    });
    assert.deepEqual(delta.ambiguities.introduced, []);
    assert.equal(delta.ambiguities.persisting.length, 1);
  });

  test('&T widening to &mut T gets its own channel, not add+remove', () => {
    const delta = computeDelta(
      ir({ 'src/game.rs': GAME('report', 'Res') }),
      ir({ 'src/game.rs': GAME('report', 'ResMut') }),
      { base: 'b', head: 'h' },
    );
    assert.deepEqual(
      delta.accesses.modeChanged.map((c) => `${c.stateId} ${c.from}->${c.to}`),
      ['Score read->readwrite'],
    );
    assert.deepEqual(delta.accesses.added, []);
    assert.deepEqual(delta.accesses.removed, []);
  });
});

describe('M5: what counts as a modification', () => {
  const withRegistration = (extra: string) => `use bevy::prelude::*;
#[derive(Component)] pub struct Health(u32);
fn damage(q: Query<&mut Health>) {}
fn main() { App::new().add_systems(Update, damage${extra}).run(); }
`;

  const modifiedIds = (before: string, after: string) =>
    computeDelta(ir({ 'src/g.rs': before }), ir({ 'src/g.rs': after }), { base: 'b', head: 'h' }).executors.modified;

  test('dropping a run_if is a modification (the system now runs unconditionally)', () => {
    assert.deepEqual(modifiedIds(withRegistration('.run_if(ready)'), withRegistration('')), ['src::g::damage']);
  });

  test('adding ambiguous_with is a modification (it silences a warning)', () => {
    assert.deepEqual(modifiedIds(withRegistration(''), withRegistration('.ambiguous_with(other)')), ['src::g::damage']);
  });

  test('changing the set membership is a modification', () => {
    assert.deepEqual(modifiedIds(withRegistration('.in_set(A)'), withRegistration('.in_set(B)')), ['src::g::damage']);
  });

  test('an identical file yields no modifications', () => {
    assert.deepEqual(modifiedIds(withRegistration('.run_if(ready)'), withRegistration('.run_if(ready)')), []);
  });
});

describe('M5: move pairing (§6.2)', () => {
  test('a relocated file is moved, not removed-and-added', () => {
    const before = ir({ 'src/game.rs': ORDERED });
    const after = ir({ 'src/gameplay/game.rs': ORDERED });
    const delta = computeDelta(before, after, { base: 'b', head: 'h' });

    assert.equal(delta.executors.moved.length, 3);
    assert.deepEqual(delta.executors.added, []);
    assert.deepEqual(delta.executors.removed, []);
    for (const move of delta.executors.moved) assert.ok(move.confidence >= 0.9);
  });

  test('a move produces no access churn and no phantom ambiguities', () => {
    const delta = computeDelta(ir({ 'src/game.rs': ORDERED }), ir({ 'src/gameplay/game.rs': ORDERED }), {
      base: 'b',
      head: 'h',
    });
    assert.deepEqual(delta.accesses.added, []);
    assert.deepEqual(delta.accesses.removed, []);
    assert.deepEqual(delta.ambiguities.introduced, []);
  });

  test('unrelated systems are not paired as moves', () => {
    const before = ir({ 'a.rs': 'fn alpha(q: Query<&mut A>) {}' });
    const after = ir({ 'b.rs': 'fn beta(r: Res<Totally>, s: ResMut<Different>) {}' });
    assert.deepEqual(pairMoves(before, after, ['a::alpha'], ['b::beta']), []);
  });

  test('identity itself is never weakened to produce the pairing', () => {
    const before = ir({ 'src/game.rs': ORDERED });
    const after = ir({ 'src/gameplay/game.rs': ORDERED });
    const beforeIds = before.executors.map((e) => e.id).sort();
    const afterIds = after.executors.map((e) => e.id).sort();
    assert.notDeepEqual(beforeIds, afterIds, 'ids must still differ; only the differ reconciles them');
    assert.ok(afterIds.every((id) => id.startsWith('src::gameplay::game::')));
  });
});

describe('M5: end to end', () => {
  test('runDiff reports the review payload for an uncommitted edit', () => {
    const dir = makeRepo({ 'src/game.rs': ORDERED });
    write(dir, { 'src/game.rs': GAME('report', 'ResMut') });

    const result = runDiff(dir, undefined, false);
    assert.deepEqual(result.changed, ['src/game.rs']);
    assert.equal(result.delta.head.rev, 'working tree');
    assert.equal(result.delta.ambiguities.introduced.length, 1);
    assert.equal(result.delta.accesses.modeChanged.length, 1);
  });

  test('untracked files count as part of the working tree', () => {
    const dir = makeRepo({ 'src/game.rs': ORDERED });
    write(dir, { 'src/extra.rs': 'fn extra(q: Query<&mut Health>) {}' });
    const result = runDiff(dir, undefined, false);
    assert.ok(result.changed.includes('src/extra.rs'));
    assert.ok(result.head.executors.some((e) => e.display === 'extra'));
  });

  test('the base graph is cached by SHA and reused', () => {
    const dir = makeRepo({ 'src/game.rs': ORDERED });
    write(dir, { 'src/game.rs': UNORDERED });

    const first = runDiff(dir, undefined, true);
    assert.equal(first.baseFromCache, false);
    assert.ok(existsSync(cacheDir(dir)), 'cache directory is created');

    const second = runDiff(dir, undefined, true);
    assert.equal(second.baseFromCache, true);
    assert.deepEqual(
      second.delta.ambiguities.introduced.map((a) => a.stateId),
      first.delta.ambiguities.introduced.map((a) => a.stateId),
      'a cached base must give the same answer as a fresh one',
    );
  });

  test('a cache entry from a different extractor version is not reused', () => {
    // A commit's tree is immutable but the IR derived from it is not: if the extractor
    // changes, a cached base produces findings that do not exist (found at M6).
    const dir = makeRepo({ 'src/game.rs': ORDERED });
    write(dir, { 'src/game.rs': UNORDERED });
    runDiff(dir, undefined, true);

    const entries = readdirSync(cacheDir(dir));
    assert.equal(entries.length, 1);
    assert.match(entries[0]!, new RegExp(extractorFingerprint()), 'key carries the extractor fingerprint');

    // Simulate an extractor change by relabelling the entry with a different fingerprint.
    renameSync(join(cacheDir(dir), entries[0]!), join(cacheDir(dir), entries[0]!.replace(extractorFingerprint(), 'deadbeef0000')));
    assert.equal(runDiff(dir, undefined, true).baseFromCache, false, 'must re-extract, not reuse');
  });

  test('comparing two committed revisions works too', () => {
    const dir = makeRepo({ 'src/game.rs': ORDERED });
    write(dir, { 'src/game.rs': UNORDERED });
    execFileSync('git', ['-C', dir, 'commit', '-qam', 'drop ordering']);

    const result = runDiff(dir, 'HEAD~1..HEAD', false);
    assert.equal(result.delta.ambiguities.introduced.length, 1);
    assert.notEqual(result.delta.head.rev, 'working tree');
  });

  test('a non-git directory fails with a clear message, not a crash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-nogit-'));
    repos.push(dir);
    assert.throws(() => runDiff(dir, undefined, false), /not a git repository|failed/);
  });
});
