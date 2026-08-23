import { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, MarkerType, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { nodeTypes, type Badge, type DataNodeData, type SystemData } from './nodes.tsx';
import { edgeStyle, EDGE_COLOR } from './theme.ts';
import { describeNode, type Artifact } from './artifact.ts';
import { Inspector } from './Inspector.tsx';
import './styles.css';

function toFlow(artifact: Artifact): { nodes: Node[]; edges: Edge[] } {
  const focusMeta = artifact.focus?.meta ?? {};

  const nodes: Node[] = artifact.layout.nodes.map((n) => {
    const meta = focusMeta[n.id];
    const shared = { role: meta?.role ?? null, conflicted: meta?.conflicted ?? false, seed: meta?.seed ?? false };
    return n.kind === 'executor'
      ? {
          id: n.id,
          type: 'system',
          position: { x: n.x, y: n.y },
          data: {
            label: n.label,
            schedule: n.schedule,
            unregistered: n.unregistered,
            badges: n.badges as Badge[] | undefined,
            ...shared,
          } satisfies SystemData,
        }
      : {
          id: n.id,
          type: 'data',
          position: { x: n.x, y: n.y },
          data: {
            label: n.label,
            category: n.category ?? 'synthetic',
            ubiquitous: n.ubiquitous,
            ...shared,
          } satisfies DataNodeData,
        };
  });

  const edges: Edge[] = artifact.layout.edges.map((e) => {
    const style = edgeStyle(e.mode);
    const color = EDGE_COLOR[e.mode] ?? EDGE_COLOR['read']!;
    // Reads use an open arrowhead, writes a filled one; readwrite gets both ends (§7.5).
    const head = e.mode === 'read' ? MarkerType.Arrow : MarkerType.ArrowClosed;
    const removed = focusMeta[e.source]?.role === 'removed' || focusMeta[e.target]?.role === 'removed';
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      style: removed ? { ...style, opacity: 0.35, strokeDasharray: '2 4' } : style,
      markerEnd: { type: head, color, width: 18, height: 18 },
      ...(e.doubleHeaded ? { markerStart: { type: head, color, width: 18, height: 18 } } : {}),
      animated: false,
    };
  });

  return { nodes, edges };
}

export default function App() {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    fetch('graph.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`graph.json: HTTP ${r.status}`))))
      .then(setArtifact)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const flow = useMemo(() => (artifact ? toFlow(artifact) : { nodes: [], edges: [] }), [artifact]);
  const detail = useMemo(
    () => (artifact && selected ? describeNode(artifact, selected) : null),
    [artifact, selected],
  );
  const onNodeClick = useCallback((_: unknown, node: Node) => setSelected(node.id), []);

  if (error) {
    return (
      <div className="state-screen">
        <h1>No graph</h1>
        <p>{error}</p>
        <code>npm run diff -- --view</code>
        <code>npm run extract -- &lt;path-to-rust&gt;</code>
      </div>
    );
  }
  if (!artifact) return <div className="state-screen"><p>Loading…</p></div>;

  const { meta, focus } = artifact;
  const isFocus = meta.mode === 'focus';
  const introduced = focus?.introduced ?? [];

  return (
    <div className="app">
      <header>
        <strong>atlas</strong>
        {isFocus ? (
          <>
            <span className="crumb">
              {meta.base} → {meta.head}
            </span>
            <span className="crumb">
              {meta.changedFiles?.length ?? 0} file(s) changed
            </span>
            <span className="crumb">{meta.hops} hop(s)</span>
            {introduced.length > 0 ? (
              <span className="crumb alarm">
                {introduced.length} ambiguity introduced
              </span>
            ) : (
              <span className="crumb ok">no new ambiguities</span>
            )}
          </>
        ) : (
          <>
            <span className="crumb">{meta.dialect}</span>
            <span className="crumb">{meta.files} file(s)</span>
            <span className="crumb">
              {artifact.layout.nodes.filter((n) => n.kind === 'executor').length} executors ·{' '}
              {artifact.layout.nodes.filter((n) => n.kind === 'state').length} state
            </span>
          </>
        )}
        <span className="spacer" />
        <span className="legend">
          {isFocus ? (
            <>
              <span className="k"><i className="swatch added" />added</span>
              <span className="k"><i className="swatch modified" />modified</span>
              <span className="k"><i className="swatch removed" />removed</span>
              <span className="k"><i className="swatch context" />context</span>
            </>
          ) : (
            <>
              <span className="k">
                <svg width="34" height="10"><line x1="0" y1="5" x2="30" y2="5" stroke="#7c8794" strokeWidth="1.4" strokeDasharray="5 4" /></svg>
                read
              </span>
              <span className="k">
                <svg width="34" height="10"><line x1="0" y1="5" x2="30" y2="5" stroke="#b3355e" strokeWidth="2.2" /></svg>
                write / mutate
              </span>
            </>
          )}
        </span>
      </header>

      {isFocus && introduced.length > 0 ? (
        <div className="banner">
          {introduced.slice(0, 3).map((c) => (
            <button
              type="button"
              key={`${c.a}|${c.b}|${c.stateId}`}
              onClick={() => setSelected(c.stateId)}
            >
              <strong>{c.a.split('::').pop()}</strong> vs <strong>{c.b.split('::').pop()}</strong> on{' '}
              <code>{c.stateId}</code> <span className="sched">[{c.schedule}]</span>
            </button>
          ))}
          {introduced.length > 3 ? <span className="more">+{introduced.length - 3} more</span> : null}
        </div>
      ) : null}

      <div className="canvas">
        <ReactFlow
          nodes={flow.nodes}
          edges={flow.edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          onPaneClick={() => setSelected(null)}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.02}
        >
          <Background gap={22} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
        {detail ? (
          <Inspector
            detail={detail}
            artifact={artifact}
            onClose={() => setSelected(null)}
            onSelect={setSelected}
          />
        ) : null}
      </div>
    </div>
  );
}
