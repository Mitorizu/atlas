/**
 * Layout scalability probe: how ELK behaves on a whole corpus (DESIGN.md §9.2).
 * Run: npx tsx scripts/layout-probe.ts
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import { extractIR } from './corpus-stats.ts';
import { buildGraph } from '../src/core/graph.ts';
import { findBevyExamples } from '../test/corpus.ts';

async function main() {
const graph = buildGraph(extractIR(findBevyExamples()!).ir);
console.log(`graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

// How fragmented is it? 400 example apps should mean many components.
const adj = new Map<string, string[]>();
for (const n of graph.nodes) adj.set(n.id, []);
for (const e of graph.edges) { adj.get(e.source)?.push(e.target); adj.get(e.target)?.push(e.source); }
const seen = new Set<string>();
let components = 0, largest = 0;
for (const n of graph.nodes) {
  if (seen.has(n.id)) continue;
  components++;
  let size = 0;
  const stack = [n.id];
  seen.add(n.id);
  while (stack.length) { const c = stack.pop()!; size++; for (const m of adj.get(c) ?? []) if (!seen.has(m)) { seen.add(m); stack.push(m); } }
  largest = Math.max(largest, size);
}
console.log(`connected components: ${components}, largest: ${largest}`);

const configs: Record<string, Record<string, string>> = {
  'stacked (current)': {},
  'NETWORK_SIMPLEX placement': { 'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX' },
  'packed aspectRatio 1.6': { 'elk.aspectRatio': '1.6' },
  'packed + separateComponents': { 'elk.aspectRatio': '1.6', 'elk.separateConnectedComponents': 'true' },
};

for (const [label, opts] of Object.entries(configs)) {
  const layoutOptions: Record<string, string> = {
    'elk.algorithm': 'layered',
    'elk.direction': 'RIGHT',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    'elk.layered.spacing.nodeNodeBetweenLayers': '90',
    'elk.spacing.nodeNode': '28',
    ...opts,
  };

  const request: ElkNode = {
    id: 'root',
    layoutOptions,
    children: graph.nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: graph.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const started = Date.now();
  try {
    const r = await new ELK().layout(request);
    console.log(`  ${label.padEnd(28)} OK  ${Date.now() - started}ms  ${Math.round(r.width ?? 0)}x${Math.round(r.height ?? 0)}`);
  } catch (e) {
    console.log(`  ${label.padEnd(28)} FAIL ${Date.now() - started}ms  ${(e as Error).message.slice(0, 50)}`);
  }
}
}
main().catch((e) => { console.error(e); process.exit(1); });
