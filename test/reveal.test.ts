import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeReveal,
  retargetEdges,
  MEMBER_OPEN_PX,
  MEMBER_ALL_PX,
  MEMBER_FULL_PX,
} from '../src/web/reveal.ts';
import type { Scene, SceneMember, SceneRegion } from '../src/layout/scene.ts';
import type { GraphEdge } from '../src/core/graph.ts';

const member = (id: string, importance: number, kind: 'executor' | 'state' = 'executor'): SceneMember => ({
  id, kind, label: id, x: 0, y: 0, width: 160, height: 40, importance,
});

const region = (id: string, width: number, count: number, offset = 0): SceneRegion => ({
  id: `region:${id}`, label: id, x: offset, y: 0, width, height: 400,
  executorCount: count, stateCount: 0,
  members: Array.from({ length: count }, (_, i) => member(`${id}::f${i}`, count - i)),
  topState: [],
});

function scene(regions: SceneRegion[], edges: Scene['edges'] = [], shared: SceneMember[] = []): Scene {
  const ownerOf: Record<string, string> = {};
  for (const r of regions) for (const m of r.members) ownerOf[m.id] = r.id;
  return { version: 2, regions, shared, edges, ownerOf, width: 4000, height: 2000 };
}

describe('M10: per-region reveal (§9.2)', () => {
  test('a region below its threshold stays a box', () => {
    const s = scene([region('a', 1000, 10)]);
    const r = computeReveal(s, 0.05); // 50px apparent
    assert.equal(r.open.size, 0);
    assert.equal(r.members.size, 0);
  });

  test('regions open independently — zooming into one leaves the other closed', () => {
    // Regions open independently through CULLING: `far` is off screen, so it stays shut
    // even though its members are the same size (§9.2).
    const s = scene([region('near', 4000, 6), region('far', 4000, 6, 90_000)]);
    const r = computeReveal(s, MEMBER_ALL_PX / 160, {
      viewport: { x: 0, y: 0, width: 6000, height: 2000 },
    });
    assert.deepEqual([...r.open], ['region:near']);
  });

  test('members arrive in importance order, most connected first', () => {
    const s = scene([region('a', 3000, 10)]);
    const zoom = (MEMBER_OPEN_PX * 1.16) / 160; // just clear of the deadband
    const r = computeReveal(s, zoom);
    const revealed = [...r.members.keys()];
    assert.ok(revealed.length < 10, 'only a few appear at first');
    assert.ok(revealed.includes('a::f0'), 'the most connected member appears first');
    assert.ok(!revealed.includes('a::f9'), 'the least connected does not');
  });

  test('everything is revealed once the region is large enough', () => {
    const s = scene([region('a', 3000, 10)]);
    const r = computeReveal(s, MEMBER_ALL_PX / 160);
    assert.equal(r.members.size, 10);
  });

  test('per-node detail follows that node’s own apparent size', () => {
    const s = scene([region('a', 3000, 3)]);
    const wide = computeReveal(s, MEMBER_FULL_PX / 160);
    assert.ok([...wide.members.values()].every((d) => d === 'full'));
    const narrow = computeReveal(s, MEMBER_ALL_PX / 160);
    assert.ok([...narrow.members.values()].some((d) => d !== 'full'));
  });

  test('hysteresis keeps a region from flickering at its boundary', () => {
    const s = scene([region('a', 3000, 4)]);
    const atBoundary = MEMBER_OPEN_PX / 160;
    const closed = computeReveal(s, atBoundary * 1.03);
    assert.equal(closed.open.size, 0, 'must clear the deadband to open');

    const opened = computeReveal(s, atBoundary * 1.5);
    const stillOpen = computeReveal(s, atBoundary * 0.97, {}, opened);
    assert.equal(stillOpen.open.size, 1, 'an open region resists closing');
  });

  test('the budget caps mounted members and marks who was capped', () => {
    const s = scene([region('a', 6000, 400), region('b', 6000, 400, 7000)]);
    const r = computeReveal(s, MEMBER_ALL_PX / 160, { budget: 100 });
    assert.ok(r.mounted <= 100, `mounted ${r.mounted} exceeds budget`);
    assert.ok(r.capped.size > 0, 'capping must be visible, not silent');
  });

  test('offscreen regions are culled', () => {
    const s = scene([region('near', 3000, 5), region('far', 3000, 5, 90_000)]);
    const r = computeReveal(s, MEMBER_ALL_PX / 160, {
      viewport: { x: 0, y: 0, width: 5000, height: 2000 },
    });
    assert.deepEqual([...r.open], ['region:near']);
  });

  test('reveal is deterministic', () => {
    const s = scene([region('a', 3000, 20), region('b', 3000, 20, 4000)]);
    const one = computeReveal(s, 0.3, { budget: 15 });
    const two = computeReveal(s, 0.3, { budget: 15 });
    assert.deepEqual([...one.members.keys()].sort(), [...two.members.keys()].sort());
  });
});

