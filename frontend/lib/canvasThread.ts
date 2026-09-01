// THE CANVAS — THE THREAD STORE.
//
// The Capsule's thread (`capsuleAnswer/capsuleThread.ts`) is a ten-minute
// scratchpad: one conversation, module state, gone after a lunch break.
// That is exactly right for an overlay you press Escape on.
//
// The Canvas is the opposite object. It is a DOCUMENT you build — you
// come back to it tomorrow, you keep several of them per company, and
// you expect the one you had open to still be open. So this store is
// persisted, per workspace, and lists its threads.
//
// ══ THE ONE RULE THAT SHAPES EVERYTHING HERE ═══════════════════════════
//
//   NO FIGURE IS EVER PERSISTED.
//
// Not the evidence, not a fact value, not a rendered amount, not a chart
// series. `serialize()` writes questions, titles, timestamps, artifact
// TITLE KEYS and step labels — and nothing else. `CANVAS_PERSISTED_KEYS`
// is the allowlist and `serializeThread` is built from it, so a field
// added to `CanvasEntry` is DROPPED by default rather than silently
// written.
//
// Two independent reasons, and either alone would be sufficient:
//
//   THE LAW. Every numeral the reader sees is a resolved fact from the
//   facts gateway, rendered through <Amount>, in THIS session. A figure
//   read back out of localStorage has no gateway behind it — it is a
//   digit whose provenance is "someone's browser once wrote this down".
//   That is indistinguishable, at the DOM, from a digit a model typed.
//
//   STALENESS IS WORSE THAN ABSENCE. A December answer restored over
//   January's figures would still be TRUE, and would look like it was
//   about the period on screen. That is the failure mode the Capsule's
//   ten-minute expiry exists to prevent, and persistence makes it
//   permanent rather than transient.
//
// So a restored entry is a QUESTION plus the SHAPE of what answered it.
// Its figures live only in `liveTurns` — module memory, never written —
// and when the scope has moved on, the entry renders as a stale record
// with a Recompute action and NO number at all. `isEntryLive` is the one
// predicate that decides this, and the gate plants a scope change and
// expects every figure to disappear.
//
// ══ SCOPE ══════════════════════════════════════════════════════════════
//
// `scopeKey(periodId)` — the period the answer was computed against.
// Recorded per ENTRY (not per thread) because a thread legitimately
// spans a period switch: you ask about December, you step to January,
// you ask again. The December entries go stale and say so; the January
// ones are live. A thread-level scope would have to throw the whole
// conversation away to stay honest.
//
// ══ WHAT IS NOT HERE ═══════════════════════════════════════════════════
//
// No React beyond one `useSyncExternalStore` hook, no i18n, no fetch, no
// clock read that is not passed in. Everything decision-shaped is a pure
// function of its arguments, which is what lets the unit gate assert
// behaviour rather than snapshot a render.

import { useSyncExternalStore } from "react";

import { looksLikeFigure } from "@/lib/capsuleSuggestions";

// ─── Shape ─────────────────────────────────────────────────────────────

export const CANVAS_STORE_VERSION = 1;

/** Threads kept per workspace. Oldest-updated is evicted first. */
export const MAX_THREADS = 24;
/** Entries kept per thread. */
export const MAX_ENTRIES = 60;
/** Serialized budget per workspace. localStorage is ~5 MB per origin and
 *  shared with prefs, upload-resume and the run caches; a chat history
 *  may not be the thing that fills it. */
export const MAX_BYTES = 192_000;
/** Title cap, in characters. Matches the chat store's own `deriveTitle`. */
export const MAX_TITLE = 48;

/**
 * What KIND of artifact an entry produced.
 *
 * This is a FRAME vocabulary, not a renderer vocabulary: the canvas card
 * owns the chrome (title, actions, pin) and delegates the body to the
 * artifact registry, which another lane fills. Adding a kind here does
 * not render anything new — it names a slot.
 *
 * The overlapping names are spelled the way the renderer lane spells
 * them (`comparison`, not `compare`) so a bridge between the two is a
 * one-to-one map rather than a translation table — a translation table
 * is where a kind quietly goes missing. `figures`, `export` and
 * `explain` are canvas-only frames with no renderer counterpart.
 */
export type CanvasArtifactKind =
  | "figures"
  | "chart"
  | "table"
  | "export"
  | "scenario"
  | "comparison"
  | "explain";

