// THE CAPSULE — the ONE ask-availability predicate (Part F.4 + F.5).
//
// Two different things can stop an ask, and the surface must never have
// to know which: the assistant is down (A2 degraded), or this user has
// asked too fast (the budget guard). Both collapse into one block object
// with a row label key, so the Ask row has exactly one place to read.
//
// ── What DOES NOT stop working ────────────────────────────────────────
//
// Nothing else. A block here disables the ASK lane only — the router's
// NAVIGATE / ENTITY / ACTION lanes never call the model
// (`willCallModel`), so search, jumping to a page, opening a ticker and
// running a command all keep working with the assistant fully down.
// That is the C7 promise, and it is structural: this hook cannot reach
// those lanes.
//
// ── Precedence ────────────────────────────────────────────────────────
//
// Degraded beats throttled. A cooldown message on a dead service would
// promise an answer in five seconds that is not coming.

import { useAiDegraded, AI_FAILURE_REASON_KEY, type AiFailureKind } from "@/lib/aiDegraded";
// The degraded REASON strings live in the chat lane's bundle; import it
// so `AI_FAILURE_REASON_KEY`'s keys resolve wherever this renders.
import "@/components/cfo/chat/chatDegradedI18n";
import "./capsuleEmptyI18n";
import { useCapsuleAskThrottle } from "./capsuleAskGuard";

export type CapsuleAskBlock =
  | {
      kind: "degraded";
      failure: AiFailureKind;
      /** Human-readable reason key. NEVER a raw payload — the mapper in
       *  lib/aiDegraded is the only thing that has seen one. */
      reasonKey: string;
      rowLabelKey: string;
    }
  | {
      kind: "throttled";
      reason: "cooldown" | "burst";
      secondsRemaining: number;
      rowLabelKey: string;
    };

export interface CapsuleAskAvailability {
  /** False when activating the Ask row must not dispatch a model call. */
  available: boolean;
  block: CapsuleAskBlock | null;
}

/**
 * Live ask availability for a user key.
 *
 * `userKey` should be the signed-in user id — the throttle is per user,
 * not per workspace, because the credit budget is (CLAUDE.md §16:
 * "Billing is per user, not per workspace").
 */
export function useCapsuleAskAvailability(
  userKey: string | null | undefined,
): CapsuleAskAvailability {
  const degraded = useAiDegraded();
  const throttle = useCapsuleAskThrottle(userKey);

  if (degraded) {
    return {
      available: false,
      block: {
        kind: "degraded",
        failure: degraded,
        reasonKey: AI_FAILURE_REASON_KEY[degraded],
        rowLabelKey: "capsuleEmpty.degraded.askRow",
      },
    };
  }
  if (throttle.blocked && throttle.reason) {
    return {
      available: false,
      block: {
        kind: "throttled",
        reason: throttle.reason,
        secondsRemaining: throttle.secondsRemaining,
        rowLabelKey: "capsuleEmpty.throttle.askRow",
      },
    };
  }
  return { available: true, block: null };
}

/** The Ask row's replacement copy key, or null when the row keeps its
 *  own label. Split out so a non-React caller (a row builder) can use it
 *  without pulling the hook in. */
export function capsuleAskRowLabelKey(block: CapsuleAskBlock | null): string | null {
  return block ? block.rowLabelKey : null;
}
