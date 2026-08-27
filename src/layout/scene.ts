import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import type { AtlasIR } from '../core/ir.ts';
import type { Graph, GraphEdge, GraphNode } from '../core/graph.ts';
import { assignGroups, type GroupMode } from './tiers.ts';

/**
 * One nested scene, replacing the three precomputed tiers (DESIGN.md §9.2).
 *
 * Tiers switched the whole map between three states at once. This is the Google Earth
 * model instead: every region is always present, and its contents reveal based on *that
 * region's* apparent size — zooming into one region leaves the others as boxes, the way
 * zooming into Europe does not load Asia's streets.
 *
 * Geometry is still computed once, offline. Member positions are stored RELATIVE to their
 * region so the viewer can nest them directly and a region can open without anything
 * moving.
 */

export const SCENE_VERSION = 2;

export interface SceneMember {
  id: string;
  kind: 'executor' | 'state';
  label: string;
  /** Relative to the region's origin. */
  x: number;
  y: number;
  width: number;
  height: number;
  category?: string;
  schedule?: string;
  unregistered?: boolean;
  badges?: GraphNode['badges'];
  /** How much state this touches. Drives reveal order: capitals before towns. */
  importance: number;
}

export interface SceneRegion {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  executorCount: number;
  stateCount: number;
  /** Sorted by importance descending, then id — deterministic. */
  members: SceneMember[];
  /** Shown on the collapsed box. */
  topState: Array<{ id: string; label: string; category: string }>;
}

export interface Scene {
  version: number;
  regions: SceneRegion[];
  /** State shared between regions; lives at the top level, never inside a box. */
  shared: SceneMember[];
  /** Real relations. The viewer re-targets these to whatever is currently visible. */
  edges: GraphEdge[];
  /** Region id for every member and shared node, so edges can be re-targeted. */
  ownerOf: Record<string, string>;
  width: number;
  height: number;
}

const PADDING = 26;

export async function layoutScene(graph: Graph, ir: AtlasIR, mode: GroupMode = 'crate'): Promise<Scene> {
  const assignment = assignGroups(ir, mode);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const degree = new Map<string, number>();
  for (const access of ir.accesses) {
    degree.set(access.executorId, (degree.get(access.executorId) ?? 0) + 1);
    degree.set(access.stateId, (degree.get(access.stateId) ?? 0) + 1);
  }

  const grouped = new Map<string, GraphNode[]>();
  const loose: GraphNode[] = [];
  for (const node of graph.nodes) {
    const group = assignment.get(node.id);
    if (group === undefined) {
      loose.push(node);
      continue;
    }
    const list = grouped.get(group);
    if (list) list.push(node);
    else grouped.set(group, [node]);
  }

  const request: ElkNode = {
    id: 'root',
    // rectpacking at the root, layered inside each region: measured at M7, a layered root
    // ignores elk.aspectRatio and stacks regions into a 0.31-aspect column.
    layoutOptions: {
      'elk.algorithm': 'rectpacking',
      'elk.aspectRatio': '1.6',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.spacing.nodeNode': '30',
      'elk.padding': `[top=${PADDING},left=${PADDING},bottom=${PADDING},right=${PADDING}]`,
    },
    children: [
      ...[...grouped].map(([group, members]) => ({
        id: `region:${group}`,
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': 'RIGHT',
          'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
          'elk.layered.spacing.nodeNodeBetweenLayers': '70',
          'elk.spacing.nodeNode': '24',
          'elk.padding': `[top=${PADDING + 20},left=${PADDING},bottom=${PADDING},right=${PADDING}]`,
        },
        children: members.map((n) => ({ id: n.id, width: n.width, height: n.height })),
      })),
      ...loose.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    ],
    edges: graph.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };

  const result = await new ELK().layout(request);

  const toMember = (node: GraphNode, x: number, y: number): SceneMember => ({
    id: node.id,
    kind: node.kind,
    label: node.label,
    x,
    y,
    width: node.width,
    height: node.height,
    ...(node.category !== undefined ? { category: node.category } : {}),
    ...(node.schedule !== undefined ? { schedule: node.schedule } : {}),
    ...(node.unregistered !== undefined ? { unregistered: node.unregistered } : {}),
    ...(node.badges !== undefined ? { badges: node.badges } : {}),
    importance: degree.get(node.id) ?? 0,
  });

  const regions: SceneRegion[] = [];
  const shared: SceneMember[] = [];
  const ownerOf: Record<string, string> = {};

  for (const child of result.children ?? []) {
    if (!child.id.startsWith('region:')) {
      const node = byId.get(child.id);
      if (node) shared.push(toMember(node, child.x ?? 0, child.y ?? 0));
      continue;
    }

    const members: SceneMember[] = [];
    const topState: SceneRegion['topState'] = [];
    let executorCount = 0;
    let stateCount = 0;

    for (const entry of child.children ?? []) {
      const node = byId.get(entry.id);
      if (!node) continue;
      // Relative coordinates: a region can open without anything moving.
      members.push(toMember(node, entry.x ?? 0, entry.y ?? 0));
      ownerOf[node.id] = child.id;
      if (node.kind === 'executor') executorCount++;
      else stateCount++;
    }

    // Capitals before towns: reveal order is importance, ties broken on id.
    members.sort((a, b) => b.importance - a.importance || (a.id < b.id ? -1 : 1));
    for (const member of members) {
      if (member.kind === 'state' && topState.length < 4) {
        topState.push({ id: member.id, label: member.label, category: member.category ?? 'synthetic' });
      }
    }

    regions.push({
      id: child.id,
      label: child.id.slice('region:'.length),
      x: child.x ?? 0,
      y: child.y ?? 0,
      width: child.width ?? 0,
      height: child.height ?? 0,
      executorCount,
      stateCount,
      members,
      topState,
    });
  }

  regions.sort((a, b) => (a.id < b.id ? -1 : 1));

  return {
    version: SCENE_VERSION,
    regions,
    shared,
    edges: graph.edges,
    ownerOf,
    width: result.width ?? 0,
    height: result.height ?? 0,
  };
}