export interface CanvasArtifactRef {
  id: string;
  kind: CanvasArtifactKind;
  /** Reviewed-copy i18n key. NEVER model text and never a rendered
   *  string — a card title is chrome, and chrome is translated. */
  titleKey: string;
  /**
   * Interpolation for `titleKey`. PROSE ONLY: every value passes
   * `looksLikeFigure` on the way in and a figure-shaped one is dropped,
   * because a card title is not a <Amount> and cannot carry provenance.
   * Same rule the suggestion engine applies to its own labels (S1).
   */
  titleParams?: Record<string, string>;
  pinned?: boolean;
}

export interface CanvasStepRecord {
  id: string;
  /** Reviewed copy key for the step line ("pulling statements"). */
  labelKey: string;
  status: "pending" | "running" | "done" | "failed";
}

export interface CanvasAttachment {
  filename: string;
  outcome: "queued" | "blocked" | "cancelled" | "failed";
  /** Reviewed copy key describing the outcome. */
  detailKey: string;
}

export interface CanvasEntry {
  id: string;
  /**
   * The reader's own words, verbatim. A question may contain a numeral
   * ("why is EBITDA 3.9M") and that is fine: it is the USER's text,
   * echoed back as user text. C1 bans a MODEL-authored digit rendered as
   * a fact — it does not ban quoting the person who typed it.
   */
  question: string;
  askedAt: number;
  /** `scopeKey()` at ask time. See the header. */
  scope: string;
  /** The slash command that produced this entry, or null. */
  command: string | null;
  steps: CanvasStepRecord[];
  artifacts: CanvasArtifactRef[];
  attachment: CanvasAttachment | null;
}

export interface CanvasThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  entries: CanvasEntry[];
}

export interface CanvasWorkspaceStore {
  version: number;
  threads: CanvasThread[];
  currentThreadId: string | null;
}

export const EMPTY_STORE: CanvasWorkspaceStore = Object.freeze({
  version: CANVAS_STORE_VERSION,
  threads: Object.freeze([]) as unknown as CanvasThread[],
  currentThreadId: null,
});

// ─── Scope ─────────────────────────────────────────────────────────────

/** The period an answer was computed against. */
export function scopeKey(periodId: string | null | undefined): string {
  return periodId ? `p:${periodId}` : "p:none";
}

/**
 * May this entry's figures be shown?
 *
 * Live means: the entry was answered against the period that is on
 * screen right now, IN THIS SESSION (a live turn exists for it). Both
 * halves matter — a matching scope with no live turn is a restored
 * record whose numbers were never written down, and a live turn under a
 * changed scope is December's answer over January's page.
 */
export function isEntryLive(
  entry: CanvasEntry,
  scope: string,
  hasLiveTurn: boolean,
): boolean {
  return hasLiveTurn && entry.scope === scope;
}

// ─── Titles ────────────────────────────────────────────────────────────

const OPENERS =
  /^(can you|could you|please|hey|hi|so|ok|okay|i want to|i'd like to|i would like to|what is|what's|what are|how do i|how does|how much|tell me|show me|give me|poti sa|poți să|te rog|arata-mi|arată-mi|cat e|cât e|care e|care este)\s+/i;

/**
 * A short, stable name for a conversation, from its first question.
 * Deterministic — same question, same title, always. Never a model call:
 * a title is chrome.
 */
export function deriveCanvasTitle(question: string): string {
  const base = (question ?? "").replace(/\s+/g, " ").trim();
  if (!base) return "";
  let t = base.replace(/^\/[a-z]+\s+/i, "");
  t = t.replace(OPENERS, "");
  t = t.replace(/[?!.,;:\s]+$/, "");
  if (!t) t = base;
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (t.length <= MAX_TITLE) return t;
  const cut = t.slice(0, MAX_TITLE);
  const space = cut.lastIndexOf(" ");
  return (space > 16 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/, "");
}

/**
 * Is this string safe to WRITE TO STORAGE as chrome?
 *
 * ══ WHY THIS IS STRICTER THAN `looksLikeFigure` ════════════════════════
 *
 * `looksLikeFigure` is the suggestion engine's rule and it is right for
 * its job: it deliberately admits bare digit runs, because "461" is an
 * account code, "December 2024" is a period, and a row that refused
 * those would refuse most real labels. The capsule gate's
 * `ALLOWED_IDENTIFIERS` records exactly that intent.
 *
 * This store has a different job. `looksLikeFigure("390000")` is FALSE —
 * correctly, for a row label — and 390000 is precisely the shape of an
 * amount in minor units. CV-P1 caught it on the gate's first run, with a
 * value smuggled through `titleParams`, which is the reason this
 * function exists at all rather than reusing the other one.
 *
 * THE RULE: a persisted title parameter is PROSE. It may carry a
 * four-digit year (period labels are the whole reason the parameter
 * exists) and nothing else numeric. Anything more permissive cannot
 * distinguish an account code from an amount, and this is the one place
 * in the product where guessing wrong writes a number to disk.
 *
 * A failing value is DROPPED, never rewritten — rewriting a label would
 * be inventing copy, which is the same rule S1 applies upstream.
 */
