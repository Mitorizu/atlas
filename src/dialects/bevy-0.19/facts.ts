import type { SourceLoc, StateCategory } from '../../core/ir.ts';
import type { SourceFile } from '../types.ts';
import type { RawAccess } from './params.ts';
import type { Modifiers } from './registration.ts';

/** Who a registration site belongs to before the plugin graph is resolved (§7.3). */
export type Owner =
  /** Registered directly in a file that builds an App. */
  | { kind: 'app'; scope: string }
  /** Registered inside `impl Plugin for X` — scope depends on who adds X. */
  | { kind: 'plugin'; plugin: string }
  /** Neither: a library file with no App and no enclosing plugin. */
  | { kind: 'free' };

export interface DeclaredAccess {
  accesses: RawAccess[];
  observes?: string;
}

export interface CandidateFact extends DeclaredAccess {
  name: string;
  /** True when accesses came from an ordinary signature, not declared ECS params. */
  signatureOnly?: boolean;
  /** Full module path including enclosing `mod` blocks (§6.2). */
  modPath: string;
  loc: SourceLoc;
  signature: string;
}

export interface RegistrationFact {
  /** Terminal name of the referenced system; null for an inline closure. */
  systemName: string | null;
  typeArgs: string[];
  schedule: string;
  modifiers: Modifiers;
  chained: boolean;
  /** Module path of the registration SITE, for innermost-first resolution. */
  modPath: string;
  owner: Owner;
  /** Present when the registered system is an inline closure. */
  closure?: CandidateFact;
}

/** An edge in the plugin graph: who adds whom. */
export interface PluginEdgeFact {
  from: Owner;
  to: string;
}

export interface SetOrderingFact {
  before: string;
  after: string;
  schedule: string;
  owner: Owner;
}

export interface FileFacts {
  file: SourceFile;
  /** Non-null when this file calls `App::new()`; the value is the app's scope name. */
  appRoot: string | null;
  /** Plugin types declared here via `impl Plugin for X` / `impl PluginGroup for X`. */
  pluginDefs: string[];
  /** Categories from local `#[derive(..)]` sites; authoritative over usage inference (§7.3). */
  declaredCategories: Array<[string, StateCategory]>;
  /**
   * Types declared in this file (struct/enum/type alias). Collected corpus-wide so a
   * signature reference can be told apart from `Vec`, `String` and other foreign types.
   */
  declaredTypes: string[];
  pluginEdges: PluginEdgeFact[];
  candidates: CandidateFact[];
  registrations: RegistrationFact[];
  setOrderings: SetOrderingFact[];
}
