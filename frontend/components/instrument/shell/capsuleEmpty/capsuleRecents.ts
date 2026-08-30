// THE CAPSULE — recent questions (Part D.3).
//
// The last handful of questions typed into the Capsule, newest first, so
// the empty state can list them and ⌘K → ArrowUp can recall the last one
// without a round trip.
//
// ── Device-local, on purpose ──────────────────────────────────────────
//
// This is the working set of THIS screen on THIS device — the same class
// as DocsPanel filters and the upload-resume cache, which CLAUDE.md §16
// Milestone C lists under "Deliberately NOT synced". It is not a
// preference (it describes neither the user nor the company) and it is
// not data (nothing downstream reads it). So: localStorage, keyed per
// workspace, never mirrored to `user_prefs` / `org_prefs`.
//
// Keyed per workspace because a question about a RON manufacturer is
// noise in a EUR property vehicle's palette — the same reasoning that
// splits company prefs from personal ones.
//
// ── Module state, not component state ─────────────────────────────────
//
// The palette unmounts every time it closes. A recent question recorded
// on send must survive that, so the store lives at module scope and
// components subscribe through `useSyncExternalStore` — the same shape as
// `aiDegraded`'s degraded flag and `chatTurns`' cap lockout.

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

import { foldQuery } from "@/lib/capsuleRouter";

/** How many questions the list keeps. Eight fills the empty state
 *  without turning it into a history page — history lives in /chat. */
export const MAX_RECENTS = 8;

/** Longest question the list will store. A pasted essay is not a
 *  "recent question", and localStorage is a shared budget. */
export const MAX_RECENT_LENGTH = 240;

const KEY_PREFIX = "cfo:capsule-recents:v1:";

function storageKey(orgId: string | null | undefined): string {
  return `${KEY_PREFIX}${orgId ?? "anon"}`;
}

// ── the store ──────────────────────────────────────────────────────────
//
// `getSnapshot` must return a STABLE reference or React re-renders
// forever, so parsed lists are cached per key and only replaced on write.

const cache = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();
const EMPTY: readonly string[] = Object.freeze([]);

function read(key: string): readonly string[] {
  const hit = cache.get(key);
  if (hit) return hit;
  let parsed: readonly string[] = EMPTY;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const value: unknown = JSON.parse(raw);
      if (Array.isArray(value)) {
        parsed = Object.freeze(
          value
            .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
            .slice(0, MAX_RECENTS),
        );
      }
    }
  } catch {
    /* unreadable or unavailable storage — an empty list is correct */
  }
  cache.set(key, parsed);
  return parsed;
}

function write(key: string, next: readonly string[]): void {
  const frozen = Object.freeze([...next]);
  cache.set(key, frozen);
  try {
    localStorage.setItem(key, JSON.stringify(frozen));
  } catch {
    /* storage full or blocked — the session still works, unpersisted */
  }
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

// ── the API ────────────────────────────────────────────────────────────

/** The recent questions for a workspace, newest first. */
export function capsuleRecents(orgId: string | null | undefined): readonly string[] {
  return read(storageKey(orgId));
}

/**
 * Record a question. Newest first, de-duplicated on the router's own
 * folded form so "Cash flow?" does not sit beside "cash flow ?".
 *
 * Deliberately takes the question the user ACTUALLY sent — this is not
 * the place to normalise copy, only to compare it.
 */
export function rememberCapsuleQuestion(
  orgId: string | null | undefined,
  question: string,
): void {
  const text = (question ?? "").trim();
  if (!text || text.length > MAX_RECENT_LENGTH) return;
  const key = storageKey(orgId);
  const folded = foldQuery(text);
  if (!folded) return;
  const current = read(key);
  const next = [text, ...current.filter((q) => foldQuery(q) !== folded)].slice(0, MAX_RECENTS);
  // Nothing moved — skip the write so a repeated send does not churn
  // storage or wake every subscriber.
  if (next.length === current.length && next.every((q, i) => q === current[i])) return;
  write(key, next);
}

export function clearCapsuleRecents(orgId: string | null | undefined): void {
  const key = storageKey(orgId);
  if (read(key).length === 0) return;
  write(key, EMPTY);
}

/** Test hook — drops the in-memory cache so a test can seed localStorage
 *  directly and still be read fresh. */
export function resetCapsuleRecentsCache(): void {
  cache.clear();
  for (const l of listeners) l();
}

/** Live recent-question list for a workspace. */
export function useCapsuleRecents(orgId: string | null | undefined): readonly string[] {
  const key = storageKey(orgId);
  return useSyncExternalStore(
    subscribe,
    () => read(key),
    () => EMPTY,
  );
}

// ── recall (⌘K then ArrowUp) ───────────────────────────────────────────

export interface CapsuleRecall {
  /** The recalled question, or null when the cursor sits "below" the
   *  list (index -1) — which is the composing position. */
  value: string | null;
  index: number;
  count: number;
  /** Step one older. Returns the text to place in the input, or null
   *  when there is nothing older (the caller then leaves the input
   *  alone rather than clearing it). */
  older: () => string | null;
  /** Step one newer; at the newest, returns "" — the empty composing
   *  position the user started from. */
  newer: () => string | null;
  reset: () => void;
}

/**
 * The shell-history idiom, bound to the recents list.
 *
 * Index −1 is "composing"; 0 is the most recent question. The caller
 * wires it to ArrowUp/ArrowDown **only while the input is empty or shows
 * a recalled value**, so arrowing through the palette's own rows keeps
 * working the moment the user types.
 */
export function useCapsuleRecall(orgId: string | null | undefined): CapsuleRecall {
  const recents = useCapsuleRecents(orgId);
  const [index, setIndex] = useState(-1);

  const older = useCallback(() => {
    if (recents.length === 0) return null;
    const next = Math.min(index + 1, recents.length - 1);
    setIndex(next);
    return recents[next] ?? null;
  }, [index, recents]);

  const newer = useCallback(() => {
    if (index < 0) return null;
    const next = index - 1;
    setIndex(next);
    return next < 0 ? "" : (recents[next] ?? "");
  }, [index, recents]);

  const reset = useCallback(() => setIndex(-1), []);

  return useMemo(
    () => ({
      value: index >= 0 ? (recents[index] ?? null) : null,
      index,
      count: recents.length,
      older,
      newer,
      reset,
    }),
    [index, recents, older, newer, reset],
  );
}
