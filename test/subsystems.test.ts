import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractSources } from '../src/core/pipeline.ts';
import { clusterExecutors, crossGroupClusters } from '../src/core/cluster.ts';
import { assignGroups, groupOf } from '../src/core/grouping.ts';

const ir = (files: Record<string, string>) =>
  extractSources(Object.entries(files).map(([path, text]) => ({ path, text }))).ir;

describe('M9: signatures declare access too (§2 generalised)', () => {
  const LIB = `
    pub struct RoadNetwork { pub id: u32 }
    pub struct Waypoint { pub x: f32 }
    pub struct LaneId(u32);
    pub fn plan_route(net: &RoadNetwork, from: LaneId) -> Vec<Waypoint> { vec![] }
  `;

  test('an ordinary function becomes an executor with typed reads and writes', () => {
    const out = ir({ 'crates/map/src/plan.rs': LIB });
    const plan = out.executors.find((e) => e.display === 'plan_route')!;
    assert.equal(plan.kind, 'function');

    const modes = Object.fromEntries(
      out.accesses.filter((a) => a.executorId === plan.id).map((a) => [a.stateId, a.mode]),
    );
    assert.deepEqual(modes, { RoadNetwork: 'read', LaneId: 'read', Waypoint: 'write' });
  });

  test('signature relations are marked, so they never look like memory access', () => {
    const out = ir({ 'crates/map/src/plan.rs': LIB });
    assert.ok(out.accesses.every((a) => a.viaSignature === true));
  });

  test('foreign types are excluded: only what the corpus declares becomes a node', () => {
    const out = ir({ 'crates/map/src/plan.rs': LIB });
    const ids = out.states.map((s) => s.id).sort();
    assert.deepEqual(ids, ['LaneId', 'RoadNetwork', 'Waypoint'], 'Vec and f32 must not appear');
  });

  test('a method reads its own impl type', () => {
    const out = ir({
      'crates/map/src/net.rs': `
        pub struct RoadNetwork;
        pub struct Lane;
        impl RoadNetwork { pub fn lanes(&self) -> Vec<Lane> { vec![] } }`,
    });
    const lanes = out.executors.find((e) => e.display === 'lanes')!;
    const modes = Object.fromEntries(
      out.accesses.filter((a) => a.executorId === lanes.id).map((a) => [a.stateId, a.mode]),
    );
    assert.deepEqual(modes, { RoadNetwork: 'read', Lane: 'write' });
  });

  test('ECS systems keep their declared-access semantics and are not downgraded', () => {
    const out = ir({
      'crates/game/src/s.rs':
        'use bevy::prelude::*; #[derive(Component)] pub struct Health; fn main(){App::new().add_systems(Update, tick);} fn tick(q: Query<&mut Health>) {}',
    });
    const tick = out.executors.find((e) => e.display === 'tick')!;
    assert.equal(tick.kind, 'system');
    const access = out.accesses.find((a) => a.executorId === tick.id)!;
    assert.equal(access.mode, 'readwrite');
    assert.equal(access.viaSignature, undefined, 'ECS access is real memory access');
  });

  test('a function with no project types in its signature is not a node', () => {
    const out = ir({ 'crates/u/src/u.rs': 'pub struct Thing; pub fn helper(x: u32) -> String { String::new() }' });
    assert.deepEqual(out.executors.map((e) => e.display), []);
  });
});

describe('M9: grouping modes', () => {
  const WORKSPACE = {
    'crates/map/src/net.rs': 'pub struct RoadNetwork; pub struct Lane; pub fn lanes(n: &RoadNetwork) -> Vec<Lane> { vec![] }',
    'crates/plan/src/route.rs': 'pub struct Route; pub fn build(l: &Lane) -> Route { Route }',
    'crates/ui/src/draw.rs': 'pub struct Pixel; pub fn draw(r: &Route) -> Pixel { Pixel }',
  };

  test('structural path segments are not mistaken for regions', () => {
    // `crates/movement/src/x.rs` must group as `movement`, not `crates` -- the naive
    // first-segment rule collapsed an entire 10-crate workspace into one region.
    assert.equal(groupOf('crates::movement::src::gait'), 'movement');
    assert.equal(groupOf('2d::move_sprite'), '2d');
    assert.equal(groupOf('src::lib::thing'), 'thing');
  });

  test('crate mode gives one region per crate', () => {
    const groups = assignGroups(ir(WORKSPACE), 'crate');
    assert.deepEqual([...new Set(groups.values())].sort(), ['map', 'plan', 'ui']);
  });

  test('cluster mode is deterministic across runs', () => {
    const graph = ir(WORKSPACE);
    const first = clusterExecutors(graph);
    const second = clusterExecutors(graph);
    assert.deepEqual([...first.assignment].sort(), [...second.assignment].sort());
  });

  test('cluster mode is deterministic under input reordering', () => {
    const forward = ir(WORKSPACE);
    const reversed = ir(Object.fromEntries(Object.entries(WORKSPACE).reverse()));
    const a = clusterExecutors(forward);
    const b = clusterExecutors(reversed);
    assert.deepEqual(
      [...a.clusters.values()].map((m) => m.join(',')).sort(),
      [...b.clusters.values()].map((m) => m.join(',')).sort(),
    );
  });

  test('ubiquitous state is kept out of the similarity graph', () => {
    // Everything touching one hub type would otherwise collapse into a single cluster.
    const many: Record<string, string> = { 'crates/core/src/t.rs': 'pub struct Ctx;' };
    for (let i = 0; i < 30; i++) many[`crates/c${i}/src/f.rs`] = `pub fn f${i}(c: &Ctx) -> u32 { 0 }`;
    const result = clusterExecutors(ir(many));
    assert.ok(result.hubs.includes('Ctx'), 'Ctx is touched by every function and must be a hub');
    assert.equal(result.clusters.size, 0, 'no cluster should form from a hub alone');
  });

  test('cross-group clusters are reported, single-group ones are not', () => {
    const graph = ir(WORKSPACE);
    const result = clusterExecutors(graph, { hubFraction: 1 });
    const mismatches = crossGroupClusters(result, groupOf);
    for (const m of mismatches) assert.ok(m.spread.length >= 2, 'only disagreements are findings');
  });
});
