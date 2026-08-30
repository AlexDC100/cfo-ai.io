// THE CAPSULE — THE THREAD, AND WHY IT OUTLIVES THE OVERLAY.
//
// Escape collapses the answer surface. It must NOT throw the
// conversation away: the overwhelmingly common move is "read the answer
// → jump to the source cell → come back and ask the follow-up", and an
// overlay that forgets between those two beats forces the reader to
// retype the context they were mid-way through.
//
// So the thread is MODULE state with a ten-minute grace, not component
// state. The palette unmounts its content on close (Radix portals do),
// and a period switch remounts the whole shell — neither may be allowed
// to decide the lifetime of a conversation.
//
// Ten minutes, and then it is gone. A thread that survives a lunch break
// would reopen showing figures from a period the reader has since
// switched away from, which is worse than an empty box: the answer would
// still be true, and would look like it was about the period now on
// screen. Expiry is checked on READ, so a tab left open in the
// background expires on the same schedule as one in the foreground.

import { useSyncExternalStore } from "react";

import type { CapsuleTurn } from "./capsuleAnswerClient";

/** The grace window. Exported so the test asserts the documented number
 *  rather than a copy of it. */
export const THREAD_TTL_MS = 10 * 60 * 1000;

export interface CapsuleThreadState {
  turns: readonly CapsuleTurn[];
  /** When the surface was last collapsed with Escape. Null while open. */
  collapsedAt: number | null;
  /** Scope key — the workspace+period the thread was opened against.
   *  A change discards the thread rather than re-answering old questions
   *  against new figures. */
  scope: string | null;
}

const EMPTY: CapsuleThreadState = { turns: [], collapsedAt: null, scope: null };

let state: CapsuleThreadState = EMPTY;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function set(next: CapsuleThreadState): void {
  state = next;
  emit();
}

/** True when the thread has aged out of its grace window. */
export function isExpired(now: number): boolean {
  return state.collapsedAt !== null && now - state.collapsedAt > THREAD_TTL_MS;
}

/** The thread, or an empty one when it has expired. Expiry is applied
 *  here so every reader — hook, action handler, test — sees one rule. */
export function getThread(now: number = Date.now()): CapsuleThreadState {
  if (isExpired(now)) {
    if (state !== EMPTY) set(EMPTY);
    return EMPTY;
  }
  return state;
}

/** Open (or reopen) the thread for a scope. Returns true when a live
 *  thread was resumed, false when the caller is starting fresh. */
export function openThread(scope: string | null, now: number = Date.now()): boolean {
  const current = getThread(now);
  if (current.turns.length === 0) {
    set({ turns: [], collapsedAt: null, scope });
    return false;
  }
  if (current.scope !== scope) {
    // Different workspace or period — the old answers describe figures
    // that are no longer on screen.
    set({ turns: [], collapsedAt: null, scope });
    return false;
  }
  set({ ...current, collapsedAt: null });
  return true;
}

/** Escape. Keeps the turns, starts the clock. */
export function collapseThread(now: number = Date.now()): void {
  if (state.turns.length === 0) {
    set(EMPTY);
    return;
  }
  set({ ...state, collapsedAt: now });
}

export function pushTurn(turn: CapsuleTurn): void {
  set({ ...state, turns: [...state.turns, turn], collapsedAt: null });
}

/** Replace one turn in place — the pipeline emits a new object on every
 *  state change and the list must not reorder. */
export function patchTurn(turn: CapsuleTurn): void {
  let found = false;
  const turns = state.turns.map((t) => {
    if (t.id !== turn.id) return t;
    found = true;
    return turn;
  });
  if (!found) return;
  set({ ...state, turns });
}

export function clearThread(): void {
  set(EMPTY);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The hook the panel reads. Note the getSnapshot passes no clock: it
 *  must be referentially stable between renders, so expiry is applied by
 *  `openThread` (on reopen) and by the explicit `getThread(now)` calls
 *  the action handlers make. */
export function useCapsuleThread(): CapsuleThreadState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => EMPTY,
  );
}

/** Test hook — module state is otherwise immortal within a test file. */
export function __resetCapsuleThreadForTests(): void {
  state = EMPTY;
  emit();
}
