import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { DialectOutput } from '../src/dialects/types.ts';
import { extractSource as extract } from './helpers.ts';
/** Wraps a system in a minimal app so it registers. */
const app = (systems: string, defs: string): string =>
  `fn main(){ App::new().add_systems(Update, ${systems}); } ${defs}`;

const modes = (out: DialectOutput): Record<string, string> =>
  Object.fromEntries(out.accesses.map((a) => [a.stateId, a.mode]));

describe('M2: parameter vocabulary (§7.1)', () => {
  test('Single<D, F> is a query and carries filters (137 of 232 uses do)', () => {
    const out = extract(app('s', 'fn s(q: Single<&mut Health, With<Player>>) {}'));
    assert.deepEqual(modes(out), { Health: 'readwrite' });
    assert.deepEqual(out.accesses[0]!.filters, { kind: 'with', state: 'Player' });
  });

  test('Populated<D> behaves as a query', () => {
    assert.deepEqual(modes(extract(app('s', 'fn s(q: Populated<&A>) {}'))), { A: 'read' });
  });

  test('MessageReader reads and MessageWriter writes (EventReader does not exist, §7.2)', () => {
    const out = extract(app('s', 'fn s(r: MessageReader<Hit>, w: MessageWriter<Died>) {}'));
    assert.deepEqual(modes(out), { Hit: 'read', Died: 'write' });
    assert.deepEqual(
      Object.fromEntries(out.states.map((s) => [s.id, s.category])),
      { Hit: 'message', Died: 'message' },
    );
  });

  test('On<E> makes the function an observer and records the trigger type', () => {
    const out = extract('fn main(){ App::new().add_observer(on_hit); } fn on_hit(t: On<Hit>, q: Query<&mut Health>) {}');
    const observer = out.executors[0]!;
    assert.equal(observer.kind, 'observer');
    assert.equal(observer.observes, 'Hit');
    assert.equal(observer.registration?.schedule, 'Observer');
    assert.deepEqual(modes(out), { Hit: 'read', Health: 'readwrite' });
  });

  test('ParamSet members are analysed independently', () => {
    const out = extract(app('s', 'fn s(p: ParamSet<(Query<&mut A>, Query<&B>)>) {}'));
    assert.deepEqual(modes(out), { A: 'readwrite', B: 'read' });
  });

  test('Ref<T> reads, Mut<T> reads and writes', () => {
    assert.deepEqual(modes(extract(app('s', 'fn s(q: Query<(Ref<A>, Mut<B>)>) {}'))), { A: 'read', B: 'readwrite' });
  });

  test('Entity and Has<T> grant no component access', () => {
    const out = extract(app('s', 'fn s(q: Query<(Entity, Has<Frozen>, &A)>) {}'));
    assert.deepEqual(modes(out), { A: 'read' });
  });

  test('NonSend and NonSendMut are resources', () => {
    assert.deepEqual(modes(extract(app('s', 'fn s(a: NonSend<W>, b: NonSendMut<X>) {}'))), {
      W: 'read',
      X: 'readwrite',
    });
  });

  test('&\'static mut T is still a write (lifetime precedes the mut marker)', () => {
    assert.deepEqual(modes(extract(app('s', "fn s(q: Query<&'static mut Transform>) {}"))), {
      Transform: 'readwrite',
    });
  });
});

describe('M2: filters nest (§6 FilterExpr)', () => {
  test('a bare tuple of filters is an implicit AND', () => {
    const out = extract(app('s', 'fn s(q: Query<&A, (With<P>, Without<D>)>) {}'));
    assert.deepEqual(out.accesses[0]!.filters, {
      kind: 'and',
      operands: [{ kind: 'with', state: 'P' }, { kind: 'without', state: 'D' }],
    });
  });

  test('Or<(..)> nests rather than flattening', () => {
    const out = extract(app('s', 'fn s(q: Query<&A, Or<(Added<X>, Changed<Y>)>>) {}'));
    assert.deepEqual(out.accesses[0]!.filters, {
      kind: 'or',
      operands: [{ kind: 'added', state: 'X' }, { kind: 'changed', state: 'Y' }],
    });
  });

  test('nested Or inside an AND tuple survives', () => {
    const out = extract(app('s', 'fn s(q: Query<&A, (With<P>, Or<(With<B>, Without<C>)>)>) {}'));
    assert.deepEqual(out.accesses[0]!.filters, {
      kind: 'and',
      operands: [
        { kind: 'with', state: 'P' },
        { kind: 'or', operands: [{ kind: 'with', state: 'B' }, { kind: 'without', state: 'C' }] },
      ],
    });
  });
});

describe('M2: custom SystemParam expansion (§7.2)', () => {
  const registry = `
    #[derive(SystemParam)]
    struct Inner<'w> { t: Res<Time> }
    #[derive(SystemParam)]
    struct Outer<'w, 's> { q: Query<&'static mut Transform>, inner: Inner<'w> }
  `;

  test('fields expand transitively and record viaParam', () => {
    const out = extract(app('s', `${registry} fn s(p: Outer) {}`));
    assert.deepEqual(modes(out), { Transform: 'readwrite', Time: 'read' });
    assert.deepEqual([...new Set(out.accesses.map((a) => a.viaParam))], ['Outer']);
  });

  test('a self-referential SystemParam terminates instead of recursing forever', () => {
    const cyclic = `
      #[derive(SystemParam)]
      struct A<'w> { b: B<'w>, t: Res<Time> }
      #[derive(SystemParam)]
      struct B<'w> { a: A<'w> }
    `;
    const out = extract(app('s', `${cyclic} fn s(p: A) {}`));
    assert.deepEqual(modes(out), { Time: 'read' });
  });
});

