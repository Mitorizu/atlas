import type { AtlasIR } from './ir.ts';
import type { DialectOutput } from '../dialects/types.ts';
import { emptyIR } from './ir.ts';

/** Merges per-file dialect output into one IR, deduplicating state nodes by id (§6). */
export function mergeOutputs(dialect: string, outputs: DialectOutput[]): AtlasIR {
  const ir = emptyIR(dialect);
  const states = new Map<string, AtlasIR['states'][number]>();
  for (const out of outputs) {
    ir.executors.push(...out.executors);
    ir.accesses.push(...out.accesses);
    ir.setOrderings.push(...out.setOrderings);
    for (const state of out.states) {
      const existing = states.get(state.id);
      if (!existing) states.set(state.id, { ...state });
      else if (state.ambiguousKey) existing.ambiguousKey = true;
    }
  }
  ir.states = [...states.values()];
  return ir;
}
