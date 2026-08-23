import type Parser from 'tree-sitter';
import type { SetOrdering } from '../../core/ir.ts';
import { renderType } from './types.ts';
import { CHAINING_MODIFIERS, DISTRIBUTING_MODIFIERS } from './vocabulary.ts';
import { descend } from './declarations.ts';

export interface Modifiers {
  runConditions: string[];
  inSets: string[];
  before: string[];
  after: string[];
  ambiguousWith?: string[] | 'all';
}

export interface RegistrationLeaf {
  /** Terminal function name, used to match against candidates in this file. */
  systemName: string | null;
  /**
   * The reference exactly as written, path included (`P::Step`). Ordering constraints and
   * set names must keep the path: `P::Step` and `Q::Step` are different sets.
   */
  qualified: string;
  typeArgs: string[];
  closure?: Parser.SyntaxNode;
  schedule: string;
  modifiers: Modifiers;
  chained: boolean;
  node: Parser.SyntaxNode;
}

function emptyModifiers(): Modifiers {
  return { runConditions: [], inSets: [], before: [], after: [] };
}

function cloneModifiers(m: Modifiers): Modifiers {
  return {
    runConditions: [...m.runConditions],
    inSets: [...m.inSets],
    before: [...m.before],
    after: [...m.after],
    ...(m.ambiguousWith ? { ambiguousWith: m.ambiguousWith === 'all' ? 'all' : [...m.ambiguousWith] } : {}),
  };
}

function argTexts(call: Parser.SyntaxNode): string[] {
  return (call.childForFieldName('arguments')?.namedChildren ?? []).map((a) => a.text.replace(/\s+/g, ''));
}

/** Applies one distributing modifier to a copy of the inherited modifier set (§7.6). */
function withModifier(mods: Modifiers, name: string, args: string[]): Modifiers {
  const next = cloneModifiers(mods);
  switch (name) {
    case 'run_if':
    case 'distributive_run_if':
      next.runConditions.push(...args);
      break;
    case 'in_set':
      next.inSets.push(...args);
      break;
    case 'before':
    case 'before_ignore_deferred':
      next.before.push(...args);
      break;
    case 'after':
    case 'after_ignore_deferred':
      next.after.push(...args);
      break;
    case 'ambiguous_with':
      next.ambiguousWith = next.ambiguousWith === 'all' ? 'all' : [...(next.ambiguousWith ?? []), ...args];
      break;
    case 'ambiguous_with_all':
      next.ambiguousWith = 'all';
      break;
    default:
      break;
  }
  return next;
}

/** The name an ordering constraint refers to this leaf by. */
export function leafLabel(leaf: RegistrationLeaf): string {
  if (leaf.systemName === null) return `<closure@${leaf.node.startPosition.row + 1}>`;
  return leaf.typeArgs.length > 0 ? `${leaf.qualified}::<${leaf.typeArgs.join(',')}>` : leaf.qualified;
}

/**
 * Walks one registration term (DESIGN.md §7.6).
 *
 * Distribution rules, which are NOT uniform:
 *   - `run_if` / `in_set` / `before` / `after` / `ambiguous_with` apply to every
 *     TRANSITIVE leaf of a tuple;
 *   - `chain()` orders only the tuple's IMMEDIATE children, each child's whole subtree
 *     before the next child's.
 * Conflating the two is the likeliest source of wrong ordering edges, and wrong ordering
 * edges silently suppress real conflicts in §8.
 *
 * Skips `ERROR` and `array_expression`, the deterministic artifacts of an unparseable
 * `#[cfg(...)]` in expression position (M0 finding).
 */
