// THE CANVAS — LIVE TURNS.
//
// The figures. In memory, for this session, and nowhere else.
//
// `lib/canvasThread.ts` persists the CONVERSATION — questions, titles,
// step labels, artifact title keys. This module holds the other half:
// the `CapsuleTurn` each entry produced, complete with its evidence, its
// provenance and its guarded prose. That half is deliberately volatile.
//
// Reload the page and this map is empty, so every restored entry paints
// as a record with a Recompute action and NOT ONE DIGIT. That is not a
// limitation being worked around; it is the invariant. A figure the
// reader can see has been resolved by the facts gateway during THIS
// session, against the period on screen. There is no second way for a
// number to reach the canvas, because there is no second store.
//
// Keyed by ENTRY id rather than by turn id: the entry is the durable
// thing the reader points at ("recompute that one"), and the turn is
// what currently answers it. A recompute replaces the turn under the
// same entry, which is why the map is keyed this way round.

import { useSyncExternalStore } from "react";

import type { CapsuleTurn } from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerClient";

const turns = new Map<string, CapsuleTurn>();
const listeners = new Set<() => void>();

/** Bumped on every mutation. `useSyncExternalStore` needs a snapshot that
 *  is referentially stable between renders, and a `Map` is not — so the
 *  subscription is on the version and reads go through `getLiveTurn`. */
let version = 0;

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function setLiveTurn(entryId: string, turn: CapsuleTurn): void {
  turns.set(entryId, turn);
  emit();
}

export function getLiveTurn(entryId: string): CapsuleTurn | null {
  return turns.get(entryId) ?? null;
}

export function hasLiveTurn(entryId: string): boolean {
  return turns.has(entryId);
}

export function dropLiveTurn(entryId: string): void {
  if (!turns.delete(entryId)) return;
  emit();
}

/** Every live entry id — used by the thread view to decide, per entry,
 *  whether figures may render. */
export function liveEntryIds(): string[] {
  return [...turns.keys()];
}

/** Subscribe a component to live-turn changes. Returns the version
 *  counter, which is what changes; components read the turns they need
 *  through `getLiveTurn`. */
export function useLiveTurnVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
}

export function __resetLiveTurnsForTests(): void {
  turns.clear();
  emit();
}
