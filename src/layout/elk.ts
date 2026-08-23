import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import type { Graph, GraphNode } from '../core/graph.ts';

export interface PositionedNode extends GraphNode {
  x: number;
  y: number;
}

export interface LayoutedGraph {
  nodes: PositionedNode[];
  edges: Graph['edges'];
  width: number;
  height: number;
}

/**
 * Left-to-right layered layout (DESIGN.md §9.2). Runs offline in the CLI; the browser
 * never runs a layout algorithm. `hierarchyHandling` is set now so that the three
 * precomputed LOD tiers at Milestone 7 stay spatially coherent.
 */
export async function layout(graph: Graph): Promise<LayoutedGraph> {
  const elk = new ELK();
  const request: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.spacing.nodeNode': '28',
      // NETWORK_SIMPLEX overflows the call stack on the full examples corpus
      // (2,018 nodes / 3,911 edges); BRANDES_KOEPF completes in ~13s. Measured at M2 with
      // scripts/layout-probe.ts.
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    },
    children: graph.nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: graph.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const result = await elk.layout(request);

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodes: PositionedNode[] = (result.children ?? []).map((c) => {
    const node = byId.get(c.id);
    if (!node) throw new Error(`ELK returned an unknown node: ${c.id}`);
    return { ...node, x: c.x ?? 0, y: c.y ?? 0 };
  });

  return { nodes, edges: graph.edges, width: result.width ?? 0, height: result.height ?? 0 };
}