export function isSafeTitleParam(value: string): boolean {
  const s = (value ?? "").trim();
  if (!s) return false;
  if (looksLikeFigure(s)) return false;
  const runs = s.match(/\d+/g);
  if (!runs) return true;
  return runs.every((run) => {
    if (run.length !== 4) return false;
    const year = Number(run);
    return year >= 1900 && year <= 2100;
  });
}

/** Drop unsafe interpolation from a card title (S1, tightened). */
export function safeTitleParams(
  params: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!params) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== "string") continue;
    if (!isSafeTitleParam(v)) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// ─── Serialization — the allowlist ─────────────────────────────────────

/**
 * THE ALLOWLIST. Every field written to storage is named here, once. A
 * new field on `CanvasEntry` is not persisted until it is added, which
 * is the correct default: the failure mode this store must not have is
 * "a numeric field was added upstream and quietly started being written".
 *
 * A denylist would have the opposite default and would be wrong for
 * exactly that reason.
 */
export const CANVAS_PERSISTED_KEYS: readonly (keyof CanvasEntry)[] = Object.freeze([
  "id",
  "question",
  "askedAt",
  "scope",
  "command",
  "steps",
  "artifacts",
  "attachment",
]);

function serializeEntry(e: CanvasEntry): CanvasEntry {
  return {
    id: e.id,
    question: e.question,
    askedAt: e.askedAt,
    scope: e.scope,
    command: e.command ?? null,
    steps: e.steps.map((s) => ({ id: s.id, labelKey: s.labelKey, status: s.status })),
    artifacts: e.artifacts.map((a) => ({
      id: a.id,
      kind: a.kind,
      titleKey: a.titleKey,
      ...(a.titleParams ? { titleParams: safeTitleParams(a.titleParams) } : {}),
      ...(a.pinned ? { pinned: true } : {}),
    })),
    attachment: e.attachment
      ? {
          filename: e.attachment.filename,
          outcome: e.attachment.outcome,
          detailKey: e.attachment.detailKey,
        }
      : null,
  };
}

export function serializeStore(store: CanvasWorkspaceStore): string {
  const payload = {
    version: CANVAS_STORE_VERSION,
    currentThreadId: store.currentThreadId,
    threads: store.threads.map((t) => ({
      id: t.id,
      title: t.title,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      entries: t.entries.slice(-MAX_ENTRIES).map(serializeEntry),
    })),
  };
  return JSON.stringify(payload);
}

function parseStore(raw: string | null): CanvasWorkspaceStore {
  if (!raw) return EMPTY_STORE;
  try {
    const parsed = JSON.parse(raw) as Partial<CanvasWorkspaceStore>;
    if (!parsed || parsed.version !== CANVAS_STORE_VERSION) return EMPTY_STORE;
    const threads = Array.isArray(parsed.threads) ? parsed.threads : [];
    return {
      version: CANVAS_STORE_VERSION,
      currentThreadId: typeof parsed.currentThreadId === "string" ? parsed.currentThreadId : null,
      threads: threads
        .filter((t): t is CanvasThread => Boolean(t && typeof t.id === "string"))
        .map((t) => ({
          id: t.id,
          title: typeof t.title === "string" ? t.title : "",
          createdAt: Number(t.createdAt) || 0,
          updatedAt: Number(t.updatedAt) || 0,
          entries: (Array.isArray(t.entries) ? t.entries : [])
            .filter((e): e is CanvasEntry => Boolean(e && typeof e.id === "string"))
            .map((e) => ({
              id: e.id,
              question: typeof e.question === "string" ? e.question : "",
              askedAt: Number(e.askedAt) || 0,
              scope: typeof e.scope === "string" ? e.scope : "p:none",
              command: typeof e.command === "string" ? e.command : null,
              steps: Array.isArray(e.steps) ? e.steps : [],
              artifacts: Array.isArray(e.artifacts) ? e.artifacts : [],
              attachment: e.attachment ?? null,
            })),
        })),
    };
  } catch {
    return EMPTY_STORE;
  }
}

/** Evict oldest-updated threads until the payload fits the budget. */
export function fitToBudget(store: CanvasWorkspaceStore): CanvasWorkspaceStore {
  let threads = [...store.threads].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_THREADS);
  let next: CanvasWorkspaceStore = { ...store, threads };
  while (threads.length > 1 && serializeStore(next).length > MAX_BYTES) {
    threads = threads.slice(0, -1);
    next = { ...store, threads };
  }
  return next;
}

