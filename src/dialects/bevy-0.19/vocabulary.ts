import type { AccessMode, StateCategory } from '../../core/ir.ts';

/**
 * The Bevy 0.19 parameter vocabulary (DESIGN.md §7.1).
 *
 * Counts in comments are measured occurrences across the pinned corpora. §7.2 records the
 * constructs that do NOT exist in 0.19 — `EventReader`, `EventWriter`, `Trigger` — which
 * are deliberately absent here.
 */

/** Resources: `Res<T>` reads, `ResMut<T>` reads and writes. */
export const RESOURCE_PARAMS: Readonly<Record<string, AccessMode>> = {
  Res: 'read',
  ResMut: 'readwrite',
  NonSend: 'read',
  NonSendMut: 'readwrite',
};

/** Entity-query params: first type argument is data, second (optional) is filters. */
export const QUERY_PARAMS: ReadonlySet<string> = new Set(['Query', 'Single', 'Populated']);

/** Buffered messages — renamed from Event* in Bevy 0.17 (§7.2). */
export const MESSAGE_PARAMS: Readonly<Record<string, AccessMode>> = {
  MessageReader: 'read',
  MessageWriter: 'write',
  MessageMutator: 'readwrite',
};

/** Observer trigger param: `On<E>` (149 uses); `Trigger<E>` does not exist in 0.19. */
export const OBSERVER_PARAM = 'On';

/** `ParamSet<(A, B)>` — each member is analysed independently (88 uses in engine crates). */
export const PARAMSET_PARAM = 'ParamSet';

/** Unbounded structural mutation; targets the synthetic node (§7.4). */
export const STRUCTURAL_PARAMS: ReadonlySet<string> = new Set(['Commands']);

/** Private to one system, never shared state — must be excluded or it fabricates hubs (§7.1). */
export const EXCLUDED_PARAMS: ReadonlySet<string> = new Set([
  'Local',
  'Deferred',
]);

/** Query data wrappers that grant access to the inner component. */
export const DATA_WRAPPERS: Readonly<Record<string, AccessMode>> = {
  Ref: 'read',
  Mut: 'readwrite',
};

/**
 * Query data terms that are archetype-level and grant no component access: `Entity` is an
 * id, `Has<T>` is a presence test. Listing them explicitly keeps them from being silently
 * ignored by a catch-all.
 */
export const NON_ACCESS_DATA: ReadonlySet<string> = new Set(['Entity', 'Has', 'SpawnDetails']);

export const FILTER_KINDS: Readonly<Record<string, 'with' | 'without' | 'added' | 'changed'>> = {
  With: 'with',
  Without: 'without',
  Added: 'added',
  Changed: 'changed',
  Spawned: 'added',
};

/** Attribute derives that declare a state category (§7.3 declaration sites). */
export const DERIVE_CATEGORY: Readonly<Record<string, StateCategory>> = {
  Component: 'component',
  Resource: 'resource',
  Message: 'message',
  Event: 'event',
  EntityEvent: 'event',
  States: 'resource',
  SubStates: 'resource',
};

/** Modifiers that distribute to every transitive leaf of a tuple (§7.6). */
export const DISTRIBUTING_MODIFIERS: ReadonlySet<string> = new Set([
  'run_if',
  'distributive_run_if',
  'in_set',
  'before',
  'after',
  'before_ignore_deferred',
  'after_ignore_deferred',
  'ambiguous_with',
  'ambiguous_with_all',
]);

/** Modifiers that order a tuple's IMMEDIATE children and do not distribute (§7.6). */
export const CHAINING_MODIFIERS: ReadonlySet<string> = new Set(['chain', 'chain_ignore_deferred']);
