import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findAmbiguities, provablyDisjoint } from '../src/analysis/ambiguity.ts';
import { extractIR } from '../scripts/corpus-stats.ts';
import { extractSources } from './helpers.ts';
import type { AtlasIR } from '../src/core/ir.ts';

const FIXTURES = 'harness/src/fixtures';
const ORACLE = join('harness', 'target', 'debug', 'atlas-ambiguity-oracle');

const app = (body: string, defs: string) => `fn main(){ let mut app = App::new(); ${body} } ${defs}`;
const pairs = (ir: AtlasIR) =>
  findAmbiguities(ir)
    .ambiguities.map((a) => [a.a.split('::').pop()!, a.b.split('::').pop()!].sort().join('|'))
    .sort();

describe('M4: the five conditions (§8)', () => {
  const defs = `
    #[derive(Component)] struct H;
    fn writes(q: Query<&mut H>) {} fn reads(q: Query<&H>) {} fn also_writes(q: Query<&mut H>) {}`;

  test('condition 3: overlapping access with at least one write is ambiguous', () => {
    const { output } = extractSources({ m: app('app.add_systems(Update, (writes, reads));', defs) });
    assert.deepEqual(pairs({ dialect: 'x', ...output }), ['reads|writes']);
  });

  test('condition 3: two readers never conflict', () => {
    const { output } = extractSources({
      m: app('app.add_systems(Update, (reads, reads2));', `${defs} fn reads2(q: Query<&H>) {}`),
    });
    assert.deepEqual(pairs({ dialect: 'x', ...output }), []);
  });

  test('condition 1: different schedules never conflict', () => {
    const { output } = extractSources({
      m: app('app.add_systems(Update, writes); app.add_systems(PreUpdate, also_writes);', defs),
    });
    assert.deepEqual(pairs({ dialect: 'x', ...output }), []);
  });

  test('condition 1: different app scopes never conflict', () => {
    const { output } = extractSources({
      a: app('app.add_systems(Update, writes);', defs),
      b: app('app.add_systems(Update, also_writes);', '#[derive(Component)] struct H; fn also_writes(q: Query<&mut H>) {}'),
    });
    assert.deepEqual(pairs({ dialect: 'x', ...output }), []);
  });

  test('condition 2: a direct ordering constraint resolves it', () => {
    const { output } = extractSources({ m: app('app.add_systems(Update, (writes, reads.after(writes)));', defs) });
    assert.deepEqual(pairs({ dialect: 'x', ...output }), []);
  });

  test('condition 2: ordering is TRANSITIVE', () => {
    const { output } = extractSources({
      m: app('app.add_systems(Update, (writes, reads.after(writes), also_writes.after(reads)));', defs),
    });
    assert.deepEqual(pairs({ dialect: 'x', ...output }), [], 'writes and also_writes are ordered via reads');
  });

  test('condition 2: chain() resolves a tuple', () => {
    const { output } = extractSources({ m: app('app.add_systems(Update, (writes, reads).chain());', defs) });
    assert.deepEqual(pairs({ dialect: 'x', ...output }), []);
  });

  test('condition 2: SET-level ordering counts, not just system-level', () => {
    const { output } = extractSources({
      m: app(
        'app.configure_sets(Update, (StepSet.before(SyncSet),)); app.add_systems(Update, (writes.in_set(StepSet), reads.in_set(SyncSet)));',
        defs,
      ),
    });
    assert.deepEqual(pairs({ dialect: 'x', ...output }), [], 'ordered only through their sets');
  });

  test('condition 4: With<P> vs Without<P> is provably disjoint', () => {
    const { output } = extractSources({
      m: app(
        'app.add_systems(Update, (only_p, not_p));',
        `#[derive(Component)] struct H; #[derive(Component)] struct P;
         fn only_p(q: Query<&mut H, With<P>>) {} fn not_p(q: Query<&mut H, Without<P>>) {}`,
      ),
    });
    assert.deepEqual(pairs({ dialect: 'x', ...output }), []);
  });

  test('condition 5: ambiguous_with suppresses a real overlap', () => {
    const { output } = extractSources({
      m: app('app.add_systems(Update, (writes.ambiguous_with(also_writes), also_writes));', defs),
    });
    assert.deepEqual(pairs({ dialect: 'x', ...output }), []);
  });

  test('Commands is deferred and never conflicts with itself', () => {
    const { output } = extractSources({
      m: app('app.add_systems(Update, (spawn_a, spawn_b));', 'fn spawn_a(c: Commands) {} fn spawn_b(c: Commands) {}'),
    });
    assert.deepEqual(pairs({ dialect: 'x', ...output }), []);
  });

  test('executors with unresolved scope are excluded, not guessed', () => {
    const { output } = extractSources({
      other: 'fn main(){ App::new(); }',
      lib: 'fn helper(q: Query<&mut H>) {}',
    });
    const report = findAmbiguities({ dialect: 'x', ...output });
    assert.deepEqual(report.ambiguities, []);
  });
});