// ─── The store ─────────────────────────────────────────────────────────

export function canvasStorageKey(orgId: string | null | undefined): string {
  return `cfo-canvas-threads-v1:${orgId ?? "anon"}`;
}

const cache = new Map<string, CanvasWorkspaceStore>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function read(key: string): CanvasWorkspaceStore {
  const hit = cache.get(key);
  if (hit) return hit;
  let value = EMPTY_STORE;
  try {
    value = parseStore(window.localStorage.getItem(key));
  } catch {
    value = EMPTY_STORE;
  }
  cache.set(key, value);
  return value;
}

function write(key: string, next: CanvasWorkspaceStore): void {
  const fitted = fitToBudget(next);
  cache.set(key, fitted);
  try {
    window.localStorage.setItem(key, serializeStore(fitted));
  } catch {
    /* private mode / quota — the in-memory copy still serves this tab */
  }
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getCanvasStore(orgId: string | null | undefined): CanvasWorkspaceStore {
  return read(canvasStorageKey(orgId));
}

export function useCanvasStore(orgId: string | null | undefined): CanvasWorkspaceStore {
  const key = canvasStorageKey(orgId);
  return useSyncExternalStore(
    subscribe,
    () => read(key),
    () => EMPTY_STORE,
  );
}

export function newCanvasId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `cv-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  }
}

/**
 * Append an entry, creating the thread on the way if it does not exist.
 *
 * LAZY THREAD CREATION, deliberately: pressing "New chat" writes nothing.
 * An empty placeholder row would litter the rail on every other device,
 * which is the exact lesson the Supabase chat store recorded (§16
 * Milestone B).
 */
export function appendCanvasEntry(
  orgId: string | null | undefined,
  threadId: string,
  entry: CanvasEntry,
  now: number,
): void {
  const key = canvasStorageKey(orgId);
  const store = read(key);
  const existing = store.threads.find((t) => t.id === threadId);
  const thread: CanvasThread = existing
    ? {
        ...existing,
        updatedAt: now,
        title: existing.title || deriveCanvasTitle(entry.question),
        entries: [...existing.entries, entry].slice(-MAX_ENTRIES),
      }
    : {
        id: threadId,
        title: deriveCanvasTitle(entry.question),
        createdAt: now,
        updatedAt: now,
        entries: [entry],
      };
  write(key, {
    ...store,
    currentThreadId: threadId,
    threads: [thread, ...store.threads.filter((t) => t.id !== threadId)],
  });
}

export function patchCanvasEntry(
  orgId: string | null | undefined,
  threadId: string,
  entryId: string,
  patch: Partial<Pick<CanvasEntry, "steps" | "artifacts" | "attachment">>,
  now: number,
): void {
  const key = canvasStorageKey(orgId);
  const store = read(key);
  const thread = store.threads.find((t) => t.id === threadId);
  if (!thread) return;
  let touched = false;
  const entries = thread.entries.map((e) => {
    if (e.id !== entryId) return e;
    touched = true;
    return { ...e, ...patch };
  });
  if (!touched) return;
  write(key, {
    ...store,
    threads: store.threads.map((t) =>
      t.id === threadId ? { ...t, entries, updatedAt: now } : t,
    ),
  });
}

export function setCurrentCanvasThread(
  orgId: string | null | undefined,
  threadId: string | null,
): void {
  const key = canvasStorageKey(orgId);
  const store = read(key);
  if (store.currentThreadId === threadId) return;
  write(key, { ...store, currentThreadId: threadId });
}

export function deleteCanvasThread(
  orgId: string | null | undefined,
  threadId: string,
): void {
  const key = canvasStorageKey(orgId);
  const store = read(key);
  if (!store.threads.some((t) => t.id === threadId)) return;
  const threads = store.threads.filter((t) => t.id !== threadId);
  write(key, {
    ...store,
    threads,
    currentThreadId: store.currentThreadId === threadId ? null : store.currentThreadId,
  });
}

export function renameCanvasThread(
  orgId: string | null | undefined,
  threadId: string,
  title: string,
  now: number,
): void {
  const key = canvasStorageKey(orgId);
  const store = read(key);
  const clean = title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  if (!clean) return;
  write(key, {
    ...store,
    threads: store.threads.map((t) =>
      t.id === threadId ? { ...t, title: clean, updatedAt: now } : t,
    ),
  });
}

/** Test hook — the module cache is otherwise immortal within a file. */
export function __resetCanvasStoreForTests(): void {
  cache.clear();
  emit();
}
