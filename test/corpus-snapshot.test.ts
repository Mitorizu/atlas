import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractIR, summarise } from '../scripts/corpus-stats.ts';
import { findBevyExamples } from './corpus.ts';

const dir = findBevyExamples();
const skip = dir ? false : 'bevy 0.19 corpus not in cargo cache';

/**
 * Milestone 2 snapshot guard over the examples corpus (411 files).
 *
 * Counts use lower bounds rather than exact equality: an improvement to the extractor
 * should not break the suite, but a regression that starts dropping systems will.
 * The structural invariants below are exact, and are the more valuable half.
 */
describe('M2: corpus snapshot — examples/', () => {
  const load = (() => {
    let cached: ReturnType<typeof extractIR> | null = null;
    return () => (cached ??= extractIR(dir!));
  })();

  test('extraction volume has not regressed', { skip }, () => {
    const s = summarise(load().ir);
    const floors: Record<string, number> = {
      executors: 1300, systems: 1200, observers: 60, registered: 1250,
      states: 600, components: 250, resources: 280, messages: 40,
      accesses: 3800, reads: 1800, readwrites: 1350, structural: 600,
      withFilters: 550, optional: 40,
    };
    for (const [key, floor] of Object.entries(floors)) {
      const actual = s[key as keyof typeof s] as number;
      assert.ok(actual >= floor, `${key}: ${actual} < floor ${floor}`);
    }
  });

  test('the whole §7.1 vocabulary fires on real code', { skip }, () => {
    const s = summarise(load().ir);
    // Each of these was zero before M2; a zero means a vocabulary entry stopped matching.
    for (const key of ['observers', 'closures', 'generic', 'messages', 'withFilters', 'optional', 'inSets', 'runConditions'] as const) {
      assert.ok((s[key] as number) > 0, `${key} is 0 — vocabulary entry no longer matches real code`);
    }
  });

  test('executor ids are unique', { skip }, () => {
    const ids = load().ir.executors.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('every access references an existing executor and state', { skip }, () => {
    const { ir } = load();
    const executors = new Set(ir.executors.map((e) => e.id));
    const states = new Set(ir.states.map((s) => s.id));
    const dangling = ir.accesses.filter((a) => !executors.has(a.executorId) || !states.has(a.stateId));
    assert.deepEqual(dangling.slice(0, 3), []);
  });

  test('registered executors always carry a schedule', { skip }, () => {
    const bad = load().ir.executors.filter((e) => !e.unregistered && !e.registration?.schedule);
    assert.deepEqual(bad.map((e) => e.id).slice(0, 3), []);
  });

  test('generic executors keep their type arguments in the id (§6.2)', { skip }, () => {
    const generic = load().ir.executors.filter((e) => e.typeArgs !== undefined);
    assert.ok(generic.length > 0);
    for (const e of generic) assert.match(e.id, /::<.+>$/);
  });

  test('state keys retain generic arguments (§7.4)', { skip }, () => {
    const ids = load().ir.states.map((s) => s.id);
    const parameterised = ids.filter((id) => id.includes('<'));
    assert.ok(parameterised.length > 20, `expected many parameterised state keys, got ${parameterised.length}`);
    assert.ok(ids.some((id) => id.startsWith('Assets<')), 'Assets<T> must not collapse to Assets');
  });

  test('the M3 boundary is where the design says it is', { skip }, () => {
    // Examples are self-contained apps, so scope resolution should mostly succeed here;
    // it is the engine crates (libraries, no App::new) that need pass 4.
    const { ir } = load();
    const unknown = ir.executors.filter((e) => e.appScopes.length === 0).length;
    assert.ok(unknown / ir.executors.length < 0.2, `${unknown} executors lack scope in a self-contained corpus`);
  });
});
