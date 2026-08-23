import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tierFor, apparentWidth, ORBIT_MAX_PX, DETAIL_MIN_PX } from '../src/web/lod.ts';
import { assignGroups, groupOf } from '../src/layout/tiers.ts';
import { extractSources } from '../src/core/pipeline.ts';

describe('M7: LOD tier selection (§9.2)', () => {
  test('tiers are chosen by apparent node size, not raw zoom', () => {
    // Fitting 2,000 nodes puts zoom near 0.05; a raw-zoom rule would never leave orbit.
    assert.equal(tierFor(apparentWidth(0.05), 'street'), 'orbit');
    assert.equal(tierFor(apparentWidth(1.0), 'street'), 'detail');
  });

  test('hysteresis stops a boundary from strobing', () => {
    // Sitting just above the orbit boundary must NOT flip an orbit view to street.
    const justOver = ORBIT_MAX_PX * 1.05;
    assert.equal(tierFor(justOver, 'orbit'), 'orbit', 'needs to clear the deadband first');
    assert.equal(tierFor(ORBIT_MAX_PX * 1.5, 'orbit'), 'street', 'a decisive move does switch');

    // And symmetrically on the way back down.
    const justUnder = ORBIT_MAX_PX * 0.95;
    assert.equal(tierFor(justUnder, 'street'), 'street');
    assert.equal(tierFor(ORBIT_MAX_PX * 0.5, 'street'), 'orbit');
  });

  test('the deadband is symmetric at the detail boundary too', () => {
    assert.equal(tierFor(DETAIL_MIN_PX * 1.05, 'street'), 'street');
    assert.equal(tierFor(DETAIL_MIN_PX * 1.5, 'street'), 'detail');
    assert.equal(tierFor(DETAIL_MIN_PX * 0.95, 'detail'), 'detail');
    assert.equal(tierFor(DETAIL_MIN_PX * 0.5, 'detail'), 'street');
  });

  test('a full sweep never skips a tier', () => {
    let tier = tierFor(1, 'street');
    assert.equal(tier, 'orbit');
    const seen: string[] = [tier];
    for (let px = 1; px < 300; px += 1) {
      const next = tierFor(px, tier as 'orbit' | 'street' | 'detail');
      if (next !== tier) {
        seen.push(next);
        tier = next;
      }
    }
    assert.deepEqual(seen, ['orbit', 'street', 'detail']);
  });
});

describe('M7: module grouping (§9.2)', () => {
  test('the group is the top module segment', () => {
    assert.equal(groupOf('3d::lighting::setup'), '3d');
    assert.equal(groupOf('solo'), 'solo');
  });

  test('state touched by one group nests; state shared between groups stays top level', () => {
    const ir = extractSources([
      { path: 'a/one.rs', text: 'fn main(){App::new().add_systems(Update,(s1,s2));} fn s1(q: Query<&Local1>) {} fn s2(q: Query<&Shared>) {}' },
      { path: 'b/two.rs', text: 'fn main(){App::new().add_systems(Update,s3);} fn s3(q: Query<&mut Shared>) {}' },
    ]).ir;
    const groups = assignGroups(ir);
    assert.equal(groups.get('Local1'), 'a', 'only group a touches Local1');
    assert.equal(groups.get('Shared'), undefined, 'Shared bridges two groups and stays top level');
    assert.equal(groups.get('a::one::s1'), 'a');
    assert.equal(groups.get('b::two::s3'), 'b');
  });
});
