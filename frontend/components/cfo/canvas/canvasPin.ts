// THE CANVAS — PINS.
//
// "Pin any artifact to the Dashboard as a live card that recomputes with
// the period."
//
// The word that does the work is RECOMPUTES. A pin is not a screenshot
// of an answer; it is a standing QUESTION plus the artifact shape that
// answered it. When the reader steps from December to January, the card
// asks the same question of January and shows January's figures — with
// January's provenance.
//
// That falls out of the store's one rule rather than being engineered on
// top of it: a pin CANNOT carry a figure, because nothing persisted on
// this surface carries a figure. If pins stored values, "live card"
// would have to mean "cached card", and a stale December number would
// sit on a January dashboard looking current. This is the same failure
// the thread store refuses, and it refuses it the same way.
//
// So the record is: question, artifact kind, title key, and when it was
// pinned. Everything numeric is resolved at render time by whatever
// renders it, from the gateway, in that session.

import { useSyncExternalStore } from "react";

import { isSafeTitleParam, type CanvasArtifactKind } from "@/lib/canvasThread";

export const CANVAS_PIN_VERSION = 1;
export const MAX_PINS = 8;

export interface CanvasPin {
  id: string;
  /** The standing question. Re-asked against whatever period is active. */
  question: string;
  kind: CanvasArtifactKind;
  /** Reviewed-copy key for the card's title. */
  titleKey: string;
  titleParams?: Record<string, string>;
  pinnedAt: number;
  /** The thread this came from, so the card can open it. */
  threadId: string;
  entryId: string;
}

const EMPTY: readonly CanvasPin[] = Object.freeze([]);

export function canvasPinKey(orgId: string | null | undefined): string {
  return `cfo-canvas-pins-v1:${orgId ?? "anon"}`;
}

const cache = new Map<string, readonly CanvasPin[]>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function sanitize(pin: CanvasPin): CanvasPin {
  const params = pin.titleParams;
  let safe: Record<string, string> | undefined;
  if (params) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      // The SAME predicate the thread store uses — not a second opinion
      // about what a figure is. Two sanitizers with two rules is how one
      // of them ends up being the lenient one.
      if (typeof v === "string" && isSafeTitleParam(v)) out[k] = v;
    }
    if (Object.keys(out).length) safe = out;
  }
  return {
    id: pin.id,
    question: pin.question,
    kind: pin.kind,
    titleKey: pin.titleKey,
    ...(safe ? { titleParams: safe } : {}),
    pinnedAt: pin.pinnedAt,
    threadId: pin.threadId,
    entryId: pin.entryId,
  };
}

function read(key: string): readonly CanvasPin[] {
  const hit = cache.get(key);
  if (hit) return hit;
  let value: readonly CanvasPin[] = EMPTY;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as { version?: number; pins?: CanvasPin[] };
      if (parsed && parsed.version === CANVAS_PIN_VERSION && Array.isArray(parsed.pins)) {
        value = parsed.pins.filter((p) => p && typeof p.id === "string").map(sanitize);
      }
    }
  } catch {
    value = EMPTY;
  }
  cache.set(key, value);
  return value;
}

function write(key: string, next: readonly CanvasPin[]): void {
  const capped = next.slice(0, MAX_PINS);
  cache.set(key, capped);
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify({ version: CANVAS_PIN_VERSION, pins: capped }),
    );
  } catch {
    /* private mode / quota */
  }
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getCanvasPins(orgId: string | null | undefined): readonly CanvasPin[] {
  return read(canvasPinKey(orgId));
}

export function useCanvasPins(orgId: string | null | undefined): readonly CanvasPin[] {
  const key = canvasPinKey(orgId);
  return useSyncExternalStore(
    subscribe,
    () => read(key),
    () => EMPTY,
  );
}

/** Toggle. Returns the state AFTER the toggle, so the caller can
 *  announce it without re-reading. */
export function toggleCanvasPin(
  orgId: string | null | undefined,
  pin: CanvasPin,
): boolean {
  const key = canvasPinKey(orgId);
  const current = read(key);
  const existing = current.find((p) => p.entryId === pin.entryId && p.kind === pin.kind);
  if (existing) {
    write(key, current.filter((p) => p.id !== existing.id));
    return false;
  }
  write(key, [sanitize(pin), ...current]);
  return true;
}

export function isPinned(
  pins: readonly CanvasPin[],
  entryId: string,
  kind: CanvasArtifactKind,
): boolean {
  return pins.some((p) => p.entryId === entryId && p.kind === kind);
}

export function __resetCanvasPinsForTests(): void {
  cache.clear();
  emit();
}