describe('M10: edge re-targeting (§9.2)', () => {
  const edges: GraphEdge[] = [
    { id: 'e1', source: 'a::f0', target: 'b::f0', mode: 'read', doubleHeaded: false },
    { id: 'e2', source: 'a::f1', target: 'b::f1', mode: 'read', doubleHeaded: false },
  ];

  test('both ends closed: one line between the two boxes, carrying a weight', () => {
    const s = scene([region('a', 100, 4), region('b', 100, 4, 200)], edges);
    const out = retargetEdges(s, computeReveal(s, 0.01));
    assert.equal(out.length, 1, 'the two relations merge into one line');
    assert.deepEqual([out[0]!.source, out[0]!.target], ['region:a', 'region:b']);
    assert.equal(out[0]!.weight, 2);
  });

  test('one end open: the edge lands on the real node at that end', () => {
    // `b` is off screen, so it stays a box while `a` opens -- the same culling that gives
    // regions their independence also decides where an edge terminates.
    const s = scene([region('a', 8000, 4), region('b', 8000, 4, 90_000)], edges);
    const reveal = computeReveal(s, MEMBER_ALL_PX / 160, {
      viewport: { x: 0, y: 0, width: 10_000, height: 2000 },
    });
    const out = retargetEdges(s, reveal);
    assert.ok(out.every((e) => e.target === 'region:b'), 'closed end stays on the box');
    assert.ok(out.some((e) => e.source === 'a::f0'), 'open end reaches the member');
  });

  test('both ends open: every relation is its own line again', () => {
    const s = scene([region('a', 8000, 4), region('b', 8000, 4, 9000)], edges);
    const out = retargetEdges(s, computeReveal(s, MEMBER_ALL_PX / 160));
    assert.equal(out.length, 2);
    assert.equal(out.every((e) => e.weight === 1), true);
  });

  test('an edge inside one closed region is dropped, not drawn as a self-loop', () => {
    const s = scene(
      [region('a', 100, 4)],
      [{ id: 'e', source: 'a::f0', target: 'a::f1', mode: 'read', doubleHeaded: false } satisfies GraphEdge],
    );
    assert.deepEqual(retargetEdges(s, computeReveal(s, 0.01)), []);
  });

  test('a relation is never drawn twice at any zoom', () => {
    const s = scene([region('a', 4000, 6), region('b', 4000, 6, 5000)], edges);
    for (const zoom of [0.01, 0.05, 0.1, 0.3, 0.6, 1.2]) {
      const out = retargetEdges(s, computeReveal(s, zoom, {
        viewport: { x: 0, y: 0, width: 10_000, height: 2000 },
      }));
      const seen = new Set(out.map((e) => e.id));
      assert.equal(seen.size, out.length, `duplicate edge ids at zoom ${zoom}`);
      const totalWeight = out.reduce((n, e) => n + e.weight, 0);
      assert.ok(totalWeight <= edges.length, `zoom ${zoom} over-counts relations`);
    }
  });
});
