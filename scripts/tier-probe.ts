/**
 * Probes root layout algorithms for packing module groups (DESIGN.md §9.2).
 * Run: npx tsx scripts/tier-probe.ts
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import { extractIR } from './corpus-stats.ts';
import { buildGraph } from '../src/core/graph.ts';
import { assignGroups } from '../src/layout/tiers.ts';
import { findBevyExamples } from '../test/corpus.ts';

async function main() {
  const { ir } = extractIR(findBevyExamples()!);
  const graph = buildGraph(ir);
  const assignment = assignGroups(ir);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const grouped = new Map<string, typeof graph.nodes>();
  const loose: typeof graph.nodes = [];
  for (const n of graph.nodes) {
    const g = assignment.get(n.id);
    if (g === undefined) { loose.push(n); continue; }
    const l = grouped.get(g); if (l) l.push(n); else grouped.set(g, [n]);
  }

  const configs: Array<[string, Record<string, string>]> = [
    ['layered (current)', { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT' }],
    ['layered + aspect 1.6', { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.aspectRatio': '1.6' }],
    ['rectpacking 1.6', { 'elk.algorithm': 'rectpacking', 'elk.aspectRatio': '1.6' }],
    ['box 1.6', { 'elk.algorithm': 'box', 'elk.aspectRatio': '1.6' }],
    ['force', { 'elk.algorithm': 'force' }],
  ];

  for (const [label, rootOptions] of configs) {
    const request: ElkNode = {
      id: 'root',
      layoutOptions: { 'elk.hierarchyHandling': 'INCLUDE_CHILDREN', 'elk.padding': '[top=26,left=26,bottom=26,right=26]', ...rootOptions },
      children: [
        ...[...grouped].map(([g, members]) => ({
          id: `group:${g}`,
          layoutOptions: {
            'elk.algorithm': 'layered', 'elk.direction': 'RIGHT',
            'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
            'elk.padding': '[top=40,left=26,bottom=26,right=26]',
          },
          children: members.map((n) => ({ id: n.id, width: n.width, height: n.height })),
        })),
        ...loose.map((n) => ({ id: n.id, width: n.width, height: n.height })),
      ],
      edges: graph.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    };
    const t = Date.now();
    try {
      const r = await new ELK().layout(request);
      const w = Math.round(r.width ?? 0), h = Math.round(r.height ?? 0);
      console.log(`  ${label.padEnd(22)} ${String(w).padStart(6)}x${String(h).padStart(6)}  aspect ${(w/h).toFixed(2)}  ${Date.now()-t}ms`);
    } catch (e) { console.log(`  ${label.padEnd(22)} FAIL ${(e as Error).message.slice(0,40)}`); }
  }
  console.log(`  (${byId.size} nodes, ${grouped.size} groups, ${loose.length} shared)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