describe('M2: registration semantics (§7.6)', () => {
  const reg = (systems: string) =>
    extract(`fn main(){ App::new().add_systems(Update, ${systems}); }
      fn a(q: Query<&A>) {} fn b(q: Query<&B>) {} fn c(q: Query<&C>) {} fn d(q: Query<&D>) {}`);

  const regOf = (out: DialectOutput, name: string) =>
    out.executors.find((e) => e.display === name)!.registration!;

  test('run_if distributes to every TRANSITIVE leaf of a tuple', () => {
    const out = reg('((a, b), c).run_if(ready)');
    for (const name of ['a', 'b', 'c']) {
      assert.deepEqual(regOf(out, name).runConditions, ['ready'], `${name} should inherit run_if`);
    }
  });

  test('in_set distributes transitively too', () => {
    const out = reg('((a, b), c).in_set(Physics)');
    for (const name of ['a', 'b', 'c']) assert.deepEqual(regOf(out, name).inSets, ['Physics']);
  });

  test('chain() orders IMMEDIATE children only — the leaves of one child stay unordered', () => {
    // ((a, b), c).chain() means {a,b} before c, but a and b are NOT ordered w.r.t. each other.
    const out = reg('((a, b), c).chain()');
    assert.deepEqual(regOf(out, 'a').before, ['c']);
    assert.deepEqual(regOf(out, 'b').before, ['c']);
    assert.deepEqual(regOf(out, 'c').after.sort(), ['a', 'b']);
    assert.deepEqual(regOf(out, 'a').after, [], 'a must not be ordered against its sibling b');
    assert.deepEqual(regOf(out, 'b').after, [], 'b must not be ordered against its sibling a');
  });

  test('chain() on an inner tuple does not order the outer siblings', () => {
    const out = reg('(a, (b, c).chain())');
    assert.deepEqual(regOf(out, 'b').before, ['c']);
    assert.deepEqual(regOf(out, 'a').before, []);
    assert.deepEqual(regOf(out, 'a').after, []);
  });

  test('before/after are recorded as written', () => {
    const out = reg('(a.before(c), b.after(c))');
    assert.deepEqual(regOf(out, 'a').before, ['c']);
    assert.deepEqual(regOf(out, 'b').after, ['c']);
  });

  test('ambiguous_with suppression is captured (§8 condition 5)', () => {
    const out = reg('(a.ambiguous_with(b), c.ambiguous_with_all())');
    assert.deepEqual(regOf(out, 'a').ambiguousWith, ['b']);
    assert.equal(regOf(out, 'c').ambiguousWith, 'all');
  });

  test('modifiers compose down a chain of calls', () => {
    const out = reg('(a, b).run_if(x).in_set(S)');
    assert.deepEqual(regOf(out, 'a').runConditions, ['x']);
    assert.deepEqual(regOf(out, 'a').inSets, ['S']);
  });

  test('a single system in parentheses is registered, not silently dropped', () => {
    // `(a)` is a parenthesized_expression; only `(a,)` and `(a, b)` are tuples. A walker
    // that handles only tuples loses the registration without any error (found at M6).
    for (const form of ['(a)', '(a,)', '(a, b)', 'a']) {
      const out = reg(form);
      const registered = out.executors.filter((e) => !e.unregistered).map((e) => e.display).sort();
      const expected = form.includes('b') ? ['a', 'b'] : ['a'];
      assert.deepEqual(registered, expected, `form ${form}`);
    }
  });

  test('chain() on a parenthesised single system is a no-op, not a crash', () => {
    const out = reg('(a).chain()');
    assert.deepEqual(out.executors.filter((e) => !e.unregistered).map((e) => e.display), ['a']);
  });

  test('inline closures become closure executors', () => {
    const out = extract('fn main(){ App::new().add_systems(Update, |mut c: Commands| { c.spawn(X); }); }');
    const closure = out.executors[0]!;
    assert.equal(closure.kind, 'closure');
    assert.match(closure.display, /^<closure@\d+>$/);
    assert.equal(closure.unregistered, false);
    assert.deepEqual(out.accesses.map((a) => a.stateId), ['«structural»']);
  });
});

describe('M2: configure_sets produces set-level ordering (§7.6)', () => {
  test('before/after between sets', () => {
    const out = extract('fn main(){ App::new().configure_sets(Update, (P::Step.before(P::Sync), R.after(P::Sync))); }');
    assert.deepEqual(
      out.setOrderings.map((o) => `${o.before}<${o.after}`).sort(),
      ['P::Step<P::Sync', 'P::Sync<R'],
    );
    assert.equal(out.setOrderings[0]!.schedule, 'Update');
  });

  test('chain() between sets orders them in sequence', () => {
    const out = extract('fn main(){ App::new().configure_sets(Update, (A, B, C).chain()); }');
    assert.deepEqual(out.setOrderings.map((o) => `${o.before}<${o.after}`).sort(), ['A<B', 'B<C']);
  });
});

describe('M2: declaration sites (§7.3)', () => {
  test('a local derive is authoritative for category', () => {
    const out = extract(app('s', '#[derive(Resource)] struct Score(u32); fn s(q: Query<&Score>) {}'));
    assert.equal(out.states.find((x) => x.id === 'Score')!.category, 'resource');
  });

  test('States and Message derives map to their categories', () => {
    const out = extract(
      app('s', '#[derive(States)] enum Phase { A } #[derive(Message)] struct Ping; fn s(a: Res<Phase>, b: MessageWriter<Ping>) {}'),
    );
    const cats = Object.fromEntries(out.states.map((x) => [x.id, x.category]));
    assert.deepEqual(cats, { Phase: 'resource', Ping: 'message' });
  });
});
