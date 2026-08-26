import { useCallback, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, MarkerType, type Edge, type Node } from '@xyflow/react';
import { nodeTypes, type Badge, type DataNodeData, type GroupData, type SystemData } from './nodes.tsx';
import { edgeStyle, EDGE_COLOR } from './theme.ts';
import { useLodTier, type Tier } from './lod.ts';
import type { Artifact, LayoutEdge, LayoutNode } from './artifact.ts';

interface GroupNodeShape {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  executors: number;
  states: number;
  topState: Array<{ id: string; label: string; category: string }>;
}

function isGroup(node: unknown): node is GroupNodeShape {
  return typeof node === 'object' && node !== null && 'executors' in node;
}

function toEdges(edges: LayoutEdge[], ghost: (id: string) => boolean): Edge[] {
  return edges.map((e) => {
    const style = edgeStyle(e.mode);
    const color = EDGE_COLOR[e.mode] ?? EDGE_COLOR['read']!;
    const head = e.mode === 'read' ? MarkerType.Arrow : MarkerType.ArrowClosed;
    const faded = ghost(e.source) || ghost(e.target);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      style: faded ? { ...style, opacity: 0.35, strokeDasharray: '2 4' } : style,
      markerEnd: { type: head, color, width: 18, height: 18 },
      ...(e.doubleHeaded ? { markerStart: { type: head, color, width: 18, height: 18 } } : {}),
      animated: false,
    };
  });
}

function toNode(n: LayoutNode, artifact: Artifact, detail: boolean): Node {
  const meta = artifact.focus?.meta[n.id];
  const shared = { role: meta?.role ?? null, conflicted: meta?.conflicted ?? false, seed: meta?.seed ?? false };
  return n.kind === 'executor'
    ? {
        id: n.id,
        type: 'system',
        position: { x: n.x, y: n.y },
        data: {
          label: n.label,
          // Detail reveals the schedule and badges; Street keeps the node terse (§9.2).
          schedule: detail ? n.schedule : undefined,
          unregistered: n.unregistered,
          badges: detail ? (n.badges as Badge[] | undefined) : undefined,
          ...shared,
        } satisfies SystemData,
      }
    : {
        id: n.id,
        type: 'data',
        position: { x: n.x, y: n.y },
        data: { label: n.label, category: n.category ?? 'synthetic', ubiquitous: n.ubiquitous, ...shared } satisfies DataNodeData,
      };
}

export function Canvas({
  artifact,
  onSelect,
  onDeselect,
}: {
  artifact: Artifact;
  onSelect: (id: string) => void;
  onDeselect: () => void;
}) {
  const hasTiers = artifact.tiers !== undefined && artifact.meta.mode !== 'focus';
  const [override, setOverride] = useState<Tier | null>(null);
  const auto = useLodTier(hasTiers && override === null);
  // A whole-codebase map opens at Orbit: the regions are the point, and Street on a real
  // workspace is a few hundred nodes at once. A focus view has no tiers and stays flat.
  const [touched, setTouched] = useState(false);
  const tier: Tier = hasTiers ? (override ?? (touched ? auto : 'orbit')) : 'street';

  const { nodes, edges } = useMemo(() => {
    const ghost = (id: string): boolean => artifact.focus?.meta[id]?.role === 'removed';

    if (hasTiers && tier === 'orbit' && artifact.tiers) {
      const orbit = artifact.tiers.orbit;
      const flowNodes: Node[] = orbit.nodes.map((n) =>
        isGroup(n)
          ? {
              id: n.id,
              type: 'group',
              position: { x: n.x, y: n.y },
              data: {
                label: n.label,
                executors: n.executors,
                states: n.states,
                width: n.width,
                height: n.height,
                topState: n.topState,
              } satisfies GroupData,
            }
          : toNode(n as LayoutNode, artifact, false),
      );
      return { nodes: flowNodes, edges: toEdges(orbit.edges, ghost) };
    }

    const source = hasTiers && artifact.tiers ? artifact.tiers.street : artifact.layout;
    return {
      nodes: source.nodes.map((n) => toNode(n as LayoutNode, artifact, tier === 'detail' || !hasTiers)),
      edges: toEdges(source.edges, ghost),
    };
  }, [artifact, hasTiers, tier]);

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      if (node.type !== 'group') onSelect(node.id);
    },
    [onSelect],
  );

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={onDeselect}
        onMoveStart={() => setTouched(true)}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.01}
      >
        <Background gap={22} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {hasTiers ? (
        <div className="tier-indicator" title="Semantic zoom tier — follows zoom, or pin one">
          {(['orbit', 'street', 'detail'] as const).map((name) => (
            <button
              key={name}
              type="button"
              className={tier === name ? 'active' : ''}
              onClick={() => setOverride(override === name ? null : name)}
            >
              {name}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
