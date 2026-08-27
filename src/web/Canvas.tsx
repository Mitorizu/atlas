import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
} from '@xyflow/react';
import { nodeTypes, type Badge, type DataNodeData, type GroupData, type SystemData } from './nodes.tsx';
import { edgeStyle, EDGE_COLOR } from './theme.ts';
import { computeReveal, retargetEdges, DEFAULT_BUDGET, type Detail, type RevealState } from './reveal.ts';
import type { Artifact, LayoutEdge, LayoutNode } from './artifact.ts';
import type { Scene, SceneMember } from '../layout/scene.ts';

function toEdges(edges: Array<LayoutEdge & { weight?: number }>, ghost: (id: string) => boolean): Edge[] {
  return edges.map((e) => {
    const style = edgeStyle(e.mode);
    const color = EDGE_COLOR[e.mode] ?? EDGE_COLOR['read']!;
    const head = e.mode === 'read' ? MarkerType.Arrow : MarkerType.ArrowClosed;
    const faded = ghost(e.source) || ghost(e.target);
    // An aggregated line is drawn heavier, so a bundle reads as a bundle.
    const weight = e.weight ?? 1;
    const width = (style.strokeWidth ?? 1.4) * (weight > 1 ? Math.min(3, 1 + Math.log10(weight)) : 1);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      style: faded ? { ...style, strokeWidth: width, opacity: 0.35, strokeDasharray: '2 4' } : { ...style, strokeWidth: width },
      markerEnd: { type: head, color, width: 18, height: 18 },
      ...(e.doubleHeaded ? { markerStart: { type: head, color, width: 18, height: 18 } } : {}),
      animated: false,
    };
  });
}

function memberNode(member: SceneMember, parentId: string | null, detail: Detail, artifact: Artifact): Node {
  const meta = artifact.focus?.meta[member.id];
  const shared = { role: meta?.role ?? null, conflicted: meta?.conflicted ?? false, seed: meta?.seed ?? false };
  const base = {
    id: member.id,
    position: { x: member.x, y: member.y },
    ...(parentId !== null ? { parentId, extent: 'parent' as const } : {}),
    // Reveal is a fade rather than a pop -- what DESIGN.md §9.2 promised since M7.
    className: `revealed detail-${detail}`,
  };
  return member.kind === 'executor'
    ? {
        ...base,
        type: 'system',
        data: {
          label: member.label,
          schedule: detail === 'full' ? member.schedule : undefined,
          unregistered: member.unregistered,
          badges: detail === 'full' ? (member.badges as Badge[] | undefined) : undefined,
          compact: detail === 'dot',
          ...shared,
        } satisfies SystemData,
      }
    : {
        ...base,
        type: 'data',
        data: {
          label: member.label,
          category: member.category ?? 'synthetic',
          compact: detail === 'dot',
          ...shared,
        } satisfies DataNodeData,
      };
}

