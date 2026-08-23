import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { CATEGORY_COLOR } from './theme.ts';

export interface SystemData extends Record<string, unknown> {
  label: string;
  schedule?: string;
  unregistered?: boolean;
}
export interface DataNodeData extends Record<string, unknown> {
  label: string;
  category: string;
  ubiquitous?: boolean;
}

const handleStyle = { opacity: 0, width: 1, height: 1 } as const;

export function SystemNode({ data }: NodeProps<Node<SystemData>>) {
  return (
    <div className={`node system${data.unregistered ? ' unregistered' : ''}`}>
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <span className="label">{data.label}</span>
      {data.schedule ? <span className="tag">{data.schedule}</span> : null}
      {data.unregistered ? <span className="tag muted">unregistered</span> : null}
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </div>
  );
}

export function DataNode({ data }: NodeProps<Node<DataNodeData>>) {
  const color = CATEGORY_COLOR[data.category] ?? CATEGORY_COLOR['synthetic']!;
  return (
    <div className="node data" style={{ borderColor: color }}>
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <span className="dot" style={{ background: color }} />
      <span className="label">{data.label}</span>
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </div>
  );
}

export const nodeTypes = { system: SystemNode, data: DataNode };
