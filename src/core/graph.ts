import type { AtlasIR, AccessMode } from './ir.ts';

export interface GraphNode {
  id: string;
  kind: 'executor' | 'state';
  label: string;
  /** For state nodes: component | resource | message | event | synthetic. */
  category?: string;
  schedule?: string;
  appScope?: string;
  unregistered?: boolean;
  ubiquitous?: boolean;
  width: number;
  height: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  mode: AccessMode;
  /** `&mut T` draws one edge with arrowheads at both ends (§7.5). */
  doubleHeaded: boolean;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const CHAR_WIDTH = 7.6;
const PADDING = 34;

function sizeFor(label: string, kind: 'executor' | 'state'): { width: number; height: number } {
  return {
    width: Math.max(120, Math.round(label.length * CHAR_WIDTH + PADDING)),
    height: kind === 'executor' ? 46 : 38,
  };
}

/**
 * Bipartite graph construction (DESIGN.md §7.5).
 *
 * Reads point Data -> System; writes point System -> Data; `readwrite` is a single
 * System -> Data edge drawn with two arrowheads rather than two opposing edges.
 */
export function buildGraph(ir: AtlasIR): Graph {
  const nodes: GraphNode[] = [];

  for (const e of ir.executors) {
    nodes.push({
      id: e.id,
      kind: 'executor',
      label: e.display,
      ...(e.registration ? { schedule: e.registration.schedule } : {}),
      appScope: e.appScope,
      unregistered: e.unregistered,
      ...sizeFor(e.display, 'executor'),
    });
  }
  for (const s of ir.states) {
    nodes.push({
      id: s.id,
      kind: 'state',
      label: s.display,
      category: s.category,
      ubiquitous: s.ubiquitous,
      ...sizeFor(s.display, 'state'),
    });
  }

  const known = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (const a of ir.accesses) {
    if (!known.has(a.executorId) || !known.has(a.stateId)) continue;
    const dataToSystem = a.mode === 'read';
    const source = dataToSystem ? a.stateId : a.executorId;
    const target = dataToSystem ? a.executorId : a.stateId;
    const id = `${source}->${target}:${a.mode}`;
    if (seen.has(id)) continue;
    seen.add(id);
    edges.push({ id, source, target, mode: a.mode, doubleHeaded: a.mode === 'readwrite' });
  }

  return { nodes, edges };
}
