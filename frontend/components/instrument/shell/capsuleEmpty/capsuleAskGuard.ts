// THE CAPSULE — ask budget guard (Part F.5).
//
// A per-user throttle in front of the ONE expensive thing this surface
// can do: activate the Ask row. Credits are live and billing, so a stuck
// Enter key, a double-click, or a user racing the palette must cost one
// answer, not six.
//
// ── The rule that shapes this file ────────────────────────────────────
//
// NEVER SILENTLY DOWNGRADE THE MODEL FOR A JUDGMENT ANSWER. A cheaper
// model that quietly answers a covenant question is worse than a visible
// "one moment" — the user cannot tell a degraded judgment from a good
// one, and this product's whole claim is that its answers are traceable.
//
// That rule is enforced BY CONSTRUCTION, not by comment:
//   · `CapsuleAskDecision` is a two-shape union. There is no third arm
//     carrying a model, a tier, a "fast path", or a token budget — a
//     downgrade has nowhere to be expressed.
//   · This module names no model, anywhere. `capsuleAskGuard.test.ts`
//     reads this file's own source and fails if a model identifier ever
//     appears in it.
// The only outcomes are: answer now, or answer in a moment.
//
// ── Two limits, both calm ─────────────────────────────────────────────
//
//   COOLDOWN  a minimum gap between two asks — catches the double-fire
//             (Enter held, click + Enter, an over-eager retry).
//   BURST     a rolling window cap — catches a user (or a loop) firing
//             a genuine sequence faster than anyone reads answers.
//
// Both are per user key, so one workspace's activity never throttles
// another account sharing the browser.
//
// Module state, like `chatTurns`' cap lockout: the palette unmounts every
// time it closes, and a throttle that resets on unmount is not a throttle.

import { useEffect, useState, useSyncExternalStore } from "react";

/** Minimum gap between two asks. */
export const ASK_MIN_GAP_MS = 1_500;

/** Rolling window and its cap. */
export const ASK_WINDOW_MS = 60_000;
export const ASK_BURST_LIMIT = 6;

/** Answer now, or answer in a moment. There is no third arm — see the
 *  header: a downgrade has nowhere to be expressed. */
export type CapsuleAskDecision =
  | { allowed: true }
  | { allowed: false; reason: "cooldown" | "burst"; retryAt: number };

const ALLOWED: CapsuleAskDecision = Object.freeze({ allowed: true });

// ── state ──────────────────────────────────────────────────────────────

/** userKey -> ascending timestamps of the asks inside the window. */
const asks = new Map<string, number[]>();
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function keyOf(userKey: string | null | undefined): string {
  return userKey ?? "anon";
}

/** Timestamps still inside the window, oldest first. Prunes in place so
 *  the map cannot grow without bound across a long session. */
function recent(key: string, now: number): number[] {
  const all = asks.get(key);
  if (!all || all.length === 0) return [];
  const kept = all.filter((t) => now - t < ASK_WINDOW_MS);
  if (kept.length !== all.length) {
    if (kept.length === 0) asks.delete(key);
    else asks.set(key, kept);
  }
  return kept;
}

// ── the decision ───────────────────────────────────────────────────────

/**
 * Would an ask be allowed right now? Pure with respect to state — it
 * records nothing, so a surface may call it on every render to decide
 * whether to disable the Ask row.
 */
export function checkCapsuleAsk(
  userKey: string | null | undefined,
  now: number = Date.now(),
): CapsuleAskDecision {
  const key = keyOf(userKey);
  const window = recent(key, now);
  if (window.length === 0) return ALLOWED;

  const last = window[window.length - 1];
  if (now - last < ASK_MIN_GAP_MS) {
    return { allowed: false, reason: "cooldown", retryAt: last + ASK_MIN_GAP_MS };
  }
  if (window.length >= ASK_BURST_LIMIT) {
    // The window frees a slot when its OLDEST ask ages out.
    return { allowed: false, reason: "burst", retryAt: window[0] + ASK_WINDOW_MS };
  }
  return ALLOWED;
}

/**
 * Claim a slot. Records ONLY on allow, so a refused ask never pushes its
 * own retry time further away.
 *
 * Call this immediately before dispatching the model call, and
 * `releaseCapsuleAsk` if the call never actually left (the user hit Esc,
 * the router re-classified, an abort landed first) — an ask that cost
 * nothing must not spend budget.
 */
export function reserveCapsuleAsk(
  userKey: string | null | undefined,
  now: number = Date.now(),
): CapsuleAskDecision {
  const decision = checkCapsuleAsk(userKey, now);
  if (!decision.allowed) return decision;
  const key = keyOf(userKey);
  const window = recent(key, now);
  asks.set(key, [...window, now]);
  bump();
  return decision;
}

/** Hand back the most recent reservation for this user. No-op when there
 *  is nothing to hand back. */
export function releaseCapsuleAsk(userKey: string | null | undefined): void {
  const key = keyOf(userKey);
  const all = asks.get(key);
  if (!all || all.length === 0) return;
  const next = all.slice(0, -1);
  if (next.length === 0) asks.delete(key);
  else asks.set(key, next);
  bump();
}

/** Test hook — drops every recorded ask. */
export function resetCapsuleAskGuard(): void {
  asks.clear();
  bump();
}

// ── the hook ───────────────────────────────────────────────────────────

export interface CapsuleAskThrottle {
  blocked: boolean;
  reason: "cooldown" | "burst" | null;
  /** Whole seconds until the next ask is allowed; 0 when not blocked.
   *  Rounded UP so the surface never says "0s" while still blocked. */
  secondsRemaining: number;
}

const NOT_BLOCKED: CapsuleAskThrottle = Object.freeze({
  blocked: false,
  reason: null,
  secondsRemaining: 0,
});

/**
 * Live throttle state for a user key.
 *
 * Re-renders on every reservation (store subscription) AND once more when
 * the current block expires (a single timer, armed only while blocked) —
 * so the row re-enables itself without a polling interval.
 */
export function useCapsuleAskThrottle(
  userKey: string | null | undefined,
): CapsuleAskThrottle {
  const storeVersion = useSyncExternalStore(subscribe, () => version, () => 0);
  const [, setTick] = useState(0);

  // Read during render on purpose: `checkCapsuleAsk` records nothing and
  // never notifies (its only side effect is pruning aged-out timestamps,
  // which is idempotent), so it is safe here and keeps the row's disabled
  // state exact rather than one tick stale.
  const decision = checkCapsuleAsk(userKey);
  const retryAt = decision.allowed ? 0 : decision.retryAt;

  // `tick` is deliberately NOT a dependency. The timer's job is to force
  // ONE re-render past the boundary; the re-render recomputes `decision`,
  // and a still-blocked state produces a DIFFERENT `retryAt`, which arms
  // the next timer through the dep list. Feeding `tick` back in instead
  // would re-arm at +40ms on every tick — a 40ms render loop for the
  // length of a burst block.
  useEffect(() => {
    if (!retryAt) return;
    // +40ms so the timer lands just PAST the boundary; firing exactly on
    // it re-reads a still-blocked state.
    const delay = Math.max(0, retryAt - Date.now()) + 40;
    const timer = setTimeout(() => setTick((n) => n + 1), delay);
    return () => clearTimeout(timer);
  }, [retryAt, storeVersion]);

  if (decision.allowed) return NOT_BLOCKED;
  return {
    blocked: true,
    reason: decision.reason,
    secondsRemaining: Math.max(1, Math.ceil((decision.retryAt - Date.now()) / 1000)),
  };
}
