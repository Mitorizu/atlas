import type { AtlasIR, AccessMode } from './ir.ts';

export interface GraphNode {
  id: string;
  kind: 'executor' | 'state';
  label: string;
  /** For state nodes: component | resource | message | event | synthetic. */
  category?: string;
  schedule?: string;
  appScopes?: string[];
  unregistered?: boolean;
  ubiquitous?: boolean;
  /** For executors: ubiquitous state shown as a badge instead of an edge (§7.4). */
  badges?: Array<{ id: string; label: string; category: string; mode: string }>;
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
export interface BuildOptions {
  /**
   * Draw ubiquitous state as nodes anyway. Off by default: at corpus scale those hubs
   * weld unrelated apps into one component and make the layout unusable (§7.4).
   */
  materialiseHubs?: boolean;
}

export function buildGraph(ir: AtlasIR, options: BuildOptions = {}): Graph {
  const nodes: GraphNode[] = [];
  const hubs = new Map(
    options.materialiseHubs === true ? [] : ir.states.filter((s) => s.ubiquitous).map((s) => [s.id, s] as const),
  );

  const badgesFor = new Map<string, GraphNode['badges']>();
  for (const a of ir.accesses) {
    const hub = hubs.get(a.stateId);
    if (!hub) continue;
    const list = badgesFor.get(a.executorId) ?? [];
    if (!list.some((b) => b.id === hub.id)) {
      list.push({ id: hub.id, label: hub.display, category: hub.category, mode: a.mode });
    }
    badgesFor.set(a.executorId, list);
  }

  for (const e of ir.executors) {
    const badges = badgesFor.get(e.id);
    const badgeWidth = (badges ?? []).reduce((w, b) => w + b.label.length * 6 + 18, 0);
    const size = sizeFor(e.display, 'executor');
    nodes.push({
      id: e.id,
      kind: 'executor',
      label: e.display,
      ...(e.registration ? { schedule: e.registration.schedule } : {}),
      appScopes: e.appScopes,
      unregistered: e.unregistered,
      ...(badges && badges.length > 0 ? { badges } : {}),
      ...size,
      width: size.width + badgeWidth,
    });
  }
  for (const s of ir.states) {
    if (hubs.has(s.id)) continue;
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