describe('M4: filter disjointness is conservative', () => {
  test('Or<..> is never claimed disjoint', () => {
    const or = { kind: 'or' as const, operands: [{ kind: 'with' as const, state: 'P' }] };
    assert.equal(provablyDisjoint(or, { kind: 'without', state: 'P' }), false);
  });

  test('Added/Changed prove nothing about disjointness', () => {
    assert.equal(provablyDisjoint({ kind: 'added', state: 'P' }, { kind: 'changed', state: 'P' }), false);
  });

  test('disjointness is found inside an AND tuple', () => {
    assert.equal(
      provablyDisjoint(
        { kind: 'and', operands: [{ kind: 'with', state: 'A' }, { kind: 'with', state: 'P' }] },
        { kind: 'and', operands: [{ kind: 'with', state: 'A' }, { kind: 'without', state: 'P' }] },
      ),
      true,
    );
  });

  test('no filters means not disjoint', () => {
    assert.equal(provablyDisjoint(undefined, undefined), false);
  });
});

/**
 * The validation harness (§8): atlas's static findings are diffed against Bevy's own
 * runtime `ambiguity_detection` over the same source files. This is what turns the
 * feature from a plausible heuristic into a checked one.
 *
 * Skipped unless the oracle has been built (`npm run oracle:build`), so the suite stays
 * fast and runs on machines without a Rust toolchain.
 */
describe('M4: validated against Bevy itself', () => {
  const skip = existsSync(ORACLE) ? false : 'oracle not built - run `npm run oracle:build`';

  test('atlas agrees with Bevy on every fixture', { skip }, () => {
    const oracle = JSON.parse(execFileSync(ORACLE, { encoding: 'utf8' })) as Record<
      string,
      Array<{ schedule: string; a: string; b: string }>
    >;

    const { ir } = extractIR(FIXTURES);
    const mine = new Map<string, string[]>();
    for (const found of findAmbiguities(ir).ambiguities) {
      const pair = [found.a.split('::').pop()!, found.b.split('::').pop()!].sort().join('|');
      mine.set(found.appScope, [...(mine.get(found.appScope) ?? []), pair]);
    }

    const fixtures = Object.keys(oracle).sort();
    assert.ok(fixtures.length >= 8, `expected the full fixture set, got ${fixtures.length}`);

    const disagreements: string[] = [];
    for (const fixture of fixtures) {
      const bevy = [...new Set(oracle[fixture]!.map((c) => [c.a, c.b].sort().join('|')))].sort();
      const atlas = [...new Set(mine.get(fixture) ?? [])].sort();
      if (JSON.stringify(bevy) !== JSON.stringify(atlas)) {
        disagreements.push(`${fixture}: bevy=${JSON.stringify(bevy)} atlas=${JSON.stringify(atlas)}`);
      }
    }
    assert.deepEqual(disagreements, []);
  });

  test('the oracle actually exercises a positive case', { skip }, () => {
    const oracle = JSON.parse(execFileSync(ORACLE, { encoding: 'utf8' })) as Record<string, unknown[]>;
    assert.ok(
      (oracle['plain_conflict'] ?? []).length > 0,
      'plain_conflict must report a conflict, or the harness proves nothing',
    );
  });
});
