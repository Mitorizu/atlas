import { useEffect, useMemo, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { describeNode, type Artifact } from './artifact.ts';
import { Inspector } from './Inspector.tsx';
import { Canvas } from './Canvas.tsx';
import './styles.css';

export default function App() {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let known: number | null = null;

    const load = (): void => {
      fetch('graph.json', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`graph.json: HTTP ${r.status}`))))
        .then((next) => {
          if (!cancelled) setArtifact(next as Artifact);
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        });
    };
    load();

    // Under `--watch` the CLI rewrites the artifact in place; poll its mtime so the view
    // follows along. `/version` is absent when the artifact is served statically, in which
    // case the interval quietly does nothing.
    const poll = setInterval(() => {
      fetch('version', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((info: { mtime?: number } | null) => {
          if (cancelled || !info?.mtime) return;
          if (known !== null && info.mtime !== known) load();
          known = info.mtime;
        })
        .catch(() => undefined);
    }, 1500);

    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, []);

  const detail = useMemo(
    () => (artifact && selected ? describeNode(artifact, selected) : null),
    [artifact, selected],
  );
  if (error) {
    return (
      <div className="state-screen">
        <h1>No graph</h1>
        <p>{error}</p>
        <p className="hint">Produce one with:</p>
        <code>atlas diff --view</code>
        <code>atlas map &lt;path-to-rust&gt;</code>
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
        <ReactFlowProvider>
          <Canvas artifact={artifact} onSelect={setSelected} onDeselect={() => setSelected(null)} />
        </ReactFlowProvider>
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
