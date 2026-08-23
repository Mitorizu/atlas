import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractSources } from './helpers.ts';
import { unifyStateKeys, orphanPluginScope, WHOLE_REPO_SCOPE } from '../src/dialects/bevy-0.19/link.ts';
import { buildGraph } from '../src/core/graph.ts';
import type { AtlasIR } from '../src/core/ir.ts';

const sys = (name: string, body = '&A') => `fn ${name}(q: Query<${body}>) {}`;
const scopesOf = (out: { executors: Array<{ display: string; appScopes: string[] }> }, name: string) =>
  out.executors.find((e) => e.display === name)!.appScopes;

describe('M3: plugin -> App resolution (§7.3 pass 4)', () => {
  test('a system registered inside a plugin inherits the scope of the app that adds it', () => {
    const { output } = extractSources({
      main: 'fn main(){ App::new().add_plugins(MyPlugin).run(); }',
      plug: `impl Plugin for MyPlugin { fn build(&self, app: &mut App) { app.add_systems(Update, tick); } } ${sys('tick')}`,
    });
    assert.deepEqual(scopesOf(output, 'tick'), ['main']);
  });

  test('scope propagates through nested plugins', () => {
    const { output } = extractSources({
      main: 'fn main(){ App::new().add_plugins(Outer).run(); }',
      outer: 'impl Plugin for Outer { fn build(&self, app: &mut App) { app.add_plugins(Inner); } }',
      inner: `impl Plugin for Inner { fn build(&self, app: &mut App) { app.add_systems(Update, deep); } } ${sys('deep')}`,
    });
    assert.deepEqual(scopesOf(output, 'deep'), ['main']);
  });

  test('PluginGroup members are expanded', () => {
    const { output } = extractSources({
      main: 'fn main(){ App::new().add_plugins(MyGroup).run(); }',
      group: 'impl PluginGroup for MyGroup { fn build(self) -> PluginGroupBuilder { PluginGroupBuilder::start::<Self>().add(Member) } }',
      member: `impl Plugin for Member { fn build(&self, app: &mut App) { app.add_systems(Update, go); } } ${sys('go')}`,
    });
    assert.deepEqual(scopesOf(output, 'go'), ['main']);
  });

  test('a system registered by two apps belongs to both (§7.3)', () => {
    const { output } = extractSources({
      server: 'fn main(){ App::new().add_plugins(Shared).run(); }',
      viewer: 'fn main(){ App::new().add_plugins(Shared).run(); }',
      shared: `impl Plugin for Shared { fn build(&self, app: &mut App) { app.add_systems(Update, both); } } ${sys('both')}`,
    });
    assert.deepEqual(scopesOf(output, 'both').sort(), ['server', 'viewer']);
  });

  test('a plugin no App adds becomes its own scope rather than scopeless (§7.3 fallback 2b)', () => {
    const { output, coverage } = extractSources({
      // An unrelated App root exists, so the whole-repo fallback must NOT fire.
      other: 'fn main(){ App::new().run(); }',
      lib: `impl Plugin for LibPlugin { fn build(&self, app: &mut App) { app.add_systems(Update, work); } } ${sys('work')}`,
    });
    assert.deepEqual(scopesOf(output, 'work'), [orphanPluginScope('LibPlugin')]);
    assert.equal(coverage.wholeRepoFallback, false);
    assert.equal(coverage.pluginsReachable, 0, 'LibPlugin is reachable from no App root');
  });

  test('no App::new anywhere falls back to one repo-wide scope (§7.3 fallback 2)', () => {
    const { output, coverage } = extractSources({ lib: `fn main(){} ${sys('solo')}` });
    assert.equal(coverage.wholeRepoFallback, true);
    assert.deepEqual(scopesOf(output, 'solo'), [WHOLE_REPO_SCOPE]);
  });

  test('registrations bind across files', () => {
    const { output, coverage } = extractSources({
      app: 'fn main(){ App::new().add_systems(Update, elsewhere); }',
      other: sys('elsewhere'),
    });
    assert.equal(output.executors.find((e) => e.display === 'elsewhere')!.unregistered, false);
    assert.equal(coverage.registrationsResolved, 1);
  });

  test('an ambiguous bare name resolves to nothing rather than to an arbitrary match (§6.2)', () => {
    const { output, coverage } = extractSources({
      app: 'fn main(){ App::new().add_systems(Update, setup); }',
      a: sys('setup'),
      b: sys('setup', '&B'),
    });
    assert.equal(coverage.registrationsResolved, 0);
    assert.ok(output.executors.every((e) => e.unregistered), 'neither candidate may be bound');
  });
});