/** Flat rendering for artifacts with no scene: the focus view, and legacy maps. */
function flatNodes(artifact: Artifact): Node[] {
  return artifact.layout.nodes.map((n: LayoutNode) => {
    const meta = artifact.focus?.meta[n.id];
    const shared = { role: meta?.role ?? null, conflicted: meta?.conflicted ?? false, seed: meta?.seed ?? false };
    return n.kind === 'executor'
      ? {
          id: n.id,
          type: 'system',
          position: { x: n.x, y: n.y },
          data: { label: n.label, schedule: n.schedule, unregistered: n.unregistered, badges: n.badges as Badge[] | undefined, ...shared } satisfies SystemData,
        }
      : {
          id: n.id,
          type: 'data',
          position: { x: n.x, y: n.y },
          data: { label: n.label, category: n.category ?? 'synthetic', ubiquitous: n.ubiquitous, ...shared } satisfies DataNodeData,
        };
  });
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
  const scene = artifact.scene as Scene | undefined;
  const flow = useReactFlow();

  // Subscribing to the transform re-renders on zoom, which is what drives the reveal.
  //
  // Each selector must return a STABLE value. Returning a fresh array (`[s.width, s.height]`)
  // fails the store's equality check on every notification and loops forever — React #185.
  const zoomX = useStore((s) => s.transform[0]);
  const zoomY = useStore((s) => s.transform[1]);
  const zoom = useStore((s) => s.transform[2]);
  const viewWidth = useStore((s) => s.width);
  const viewHeight = useStore((s) => s.height);

  const previous = useRef<RevealState | undefined>(undefined);
  const wrapper = useRef<HTMLDivElement | null>(null);

  const viewport = useMemo(
    () =>
      viewWidth > 0
        ? { x: -zoomX / zoom, y: -zoomY / zoom, width: viewWidth / zoom, height: viewHeight / zoom }
        : undefined,
    [zoomX, zoomY, zoom, viewWidth, viewHeight],
  );

  const reveal = useMemo(() => {
    if (!scene) return null;
    const next = computeReveal(scene, zoom, { budget: DEFAULT_BUDGET, ...(viewport ? { viewport } : {}) }, previous.current);
    previous.current = next;
    return next;
  }, [scene, zoom, viewport]);

  const { nodes, edges } = useMemo(() => {
    if (!scene || !reveal) {
      const ghost = (id: string): boolean => artifact.focus?.meta[id]?.role === 'removed';
      return { nodes: flatNodes(artifact), edges: toEdges(artifact.layout.edges, ghost) };
    }

    const out: Node[] = [];
    for (const region of scene.regions) {
      const open = reveal.open.has(region.id);
      const shownMembers = region.members.filter((m) => reveal.members.has(m.id));
      out.push({
        id: region.id,
        type: 'group',
        position: { x: region.x, y: region.y },
        // An open region becomes a container: its members are drawn inside it.
        ...(open ? { style: { width: region.width, height: region.height } } : {}),
        data: {
          label: region.label,
          executors: region.executorCount,
          states: region.stateCount,
          width: region.width,
          height: region.height,
          topState: region.topState,
          open,
          hidden: open ? region.members.length - shownMembers.length : 0,
          capped: reveal.capped.has(region.id),
        } satisfies GroupData,
      });
      for (const member of shownMembers) {
        out.push(memberNode(member, region.id, reveal.members.get(member.id)!, artifact));
      }
    }
    for (const member of scene.shared) {
      const detail = reveal.members.get(member.id);
      if (detail) out.push(memberNode(member, null, detail, artifact));
    }

    return { nodes: out, edges: toEdges(retargetEdges(scene, reveal), () => false) };
  }, [scene, reveal, artifact]);

  /**
   * Frames a rectangle in the viewport.
   *
   * Computed here rather than via `fitBounds`, which silently did nothing in this setup.
   * Dimensions are MEASURED at call time rather than closed over: a callback created
   * before the pane had a size captured zero and then silently refused to move the camera
   * forever, which is a very quiet way to fail.
   */
  const frame = useCallback(
    (box: { x: number; y: number; width: number; height: number }, duration = 600) => {
      const rect = wrapper.current?.getBoundingClientRect();
      const viewWidth = rect?.width ?? 0;
      const viewHeight = rect?.height ?? 0;
      if (viewWidth <= 0 || viewHeight <= 0 || box.width <= 0 || box.height <= 0) return;
      const scale = Math.min(viewWidth / box.width, viewHeight / box.height) * 0.86;
      const next = Math.max(0.005, Math.min(4, scale));
      void flow.setViewport(
        {
          x: viewWidth / 2 - (box.x + box.width / 2) * next,
          y: viewHeight / 2 - (box.y + box.height / 2) * next,
          zoom: next,
        },
        { duration },
      );
    },
    [flow],
  );

  // Fit once, when the scene and the viewport are both actually ready. React Flow's own
  // `fitView` prop races the artifact fetch and sometimes leaves the map at zoom 1.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !scene || viewWidth <= 0) return;
    fitted.current = true;
    frame({ x: 0, y: 0, width: scene.width, height: scene.height }, 0);
  }, [scene, viewWidth, frame]);

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      // Regions are navigated by zooming. Click-to-fly is designed but not working:
      // the camera moves when driven directly and silently does not from a handler.
      if (node.type !== 'group') onSelect(node.id);
    },
    [onSelect],
  );

  return (
    <div ref={wrapper} className="canvas-fill">
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
      onPaneClick={onDeselect}
      // No `fitView` prop: it re-fits whenever the node set changes, and the node set
      // changes on every reveal — which silently reverted every programmatic camera move.
      // The initial fit is done once, explicitly, above.
      minZoom={0.005}
      maxZoom={4}
      onlyRenderVisibleElements
      nodesDraggable={false}
      elevateNodesOnSelect={false}
    >
      <Background gap={22} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
    </div>
  );
}
