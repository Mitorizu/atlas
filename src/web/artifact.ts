/** Shapes the viewer reads. Kept structural so the viewer never imports Node-side code. */

export type DiffRole = 'added' | 'removed' | 'modified' | 'moved' | 'context';

export interface FocusMeta {
  role: DiffRole;
  seed: boolean;
  distance: number;
  conflicted: boolean;
}

export interface Ambiguity {
  a: string;
  b: string;
  stateId: string;
  schedule: string;
  appScope: string;
}

export interface LayoutNode {
  id: string;
  kind: 'executor' | 'state';
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  category?: string;
  schedule?: string;
  unregistered?: boolean;
  ubiquitous?: boolean;
  badges?: Array<{ id: string; label: string; category: string; mode: string }>;
}

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  mode: string;
  doubleHeaded: boolean;
}

export interface SourceLoc {
  file: string;
  line: number;
  col: number;
}

export interface IRExecutor {
  id: string;
  display: string;
  kind: string;
  appScopes: string[];
  loc: SourceLoc;
  signature: string;
  unregistered: boolean;
  observes?: string;
  registration?: {
    schedule: string;
    before: string[];
    after: string[];
    inSets: string[];
    chained: boolean;
    runConditions: string[];
    ambiguousWith?: string[] | 'all';
  };
}

export interface IRState {
  id: string;
  display: string;
  category: string;
  ubiquitous: boolean;
  ambiguousKey?: boolean;
}

export interface IRAccess {
  executorId: string;
  stateId: string;
  mode: string;
  optional: boolean;
  viaParam?: string;
}

export interface Artifact {
  meta: {
    mode?: 'focus';
    dialect: string;
    repoRoot?: string;
    base?: string;
    head?: string;
    changedFiles?: string[];
    hops?: number;
    files?: number;
    filesWithParseErrors?: number;
  };
  focus?: {
    meta: Record<string, FocusMeta>;
    seeds: string[];
    introduced: Ambiguity[];
    totalExecutors: number;
  };
  ir: {
    executors: IRExecutor[];
    states: IRState[];
    accesses: IRAccess[];
  };
  layout: { nodes: LayoutNode[]; edges: LayoutEdge[] };
  /** Nested scene with progressive per-region reveal, on orientation artifacts (§9.2). */
  scene?: import('../layout/scene.ts').Scene;
}

/** Everything the Inspector needs about one node, derived from the artifact. */
export interface NodeDetail {
  id: string;
  title: string;
  kind: 'executor' | 'state';
  executor?: IRExecutor;
  state?: IRState;
  role?: DiffRole;
  conflicted: boolean;
  /** For an executor: state it reads / writes. For state: who reads / writes it. */
  upstream: Array<{ id: string; label: string; mode: string }>;
  downstream: Array<{ id: string; label: string; mode: string }>;
  conflicts: Ambiguity[];
}

const WRITE_MODES = new Set(['write', 'readwrite', 'structural']);

export function describeNode(artifact: Artifact, id: string): NodeDetail | null {
  const executor = artifact.ir.executors.find((e) => e.id === id);
  const state = artifact.ir.states.find((s) => s.id === id);
  if (!executor && !state) return null;

  const focusMeta = artifact.focus?.meta[id];
  const conflicts = (artifact.focus?.introduced ?? []).filter(
    (c) => c.a === id || c.b === id || c.stateId === id,
  );

  const label = (nodeId: string): string =>
    artifact.ir.executors.find((e) => e.id === nodeId)?.display ??
    artifact.ir.states.find((s) => s.id === nodeId)?.display ??
    nodeId;

  const upstream: NodeDetail['upstream'] = [];
  const downstream: NodeDetail['downstream'] = [];

  if (executor) {
    // For a system: what it reads is upstream, what it writes is downstream.
    for (const access of artifact.ir.accesses) {
      if (access.executorId !== id) continue;
      const entry = { id: access.stateId, label: label(access.stateId), mode: access.mode };
      if (WRITE_MODES.has(access.mode)) downstream.push(entry);
      if (access.mode === 'read' || access.mode === 'readwrite') upstream.push(entry);
    }
  } else {
    // For state: writers are upstream, readers are downstream (the blast radius).
    for (const access of artifact.ir.accesses) {
      if (access.stateId !== id) continue;
      const entry = { id: access.executorId, label: label(access.executorId), mode: access.mode };
      if (WRITE_MODES.has(access.mode)) upstream.push(entry);
      if (access.mode === 'read' || access.mode === 'readwrite') downstream.push(entry);
    }
  }

  return {
    id,
    title: executor?.display ?? state?.display ?? id,
    kind: executor ? 'executor' : 'state',
    ...(executor ? { executor } : {}),
    ...(state ? { state } : {}),
    ...(focusMeta ? { role: focusMeta.role } : {}),
    conflicted: focusMeta?.conflicted ?? false,
    upstream,
    downstream,
    conflicts,
  };
}