describe('M3: state key unification (§6.2)', () => {
  test('one qualified spelling merges with the bare name', () => {
    const map = unifyStateKeys(['Assets<Mesh>', 'bevy_asset::Assets<Mesh>']);
    assert.equal(map.get('Assets<Mesh>')!.id, 'Assets<Mesh>');
    assert.equal(map.get('bevy_asset::Assets<Mesh>')!.id, 'Assets<Mesh>');
  });

  test('two competing qualified spellings stay separate and are flagged', () => {
    const map = unifyStateKeys(['bevy_ui::Node', 'petgraph::Node']);
    assert.equal(map.get('bevy_ui::Node')!.id, 'bevy_ui::Node');
    assert.equal(map.get('petgraph::Node')!.id, 'petgraph::Node');
    assert.ok(map.get('bevy_ui::Node')!.ambiguous && map.get('petgraph::Node')!.ambiguous);
  });

  test('generic arguments are not conflated by unification', () => {
    const map = unifyStateKeys(['bevy_asset::Assets<Mesh>', 'Assets<Image>']);
    assert.equal(map.get('bevy_asset::Assets<Mesh>')!.id, 'Assets<Mesh>');
    assert.equal(map.get('Assets<Image>')!.id, 'Assets<Image>');
  });

  test('accesses written two ways land on one node end to end', () => {
    const { output } = extractSources({
      app: `fn main(){ App::new().add_systems(Update, (a, b)); }
            fn a(r: Res<bevy_time::Time>) {} fn b(r: Res<Time>) {}`,
    });
    assert.deepEqual(output.states.map((s) => s.id), ['Time']);
    assert.equal(output.accesses.length, 2);
  });
});

describe('M3: hub demotion (§7.4)', () => {
  /** One state touched by many systems, one touched by few. */
  const manySystems = (n: number): AtlasIR => {
    const executors = Array.from({ length: n }, (_, i) => ({
      id: `m::s${i}`, display: `s${i}`, kind: 'system' as const, appScopes: ['m'],
      unregistered: false, signature: '', loc: { file: 'm.rs', line: 1, col: 1, byteStart: 0, byteEnd: 1 },
    }));
    const loc = { file: 'm.rs', line: 1, col: 1, byteStart: 0, byteEnd: 1 };
    return {
      dialect: 't',
      executors,
      states: [
        { id: 'Time', display: 'Time', category: 'resource', ubiquitous: true },
        { id: 'Rare', display: 'Rare', category: 'component', ubiquitous: false },
      ],
      accesses: [
        ...executors.map((e) => ({ executorId: e.id, stateId: 'Time', mode: 'read' as const, optional: false, loc })),
        { executorId: 'm::s0', stateId: 'Rare', mode: 'readwrite' as const, optional: false, loc },
      ],
      setOrderings: [],
    };
  };

  test('a ubiquitous state is not drawn as a node and its edges disappear', () => {
    const g = buildGraph(manySystems(40));
    assert.ok(!g.nodes.some((n) => n.id === 'Time'), 'Time must not be a node');
    assert.ok(g.nodes.some((n) => n.id === 'Rare'), 'ordinary state stays a node');
    assert.equal(g.edges.length, 1, 'only the non-hub edge survives');
  });

  test('demoted state reappears as a badge on each consumer', () => {
    const g = buildGraph(manySystems(40));
    const node = g.nodes.find((n) => n.id === 'm::s0')!;
    assert.deepEqual(node.badges?.map((b) => b.label), ['Time']);
  });

  test('materialiseHubs restores them for a focused view', () => {
    const g = buildGraph(manySystems(40), { materialiseHubs: true });
    assert.ok(g.nodes.some((n) => n.id === 'Time'));
    assert.equal(g.edges.length, 41);
  });
});
