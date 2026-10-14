import { LedgerError } from "./errors.js";

export const STATES = [
  "prepared",
  "pending_approval",
  "approved",
  "executing",
  "executed",
  "failed",
  "unknown",
  "rejected",
  "drafted",
  "expired",
  "revoked",
] as const;

export type State = (typeof STATES)[number];

export const TERMINAL_STATES: ReadonlySet<State> = new Set([
  "executed",
  "failed",
  "rejected",
  "drafted",
  "expired",
  "revoked",
]);

/**
 * Legal task transitions. `prepared` is entered from request()
 * (transition.from = null) and is not listed as a source of itself.
 */
export const TRANSITIONS: Record<State, readonly State[]> = {
  prepared: ["approved", "pending_approval", "rejected", "drafted"],
  pending_approval: ["approved", "rejected", "expired", "revoked"],
  approved: ["executing", "revoked", "expired"],
  executing: ["executed", "failed", "unknown"],
  unknown: ["executed", "failed"],
  executed: [],
  failed: [],
  rejected: [],
  drafted: [],
  expired: [],
  revoked: [],
};

export function isState(value: string): value is State {
  return (STATES as readonly string[]).includes(value);
}

export function canTransition(from: State, to: State): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: State, to: State): void {
  if (!canTransition(from, to)) {
    throw new LedgerError(
      "invalid_transition",
      `cannot transition from ${from} to ${to}`,
      409,
    );
  }
}

export function isTerminal(state: State): boolean {
  return TERMINAL_STATES.has(state);
}
