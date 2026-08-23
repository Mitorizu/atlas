import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractSources } from '../src/core/pipeline.ts';
import { computeDelta } from '../src/core/delta.ts';
import { buildFocus, blastRadius } from '../src/core/focus.ts';
import { describeNode, type Artifact } from '../src/web/artifact.ts';

const ir = (files: Record<string, string>) =>
  extractSources(Object.entries(files).map(([path, text]) => ({ path, text }))).ir;

const APP = (systems: string, defs: string) => `use bevy::prelude::*;
#[derive(Component)] pub struct Health(u32);
#[derive(Component)] pub struct Mana(u32);
#[derive(Resource)] pub struct Score(u32);
fn damage(q: Query<&mut Health>) {}
fn report(q: Query<&Health>) {}
fn mana_tick(q: Query<&mut Mana>) {}
fn tally(r: Res<Score>) {}
${defs}
fn main() { App::new().add_systems(Update, (${systems})).run(); }
`;

const BASE = APP('damage, report.after(damage), mana_tick, tally', '');
const ADDED = APP(
  'damage, report.after(damage), mana_tick, tally, snap',
  'fn snap(q: Query<&mut Health>) {}',
);

function focusFor(before: string, after: string, hops = 2) {
  const base = ir({ 'src/g.rs': before });
  const head = ir({ 'src/g.rs': after });
  const delta = computeDelta(base, head, { base: 'b', head: 'h' });
  return { focus: buildFocus(base, head, delta, { hops }), delta, base, head };
}

describe('M6: seed and expand (§4.1)', () => {
  test('an added system and its conflict partner are both seeds', () => {
    const { focus } = focusFor(BASE, ADDED);
    const seeds = focus.seeds.map((id) => id.split('::').pop()).sort();
    assert.ok(seeds.includes('snap'), 'the added system seeds the view');
    assert.ok(seeds.includes('damage') || seeds.includes('report'), 'the conflict partner seeds it too');
  });

  test('roles are assigned from the delta', () => {
    const { focus } = focusFor(BASE, ADDED);
    assert.equal(focus.meta['src::g::snap']?.role, 'added');
    assert.equal(focus.meta['src::g::damage']?.role, 'context');
  });

  test('the conflicted flag marks both ends of an introduced ambiguity', () => {
    const { focus } = focusFor(BASE, ADDED);
    const conflicted = Object.entries(focus.meta).filter(([, m]) => m.conflicted).map(([id]) => id);
    assert.ok(conflicted.length >= 2, `expected both ends, got ${conflicted.join(', ')}`);
  });

  test('the subgraph is a fraction of the whole', () => {
    const { focus } = focusFor(BASE, ADDED);
    assert.ok(focus.ir.executors.length < focus.totalExecutors);
    assert.ok(focus.ir.executors.length > 0);
  });

  test('more hops reach further, and zero hops is only the seeds', () => {
    const wide = focusFor(BASE, ADDED, 3).focus;
    const tight = focusFor(BASE, ADDED, 0).focus;
    assert.ok(tight.ir.executors.length <= wide.ir.executors.length);
    for (const id of Object.keys(tight.meta)) assert.equal(tight.meta[id]!.distance, 0);
  });

  test('unrelated systems stay out at one hop', () => {
    const { focus } = focusFor(BASE, ADDED, 1);
    const names = focus.ir.executors.map((e) => e.display);
    assert.ok(!names.includes('tally'), 'tally touches only Score and is unrelated');
  });

  test('a removed system survives as a ghost so the deletion is visible', () => {
    const { focus, delta } = focusFor(ADDED, BASE);
    assert.deepEqual(delta.executors.removed.map((id) => id.split('::').pop()), ['snap']);
    assert.equal(focus.meta['src::g::snap']?.role, 'removed');
    assert.ok(focus.ir.executors.some((e) => e.display === 'snap'), 'ghost is present in the subgraph');
  });

  test('expansion is scope-aware: another app is never pulled in (§7.3)', () => {
    const base = ir({ 'a.rs': BASE, 'b.rs': APP('other', 'fn other(q: Query<&mut Health>) {}') });
    const head = ir({ 'a.rs': ADDED, 'b.rs': APP('other', 'fn other(q: Query<&mut Health>) {}') });
    const delta = computeDelta(base, head, { base: 'b', head: 'h' });
    const focus = buildFocus(base, head, delta, { hops: 3 });
    assert.ok(
      !focus.ir.executors.some((e) => e.id.startsWith('b::')),
      'systems in a different app cannot interact and must not appear',
    );
  });
});

describe('M6: blast radius (§9.1)', () => {
  test('rings grow outward and never revisit', () => {
    const graph = ir({ 'src/g.rs': BASE });
    const rings = blastRadius(graph, 'Health', 2);
    assert.ok(rings.length > 0);
    assert.deepEqual(rings[0]!.ids.map((id) => id.split('::').pop()).sort(), ['damage', 'report']);
    const seen = new Set<string>();
    for (const ring of rings) for (const id of ring.ids) {
      assert.ok(!seen.has(id), `${id} appears in two rings`);
      seen.add(id);
    }
  });

  test('terminates on a cyclic graph (&mut makes 2-cycles, §7.5)', () => {
    const graph = ir({ 'src/g.rs': BASE });
    const rings = blastRadius(graph, 'src::g::damage', 10);
    assert.ok(!rings.some((r) => r.ids.includes('src::g::damage')), 'self-cycle excluded');
  });
});

describe('M6: inspector detail', () => {
  const artifactFor = (): Artifact => {
    const { focus, delta } = focusFor(BASE, ADDED);
    const { ir: focusIr, ...rest } = focus;
    return {
      meta: { dialect: 'bevy-0.19', mode: 'focus', repoRoot: '/repo' },
      focus: rest,
      ir: focusIr as unknown as Artifact['ir'],
      layout: { nodes: [], edges: [] },
    };
  };

  test('a system reports what it reads and what it writes', () => {
    const detail = describeNode(artifactFor(), 'src::g::damage')!;
    assert.equal(detail.kind, 'executor');
    // `&mut Health` is both, per §7.5.
    assert.ok(detail.upstream.some((u) => u.id === 'Health'));
    assert.ok(detail.downstream.some((d) => d.id === 'Health'));
  });

  test('state reports its writers and readers — the blast radius', () => {
    const detail = describeNode(artifactFor(), 'Health')!;
    assert.equal(detail.kind, 'state');
    assert.ok(detail.upstream.length >= 2, 'damage and snap both write Health');
    assert.ok(detail.downstream.some((d) => d.label === 'report'));
  });

  test('conflicts surface on both the systems and the contested state', () => {
    const artifact = artifactFor();
    assert.ok(describeNode(artifact, 'Health')!.conflicts.length > 0);
    assert.ok(describeNode(artifact, 'src::g::snap')!.conflicts.length > 0);
  });

  test('an unknown id yields null rather than throwing', () => {
    assert.equal(describeNode(artifactFor(), 'nope::nope'), null);
  });
});
