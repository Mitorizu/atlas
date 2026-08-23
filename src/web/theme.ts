/**
 * Visual encoding (DESIGN.md §9.3): hue carries state CATEGORY only. Read vs write is
 * carried by form — dash, weight, arrowhead — so it survives greyscale, colour-blindness,
 * and Orbit zoom where edges are one pixel wide.
 *
 * Deuteranopia note: green/orange is the most common confusion pair, so component uses a
 * blue-teal rather than green. A full simulation audit is Milestone 8.
 */
export const CATEGORY_COLOR: Record<string, string> = {
  component: '#1f7a8c',
  resource: '#6c4bb6',
  message: '#b26a00',
  event: '#b26a00',
  synthetic: '#5c6672',
};

export const EDGE_COLOR: Record<string, string> = {
  read: '#7c8794',
  write: '#b3355e',
  readwrite: '#b3355e',
  structural: '#5c6672',
  unknown: '#7c8794',
};

export function edgeStyle(mode: string): { strokeDasharray?: string; strokeWidth: number; stroke: string } {
  const stroke = EDGE_COLOR[mode] ?? EDGE_COLOR['read']!;
  if (mode === 'read') return { strokeDasharray: '5 4', strokeWidth: 1.4, stroke };
  if (mode === 'structural') return { strokeDasharray: '2 3', strokeWidth: 1.8, stroke };
  return { strokeWidth: 2.2, stroke };
}
