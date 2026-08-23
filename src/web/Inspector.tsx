import { CATEGORY_COLOR } from './theme.ts';
import type { Artifact, NodeDetail } from './artifact.ts';

/**
 * Inspector drawer (DESIGN.md §9.1): upstream writers, downstream readers, conflicts, and
 * a jump to the source location.
 */
export function Inspector({
  detail,
  artifact,
  onClose,
  onSelect,
}: {
  detail: NodeDetail;
  artifact: Artifact;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const { executor, state } = detail;
  const registration = executor?.registration;
  const repoRoot = artifact.meta.repoRoot;
  const loc = executor?.loc;
  const href = loc && repoRoot ? `vscode://file/${repoRoot}/${loc.file}:${loc.line}` : undefined;

  return (
    <aside className="inspector">
      <header>
        <span className={`role ${detail.role ?? 'context'}`}>{detail.role ?? 'context'}</span>
        <strong>{detail.title}</strong>
        <button type="button" onClick={onClose} aria-label="Close inspector">
          ×
        </button>
      </header>

      <div className="body">
        {detail.conflicts.length > 0 ? (
          <section className="conflict">
            <h3>Introduced conflict</h3>
            {detail.conflicts.map((c) => (
              <p key={`${c.a}|${c.b}|${c.stateId}`}>
                <code>{c.a.split('::').pop()}</code> and <code>{c.b.split('::').pop()}</code> both touch{' '}
                <code>{c.stateId}</code> in <code>{c.schedule}</code> with nothing ordering them.
              </p>
            ))}
          </section>
        ) : null}

        {executor ? (
          <section>
            <h3>Registration</h3>
            <dl>
              <dt>kind</dt>
              <dd>{executor.kind}</dd>
              <dt>schedule</dt>
              <dd>{registration?.schedule ?? <em>unregistered</em>}</dd>
              {registration?.inSets.length ? (
                <>
                  <dt>sets</dt>
                  <dd>{registration.inSets.join(', ')}</dd>
                </>
              ) : null}
              {registration?.before.length ? (
                <>
                  <dt>before</dt>
                  <dd>{registration.before.join(', ')}</dd>
                </>
              ) : null}
              {registration?.after.length ? (
                <>
                  <dt>after</dt>
                  <dd>{registration.after.join(', ')}</dd>
                </>
              ) : null}
              {registration?.runConditions.length ? (
                <>
                  <dt>run if</dt>
                  <dd>{registration.runConditions.join(', ')}</dd>
                </>
              ) : null}
              {executor.appScopes.length ? (
                <>
                  <dt>app</dt>
                  <dd>{executor.appScopes.join(', ')}</dd>
                </>
              ) : null}
            </dl>
            <pre className="signature">{executor.signature}</pre>
          </section>
        ) : null}

        {state ? (
          <section>
            <h3>State</h3>
            <dl>
              <dt>category</dt>
              <dd>
                <span className="dot" style={{ background: CATEGORY_COLOR[state.category] }} /> {state.category}
              </dd>
              {state.ubiquitous ? (
                <>
                  <dt>note</dt>
                  <dd>ubiquitous — shown as a badge outside this view</dd>
                </>
              ) : null}
              {state.ambiguousKey ? (
                <>
                  <dt>note</dt>
                  <dd>key is a terminal-name fallback; may fuse similarly named types</dd>
                </>
              ) : null}
            </dl>
          </section>
        ) : null}

        <NeighbourList
          title={detail.kind === 'executor' ? 'Reads' : 'Written by'}
          entries={detail.upstream}
          onSelect={onSelect}
        />
        <NeighbourList
          title={detail.kind === 'executor' ? 'Writes' : 'Read by'}
          entries={detail.downstream}
          onSelect={onSelect}
        />

        {loc ? (
          <section>
            <h3>Source</h3>
            {href ? (
              <a className="source" href={href}>
                {loc.file}:{loc.line}
              </a>
            ) : (
              <code>
                {loc.file}:{loc.line}
              </code>
            )}
          </section>
        ) : null}
      </div>
    </aside>
  );
}

function NeighbourList({
  title,
  entries,
  onSelect,
}: {
  title: string;
  entries: Array<{ id: string; label: string; mode: string }>;
  onSelect: (id: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <section>
      <h3>
        {title} <span className="count">{entries.length}</span>
      </h3>
      <ul className="neighbours">
        {entries.map((entry) => (
          <li key={`${entry.id}:${entry.mode}`}>
            <button type="button" onClick={() => onSelect(entry.id)}>
              {entry.label}
            </button>
            <span className={`mode ${entry.mode}`}>{entry.mode}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
