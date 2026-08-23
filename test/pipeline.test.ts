import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildGraph } from '../src/core/graph.ts';
import { layout } from '../src/layout/elk.ts';
import { extractCorpus, modulePathFor, rustFiles } from '../src/cli/extract.ts';
import type { AtlasIR } from '../src/core/ir.ts';
import { findBevyExamples } from './corpus.ts';

const dir = findBevyExamples();
const skip = dir ? false : 'bevy 0.19 corpus not in cargo cache';

const ir: AtlasIR = {
  dialect: 'test',
  executors: [
    { id: 'm::s', display: 's', kind: 'system', appScope: 'm', unregistered: false, signature: 'fn s()',
      loc: { file: 'm.rs', line: 1, col: 1, byteStart: 0, byteEnd: 1 } },
  ],
  states: [
    { id: 'R', display: 'R', category: 'resource', ubiquitous: false },
    { id: 'C', display: 'C', category: 'component', ubiquitous: false },
  ],
  accesses: [
    { executorId: 'm::s', stateId: 'R', mode: 'read', optional: false,
      loc: { file: 'm.rs', line: 1, col: 1, byteStart: 0, byteEnd: 1 } },
    { executorId: 'm::s', stateId: 'C', mode: 'readwrite', optional: false,
      loc: { file: 'm.rs', line: 1, col: 1, byteStart: 0, byteEnd: 1 } },
  ],
};

describe('M1: graph construction (§7.5)', () => {
  test('reads point Data -> System, writes point System -> Data', () => {
    const g = buildGraph(ir);
    const read = g.edges.find((e) => e.mode === 'read')!;
    const rw = g.edges.find((e) => e.mode === 'readwrite')!;
    assert.equal(read.source, 'R');
    assert.equal(read.target, 'm::s');
    assert.equal(rw.source, 'm::s');
    assert.equal(rw.target, 'C');
  });

  test('readwrite is ONE double-headed edge, not two opposing edges', () => {
    const g = buildGraph(ir);
    assert.equal(g.edges.filter((e) => e.source === 'm::s' || e.target === 'm::s').length, 2);
    assert.equal(g.edges.find((e) => e.mode === 'readwrite')!.doubleHeaded, true);
    assert.equal(g.edges.find((e) => e.mode === 'read')!.doubleHeaded, false);
  });

  test('accesses referencing an unknown node are dropped rather than crashing', () => {
    const g = buildGraph({
      ...ir,
      accesses: [...ir.accesses, { ...ir.accesses[0]!, stateId: 'ghost' }],
    });
    assert.equal(g.edges.length, 2);
  });
});

describe('M1: layout (§9.2)', () => {
  test('left-to-right places readers left of the system and writes right of it', async () => {
    const positioned = await layout(buildGraph(ir));
    const x = Object.fromEntries(positioned.nodes.map((n) => [n.id, n.x]));
    assert.ok(x['R']! < x['m::s']!, 'read source sits left of the system');
    assert.ok(x['m::s']! < x['C']!, 'written state sits right of the system');
    assert.ok(positioned.width > 0 && positioned.height > 0);
  });

  test('every node receives a position', async () => {
    const positioned = await layout(buildGraph(ir));
    assert.equal(positioned.nodes.length, 3);
    for (const n of positioned.nodes) {
      assert.equal(Number.isFinite(n.x) && Number.isFinite(n.y), true, `${n.id} unpositioned`);
    }
  });
});

describe('M1: CLI', () => {
  test('module paths come from position, not file name alone', () => {
    assert.equal(modulePathFor('/c', '/c/2d/move_sprite.rs', false), '2d::move_sprite');
    assert.equal(modulePathFor('/c/a/move_sprite.rs', '/c/a/move_sprite.rs', true), 'move_sprite');
  });

  test('end-to-end artifact for the slice fixture', { skip }, async () => {
    const artifact = await extractCorpus(join(dir!, '2d', 'move_sprite.rs'));
    assert.equal(artifact.meta.dialect, 'bevy-0.19');
    assert.equal(artifact.meta.filesWithParseErrors, 0);
    assert.equal(artifact.ir.executors.length, 2);
    assert.equal(artifact.layout.nodes.length, 7);
    assert.equal(artifact.layout.edges.length, 5);
  });

  test('file walking skips build output directories', { skip }, () => {
    const files = rustFiles(join(dir!, '2d'));
    assert.ok(files.length > 10);
    assert.ok(files.every((f) => !f.includes('/target/')));
  });
});
