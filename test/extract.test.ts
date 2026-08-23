import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRustParser } from '../src/parser.ts';
import { bevy019 } from '../src/dialects/bevy-0.19/index.ts';
import type { SourceFile } from '../src/dialects/types.ts';
import { findBevyExamples } from './corpus.ts';

const dir = findBevyExamples();
const skip = dir ? false : 'bevy 0.19 corpus not in cargo cache';

function extract(path: string, modulePath: string) {
  const text = readFileSync(path, 'utf8');
  const file: SourceFile = { path, modulePath, text };
  return bevy019.extract(createRustParser().parse(text), file);
}

describe('M1: vertical slice on 2d/move_sprite.rs (DESIGN.md §10.1)', () => {
  test('produces exactly the IR the design specifies', { skip }, () => {
    const out = extract(join(dir!, '2d', 'move_sprite.rs'), '2d::move_sprite');

    assert.equal(out.executors.length, 2, 'two executors');
    assert.equal(out.states.length, 5, 'five state nodes');
    assert.equal(out.accesses.length, 5, 'five accesses');

    const executors = Object.fromEntries(out.executors.map((e) => [e.display, e]));
    assert.equal(executors['setup']?.registration?.schedule, 'Startup');
    assert.equal(executors['sprite_movement']?.registration?.schedule, 'Update');
    assert.equal(executors['setup']?.unregistered, false);
    assert.equal(executors['setup']?.appScope, '2d::move_sprite');

    const table = out.accesses
      .map((a) => `${out.executors.find((e) => e.id === a.executorId)!.display} ${a.mode} ${a.stateId}`)
      .sort();
    assert.deepEqual(table, [
      'setup read AssetServer',
      'setup structural «structural»',
      'sprite_movement read Time',
      'sprite_movement readwrite Direction',
      'sprite_movement readwrite Transform',
    ]);
  });

  test('state categories are assigned from usage position', { skip }, () => {
    const out = extract(join(dir!, '2d', 'move_sprite.rs'), '2d::move_sprite');
    const byId = Object.fromEntries(out.states.map((s) => [s.id, s.category]));
    assert.deepEqual(byId, {
      '«structural»': 'synthetic',
      AssetServer: 'resource',
      Time: 'resource',
      Direction: 'component',
      Transform: 'component',
    });
  });
});

describe('M1: extractor rules', () => {
  const parse = (src: string) => {
    const file: SourceFile = { path: 'x.rs', modulePath: 'x', text: src };
    return bevy019.extract(createRustParser().parse(src), file);
  };

  test('&T reads, &mut T reads AND writes (§7.5)', () => {
    const out = parse('fn main(){App::new().add_systems(Update, s);} fn s(q: Query<(&A, &mut B)>) {}');
    const modes = Object.fromEntries(out.accesses.map((a) => [a.stateId, a.mode]));
    assert.deepEqual(modes, { A: 'read', B: 'readwrite' });
  });

  test('Option<&T> is recorded as optional', () => {
    const out = parse('fn main(){App::new().add_systems(Update, s);} fn s(q: Query<(&A, Option<&B>)>) {}');
    const optional = Object.fromEntries(out.accesses.map((a) => [a.stateId, a.optional]));
    assert.deepEqual(optional, { A: false, B: true });
  });

  test('Local<T> is excluded — it is not shared state (§7.1)', () => {
    const out = parse('fn main(){App::new().add_systems(Update, s);} fn s(t: Local<u32>, r: Res<Time>) {}');
    assert.deepEqual(out.accesses.map((a) => a.stateId), ['Time']);
  });

  test('generic args are part of the state key (§7.4)', () => {
    const out = parse(
      'fn main(){App::new().add_systems(Update, s);} fn s(a: ResMut<Assets<Mesh>>, b: ResMut<Assets<Image>>) {}',
    );
    assert.deepEqual(out.states.map((s) => s.id).sort(), ['Assets<Image>', 'Assets<Mesh>']);
  });

  test('turbofish yields one executor per instantiation (§6.2)', () => {
    const out = parse(
      'fn main(){App::new().add_systems(Update, (t::<Right>, t::<Left>));} fn t(q: Query<&A>) {}',
    );
    assert.deepEqual(out.executors.map((e) => e.display).sort(), ['t::<Left>', 't::<Right>']);
    assert.deepEqual(out.executors.map((e) => e.id).sort(), ['x::t::<Left>', 'x::t::<Right>']);
  });

  test('unregistered candidates are kept and flagged (§7)', () => {
    const out = parse('fn helper(q: Query<&A>) {}');
    assert.equal(out.executors.length, 1);
    assert.equal(out.executors[0]!.unregistered, true);
    assert.equal(out.executors[0]!.appScope, 'unknown');
  });

  test('cfg artifacts in a registration tuple are skipped (M0 finding, §7.6)', () => {
    const src = `fn main(){ App::new().add_systems(Update, (
        a,
        #[cfg(not(target_arch = "wasm32"))]
        b,
      )); }
      fn a(q: Query<&A>) {} fn b(q: Query<&B>) {}`;
    const out = parse(src);
    const registered = out.executors.filter((e) => !e.unregistered).map((e) => e.display).sort();
    assert.deepEqual(registered, ['a', 'b'], 'both real systems register despite the cfg parse error');
  });
});
