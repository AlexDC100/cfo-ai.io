// aiDegraded — the ONE mapper every AI failure goes through (A2).
//
// Before this module, a chat failure printed the raw error payload —
// status code, request_id, JSON braces and all — straight into the
// conversation. The contract now:
//   · the RAW payload goes to console.debug only, never the DOM;
//   · the user sees a calm panel with a Retry button and a quiet
//     "details" disclosure carrying a HUMAN-READABLE reason;
//   · while degraded, the composer and suggestion chips stay visible
//     but disabled (tooltip explains), and the state auto-recovers on
//     the next successful turn.
//
// The degraded flag is MODULE state (like the chat-cap lockout in
// chatTurns.ts): the chat shell unmounts on every tab switch and a
// failure can land while the user is elsewhere, so no component may
// own it. Components read it via `useAiDegraded()`.

import { useSyncExternalStore } from "react";
import { CfoApiError } from "@/lib/cfoApi";

/** The three reasons a user can act on. Everything the wire says
 *  collapses onto one of these — never surfaced verbatim. */
export type AiFailureKind = "service" | "usage" | "network";

/** i18n keys for the details disclosure, per kind. Strings live in
 *  components/cfo/chat/chatDegradedStrings.json (bridge-registered). */
export const AI_FAILURE_REASON_KEY: Record<AiFailureKind, string> = {
  service: "chatDegraded.reasonService",
  usage: "chatDegraded.reasonUsage",
  network: "chatDegraded.reasonNetwork",
};

/** Map an unknown thrown value onto a failure kind. Pure — no logging. */
export function classifyAiFailure(err: unknown): AiFailureKind {
  if (err instanceof CfoApiError) {
    // 429 = a limiter said no (the designed chat-cap 429 is intercepted
    // BEFORE this mapper; anything still here is a generic limit).
    if (err.status === 429) return "usage";
    // Every other HTTP status — 4xx included — reads as "the service
    // couldn't take this right now" from the user's chair. A 400 is our
    // bug, not theirs; showing them the status helps nobody.
    return "service";
  }
  // fetch() rejects with TypeError when the network path itself fails.
  if (err instanceof TypeError) return "network";
  return "service";
}

/** Classify AND log. The single entry point the send pipeline calls:
 *  the raw payload (message, status, detail, request ids) is preserved
 *  for debugging via console.debug and goes nowhere else. */
export function reportAiFailure(err: unknown): AiFailureKind {
  const kind = classifyAiFailure(err);
  try {
    const detail = err instanceof CfoApiError ? err.detail : undefined;
    // eslint-disable-next-line no-console
    console.debug("[ai] chat turn failed", { kind, error: err, detail });
  } catch {
    /* logging must never throw */
  }
  return kind;
}

// ── Degraded module state ──────────────────────────────────────────
let degraded: AiFailureKind | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function setAiDegraded(kind: AiFailureKind): void {
  degraded = kind;
  emit();
}

/** Called on every successful turn — the auto-recover half of A2. */
export function clearAiDegraded(): void {
  if (degraded === null) return;
  degraded = null;
  emit();
}

export function getAiDegraded(): AiFailureKind | null {
  return degraded;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Current degraded kind, or null when the assistant is healthy. */
export function useAiDegraded(): AiFailureKind | null {
  return useSyncExternalStore(subscribe, getAiDegraded, () => null);
}