export function walkTerm(node: Parser.SyntaxNode, mods: Modifiers, schedule: string): RegistrationLeaf[] {
  switch (node.type) {
    case 'ERROR':
    case 'array_expression':
      return [];

    case 'tuple_expression':
      return node.namedChildren.flatMap((child) => walkTerm(child, mods, schedule));

    case 'identifier':
      return [
        { systemName: node.text, qualified: node.text, typeArgs: [], schedule, modifiers: cloneModifiers(mods), chained: false, node },
      ];

    case 'scoped_identifier':
      return [
        {
          systemName: node.childForFieldName('name')?.text ?? node.text,
          qualified: node.text.replace(/\s+/g, ''),
          typeArgs: [],
          schedule,
          modifiers: cloneModifiers(mods),
          chained: false,
          node,
        },
      ];

    case 'generic_function': {
      const fn = node.childForFieldName('function');
      if (!fn) return [];
      const args = node.childForFieldName('type_arguments');
      return [
        {
          systemName: fn.type === 'scoped_identifier' ? (fn.childForFieldName('name')?.text ?? fn.text) : fn.text,
          qualified: fn.text.replace(/\s+/g, ''),
          typeArgs: (args?.namedChildren ?? []).filter((c) => c.type !== 'lifetime').map(renderType),
          schedule,
          modifiers: cloneModifiers(mods),
          chained: false,
          node,
        },
      ];
    }

    case 'closure_expression':
      return [
        { systemName: null, qualified: '', typeArgs: [], closure: node, schedule, modifiers: cloneModifiers(mods), chained: false, node },
      ];

    case 'call_expression': {
      const fn = node.childForFieldName('function');
      if (fn?.type !== 'field_expression') return [];
      const modifier = fn.childForFieldName('field')?.text;
      const receiver = fn.childForFieldName('value');
      if (!modifier || !receiver) return [];

      if (CHAINING_MODIFIERS.has(modifier)) {
        // Orders immediate children only; each child's subtree as a unit.
        if (receiver.type !== 'tuple_expression') return walkTerm(receiver, mods, schedule);
        const groups = receiver.namedChildren.map((child) => walkTerm(child, mods, schedule)).filter((g) => g.length > 0);
        for (let i = 0; i < groups.length - 1; i++) {
          const earlier = groups[i]!;
          const later = groups[i + 1]!;
          for (const a of earlier) {
            a.chained = true;
            a.modifiers.before.push(...later.map(leafLabel));
          }
          for (const b of later) {
            b.chained = true;
            b.modifiers.after.push(...earlier.map(leafLabel));
          }
        }
        return groups.flat();
      }

      if (DISTRIBUTING_MODIFIERS.has(modifier)) {
        return walkTerm(receiver, withModifier(mods, modifier, argTexts(node)), schedule);
      }

      // An unrecognised method in system position (e.g. `.map(..)`): descend unchanged.
      return walkTerm(receiver, mods, schedule);
    }

    default:
      return [];
  }
}

function methodCalls(root: Parser.SyntaxNode, method: string): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = [];
  descend(root, (node) => {
    if (node.type !== 'call_expression') return;
    const fn = node.childForFieldName('function');
    if (fn?.type === 'field_expression' && fn.childForFieldName('field')?.text === method) out.push(node);
  });
  return out;
}

/** Pass 3: `add_systems(Schedule, systems)` sites. */
export function collectRegistrations(root: Parser.SyntaxNode): RegistrationLeaf[] {
  const leaves: RegistrationLeaf[] = [];
  for (const call of methodCalls(root, 'add_systems')) {
    const args = call.childForFieldName('arguments')?.namedChildren ?? [];
    const [scheduleNode, ...systems] = args;
    if (!scheduleNode) continue;
    const schedule = scheduleNode.text.replace(/\s+/g, '');
    for (const term of systems) leaves.push(...walkTerm(term, emptyModifiers(), schedule));
  }
  return leaves;
}

/**
 * Pass 3: `add_observer(fn)` sites. Observers are triggered by events rather than
 * scheduled, so they carry the sentinel schedule `Observer` rather than a real one.
 */
export const OBSERVER_SCHEDULE = 'Observer';

export function collectObservers(root: Parser.SyntaxNode): RegistrationLeaf[] {
  const leaves: RegistrationLeaf[] = [];
  for (const call of methodCalls(root, 'add_observer')) {
    for (const term of call.childForFieldName('arguments')?.namedChildren ?? []) {
      leaves.push(...walkTerm(term, emptyModifiers(), OBSERVER_SCHEDULE));
    }
  }
  return leaves;
}

/**
 * Pass 3: `configure_sets(Schedule, ..)` — ordering declared between SETS (§7.6).
 *
 * Reuses the same term walker: set names arrive as leaves and their accumulated
 * before/after modifiers become SetOrdering edges. `A.before(B)` means A precedes B;
 * `A.after(B)` means B precedes A; `(A, B).chain()` means A precedes B.
 */
export function collectSetOrderings(root: Parser.SyntaxNode, appScope: string): SetOrdering[] {
  const orderings: SetOrdering[] = [];
  const seen = new Set<string>();

  const add = (before: string, after: string, schedule: string): void => {
    const key = `${schedule}|${before}|${after}`;
    if (before === after || seen.has(key)) return;
    seen.add(key);
    orderings.push({ before, after, schedule, appScope });
  };

  for (const call of methodCalls(root, 'configure_sets')) {
    const args = call.childForFieldName('arguments')?.namedChildren ?? [];
    const [scheduleNode, ...terms] = args;
    if (!scheduleNode) continue;
    const schedule = scheduleNode.text.replace(/\s+/g, '');
    for (const term of terms) {
      for (const leaf of walkTerm(term, emptyModifiers(), schedule)) {
        const self = leafLabel(leaf);
        for (const target of leaf.modifiers.before) add(self, target, schedule);
        for (const target of leaf.modifiers.after) add(target, self, schedule);
      }
    }
  }
  return orderings;
}
