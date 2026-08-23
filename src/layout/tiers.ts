import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import type { AtlasIR } from '../core/ir.ts';
import type { Graph, GraphEdge, GraphNode } from '../core/graph.ts';
import type { PositionedNode } from './elk.ts';

/**
 * Three precomputed LOD tiers (DESIGN.md §9.2).
 *
 * Tiers are laid out once, offline, from ONE hierarchical ELK run, so their coordinates
 * are spatially coherent: a group's Orbit position is exactly the bounding box of its
 * members at Street. Without that, switching tiers teleports the view.
 *
 * Detail shares Street's geometry — it reveals more per node, it does not move anything.
 */

export interface GroupNode {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  executors: number;
  states: number;
  /** Aggregate badges shown instead of member state at Orbit. */
  topState: Array<{ id: string; label: string; category: string }>;
}

export interface Tiers {
  /** Regions only: one node per module group, plus the state shared between them. */
  orbit: { nodes: Array<GroupNode | PositionedNode>; edges: GraphEdge[] };
  /** Every executor and non-hub state, positioned inside its group. */
  street: { nodes: PositionedNode[]; edges: GraphEdge[]; groups: GroupNode[] };
  width: number;
  height: number;
}

/**
 * The group a node belongs to: its top-level module segment.
 *
 * For `examples/` that is the example category (`2d`, `3d`, `ui`); for a multi-crate repo
 * it is the crate. State is grouped only when a single group touches it — state that
 * several groups share is a bridge and stays at the top level, which is exactly the
 * cross-cutting structure the orientation view exists to show.
 */
export function groupOf(modulePath: string): string {
  const [head] = modulePath.split('::');
  return head ?? modulePath;
}

export function assignGroups(ir: AtlasIR): Map<string, string> {
  const assignment = new Map<string, string>();
  for (const executor of ir.executors) assignment.set(executor.id, groupOf(executor.id));

  const touchedBy = new Map<string, Set<string>>();
  for (const access of ir.accesses) {
    const group = assignment.get(access.executorId);
    if (group === undefined) continue;
    const set = touchedBy.get(access.stateId);
    if (set) set.add(group);
    else touchedBy.set(access.stateId, new Set([group]));
  }
  for (const [stateId, groups] of touchedBy) {
    if (groups.size === 1) assignment.set(stateId, [...groups][0]!);
  }
  return assignment;
}

const PADDING = 26;

/** Runs one hierarchical layout and derives both tiers from it. */
export async function layoutTiers(graph: Graph, ir: AtlasIR): Promise<Tiers> {
  const assignment = assignGroups(ir);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const grouped = new Map<string, GraphNode[]>();
  const ungrouped: GraphNode[] = [];
  for (const node of graph.nodes) {
    const group = assignment.get(node.id);
    if (group === undefined) {
      ungrouped.push(node);
      continue;
    }
    const list = grouped.get(group);
    if (list) list.push(node);
    else grouped.set(group, [node]);
  }

  const request: ElkNode = {
    id: 'root',
    // Root PACKS the groups; each group lays its own members out left-to-right.
    //
    // Measured at M7 on the full corpus: a layered root produces 20994x66748 (aspect 0.31)
    // and ignores `elk.aspectRatio` entirely — the M3 finding, now explained. `rectpacking`
    // honours it and yields 17696x15020 (aspect 1.18) four times faster. The cost is that
    // group PLACEMENT no longer encodes dataflow direction; within a group it still does,
    // and for an orientation view seeing the regions matters more.
    layoutOptions: {
      'elk.algorithm': 'rectpacking',
      'elk.aspectRatio': '1.6',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.spacing.nodeNode': '30',
      'elk.padding': `[top=${PADDING},left=${PADDING},bottom=${PADDING},right=${PADDING}]`,
    },
    children: [
      ...[...grouped].map(([group, members]) => ({
        id: `group:${group}`,
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': 'RIGHT',
          'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
          'elk.layered.spacing.nodeNodeBetweenLayers': '70',
          'elk.spacing.nodeNode': '24',
          'elk.padding': `[top=${PADDING + 14},left=${PADDING},bottom=${PADDING},right=${PADDING}]`,
        },
        children: members.map((n) => ({ id: n.id, width: n.width, height: n.height })),
      })),
      ...ungrouped.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    ],
    edges: graph.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };

  const result = await new ELK().layout(request);

  // Flatten to absolute coordinates; ELK reports children relative to their parent.
  const street: PositionedNode[] = [];
  const groups: GroupNode[] = [];

  for (const child of result.children ?? []) {
    if (!child.id.startsWith('group:')) {
      const node = byId.get(child.id);
      if (node) street.push({ ...node, x: child.x ?? 0, y: child.y ?? 0 });
      continue;
    }

    const groupId = child.id.slice('group:'.length);
    const originX = child.x ?? 0;
    const originY = child.y ?? 0;
    let executors = 0;
    let states = 0;
    const stateSeen: Array<{ id: string; label: string; category: string }> = [];

    for (const member of child.children ?? []) {
      const node = byId.get(member.id);
      if (!node) continue;
      street.push({ ...node, x: originX + (member.x ?? 0), y: originY + (member.y ?? 0) });
      if (node.kind === 'executor') executors++;
      else {
        states++;
        if (stateSeen.length < 4) {
          stateSeen.push({ id: node.id, label: node.label, category: node.category ?? 'synthetic' });
        }
      }
    }

    groups.push({
      id: child.id,
      label: groupId,
      x: originX,
      y: originY,
      width: child.width ?? 0,
      height: child.height ?? 0,
      executors,
      states,
      topState: stateSeen,
    });
  }

  // Orbit: one node per group, plus shared state, with edges aggregated between them.
  const groupFor = (nodeId: string): string => {
    const group = assignment.get(nodeId);
    return group === undefined ? nodeId : `group:${group}`;
  };
  const orbitEdges = new Map<string, GraphEdge>();

  // Only the most-connected shared state appears at Orbit. All 101 bridges rendered at
  // once is a clump, not a map; the top few are the cross-cutting structure worth seeing.
  const degree = new Map<string, number>();
  for (const access of ir.accesses) degree.set(access.stateId, (degree.get(access.stateId) ?? 0) + 1);
  const sharedState = street
    .filter((n) => !assignment.has(n.id))
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .slice(0, 12);

  const orbitIds = new Set([...groups.map((g) => g.id), ...sharedState.map((n) => n.id)]);
  for (const edge of graph.edges) {
    const source = groupFor(edge.source);
    const target = groupFor(edge.target);
    if (source === target || !orbitIds.has(source) || !orbitIds.has(target)) continue;
    const id = `${source}->${target}:${edge.mode}`;
    if (!orbitEdges.has(id)) orbitEdges.set(id, { ...edge, id, source, target });
  }

  return {
    orbit: { nodes: [...groups, ...sharedState], edges: [...orbitEdges.values()] },
    street: { nodes: street, edges: graph.edges, groups },
    width: result.width ?? 0,
    height: result.height ?? 0,
  };
}
