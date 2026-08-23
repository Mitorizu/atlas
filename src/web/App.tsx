import { useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, MarkerType, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { nodeTypes, type DataNodeData, type SystemData } from './nodes.tsx';
import { edgeStyle, EDGE_COLOR } from './theme.ts';
import './styles.css';

interface Artifact {
  meta: { dialect: string; corpus: string; files: number; filesWithParseErrors: number };
  layout: {
    nodes: Array<{
      id: string; kind: 'executor' | 'state'; label: string; x: number; y: number;
      width: number; height: number; category?: string; schedule?: string;
      unregistered?: boolean; ubiquitous?: boolean;
    }>;
    edges: Array<{ id: string; source: string; target: string; mode: string; doubleHeaded: boolean }>;
  };
}

function toFlow(artifact: Artifact): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = artifact.layout.nodes.map((n) =>
    n.kind === 'executor'
      ? {
          id: n.id,
          type: 'system',
          position: { x: n.x, y: n.y },
          data: { label: n.label, schedule: n.schedule, unregistered: n.unregistered } satisfies SystemData,
        }
      : {
          id: n.id,
          type: 'data',
          position: { x: n.x, y: n.y },
          data: { label: n.label, category: n.category ?? 'synthetic', ubiquitous: n.ubiquitous } satisfies DataNodeData,
        },
  );

  const edges: Edge[] = artifact.layout.edges.map((e) => {
    const style = edgeStyle(e.mode);
    const color = EDGE_COLOR[e.mode] ?? EDGE_COLOR['read']!;
    // Reads use an open arrowhead, writes a filled one; readwrite gets both ends (§7.5).
    const head = e.mode === 'read' ? MarkerType.Arrow : MarkerType.ArrowClosed;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      style,
      markerEnd: { type: head, color, width: 18, height: 18 },
      ...(e.doubleHeaded ? { markerStart: { type: head, color, width: 18, height: 18 } } : {}),
      // No animation at rest: motion is reserved for hover/selection (§9.3).
      animated: false,
    };
  });

  return { nodes, edges };
}

export default function App() {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('graph.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`graph.json: HTTP ${r.status}`))))
      .then(setArtifact)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const flow = useMemo(() => (artifact ? toFlow(artifact) : { nodes: [], edges: [] }), [artifact]);

  if (error) {
    return (
      <div className="state-screen">
        <h1>No graph</h1>
        <p>{error}</p>
        <code>npm run extract -- &lt;path-to-rust&gt;</code>
      </div>
    );
  }
  if (!artifact) return <div className="state-screen"><p>Loading…</p></div>;

  const { meta } = artifact;
  return (
    <div className="app">
      <header>
        <strong>atlas</strong>
        <span className="crumb">{meta.dialect}</span>
        <span className="crumb">{meta.files} file{meta.files === 1 ? '' : 's'}</span>
        <span className="crumb">
          {artifact.layout.nodes.filter((n) => n.kind === 'executor').length} executors ·{' '}
          {artifact.layout.nodes.filter((n) => n.kind === 'state').length} state
        </span>
        {meta.filesWithParseErrors > 0 ? (
          <span className="crumb warn">{meta.filesWithParseErrors} file(s) with parse errors</span>
        ) : null}
        <span className="spacer" />
        <span className="legend">
          <span className="k"><svg width="34" height="10"><line x1="0" y1="5" x2="30" y2="5" stroke="#7c8794" strokeWidth="1.4" strokeDasharray="5 4" /></svg>read</span>
          <span className="k"><svg width="34" height="10"><line x1="0" y1="5" x2="30" y2="5" stroke="#b3355e" strokeWidth="2.2" /></svg>write / mutate</span>
        </span>
      </header>
      <ReactFlow
        nodes={flow.nodes}
        edges={flow.edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.02}
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={22} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
