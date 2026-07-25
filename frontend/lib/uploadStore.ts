// uploadStore.ts — global persistent upload state.
//
// Why this exists
// ───────────────
// Pre-fix, `uploadInFlight` lived in `useState` on FinancialStatements.tsx
// (the dashboard page). The moment the user navigated to /products,
// /benchmark, /settings, etc. the dashboard component unmounted and the
// upload state vanished. Coming back to the dashboard reset it to null.
// A page refresh during an analysis dropped the state entirely and left
// the user staring at "Step 0 of 6" on the next visit if anything was
// still running.
//
// This store fixes both:
//   • Single source of truth shared across all pages (same
//     useSyncExternalStore pattern as thresholds.ts / decisionRulesStore.ts).
//   • localStorage key `cfo-upload-current` so the active upload survives
//     refresh.
//   • Auto-resume: on mount, App.tsx (or AppShell) checks the persisted
//     status; if it's still in-progress, it re-subscribes to
//     subscribeToDocumentStatus(docId, ...) so polling picks up where it
//     left off.
//
// `current` is the single live upload (one at a time per session — multi-
// document support is scaffolded via `history` but the active surface
// only shows `current`). The store does NOT hold the parsed data; that
// stays in React Query (`["sales-dataset", id]`) where stale-while-
// revalidate is built in. This store only holds the upload-side metadata.

import { useSyncExternalStore } from "react";

import type { DocumentStatus } from "./supabase";

export const STORAGE_KEY = "cfo-upload-current";

/** Which surface owns this upload. The dashboard (financial statements) and
 *  the products (SKU dataset) pipelines are DIFFERENT things — each shows its
 *  own loading spinner + scan takeover only for its own uploads. The council
 *  sphere / document chip / resume still react to whichever is in flight. */
export type UploadSurface = "dashboard" | "products";

export interface UploadDoc {
  docId: string;
  filename: string;
  status: DocumentStatus;
  /** Owning surface — defaults to "dashboard" for legacy persisted entries. */
  surface: UploadSurface;
  /** Wall-clock timestamp (ms since epoch) of when this upload was first
   *  observed. Used to expire abandoned `analyzing` entries that have been
   *  sitting around for hours (the backend would have errored long
   *  before, but stale FE state shouldn't surface a phantom progress
   *  card). */
  startedAt: number;
  /** Last status update timestamp. Helps the resume-on-refresh logic
   *  decide whether to even bother re-subscribing to a doc that's been
   *  inactive for ages. */
  updatedAt: number;
  error?: string | null;
  /** Period id once the analysis lands. Used by the navigation handler
   *  on the dashboard to route into State B once status hits "analyzed". */
  periodId?: string | null;
}

interface State {
  current: UploadDoc | null;
}

// Statuses that mean the worker is (or should be) actively progressing.
const TERMINAL_STATUSES = new Set<DocumentStatus>(["analyzed", "failed"]);
// Treat anything analyzing-related as "in-flight, keep polling".
export function isInFlight(status: DocumentStatus | undefined | null): boolean {
  if (!status) return false;
  return !TERMINAL_STATUSES.has(status as DocumentStatus);
}

// ── In-memory cache ─────────────────────────────────────────────────────────

let cached: State | null = null;

function read(): State {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cached = { current: null };
      return cached;
    }
    const parsed = JSON.parse(raw) as Partial<UploadDoc> | null;
    if (!parsed || typeof parsed !== "object" || !parsed.docId) {
      cached = { current: null };
      return cached;
    }
    // Expire stale in-flight entries — if the last update was more than
    // 30 minutes ago and the status was still "in-flight", treat the job
    // as abandoned and don't restore the progress card. (The user will
    // see the period if it actually landed; nothing-happened case stays
    // out of the way.)
    const ageMs = Date.now() - (parsed.updatedAt ?? parsed.startedAt ?? 0);
    if (isInFlight(parsed.status as DocumentStatus) && ageMs > 30 * 60 * 1000) {
      cached = { current: null };
      return cached;
    }
    cached = {
      current: {
        docId: String(parsed.docId),
        filename: String(parsed.filename ?? ""),
        status: (parsed.status as DocumentStatus) ?? "queued",
        surface: (parsed.surface as UploadSurface) ?? "dashboard",
        startedAt: Number(parsed.startedAt ?? Date.now()),
        updatedAt: Number(parsed.updatedAt ?? Date.now()),
        error: parsed.error ?? null,
        periodId: parsed.periodId ?? null,
      },
    };
    return cached;
  } catch {
    cached = { current: null };
    return cached;
  }
}

function persist(state: State): void {
  try {
    if (state.current) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.current));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    /* quota / private mode — UI still works in-memory */
  }
}

// ── Subscribers ─────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();
function emit(): void {
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  // Cross-tab sync: if another tab updates the same key, propagate.
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      cached = null;
      emit();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): State {
  return read();
}

function getServerSnapshot(): State {
  return { current: null };
}

// ── Public API ──────────────────────────────────────────────────────────────

export function useUploadStore(): State {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function readUploadStore(): State {
  return read();
}

/** Start tracking a new upload. Replaces whatever's currently in-flight
 *  (one active upload at a time). Caller passes the doc metadata as soon
 *  as the documents row is created in Supabase. */
export function startUpload(doc: {
  docId: string;
  filename: string;
  status?: DocumentStatus;
  /** Owning surface — defaults to "dashboard" so existing callers are unchanged. */
  surface?: UploadSurface;
}): void {
  const now = Date.now();
  const next: State = {
    current: {
      docId: doc.docId,
      filename: doc.filename,
      status: doc.status ?? "queued",
      surface: doc.surface ?? "dashboard",
      startedAt: now,
      updatedAt: now,
      error: null,
      periodId: null,
    },
  };
  cached = next;
  persist(next);
  emit();
}

/** Patch the active upload. Callers (the subscribeToDocumentStatus
 *  callback) pass new status / error / period_id as the backend reports
 *  them. No-ops when there's no active upload. */
export function patchUpload(
  patch: Partial<Omit<UploadDoc, "docId" | "startedAt">>,
): void {
  const state = read();
  if (!state.current) return;
  const next: State = {
    current: {
      ...state.current,
      ...patch,
      updatedAt: Date.now(),
    },
  };
  cached = next;
  persist(next);
  emit();
}

/** Clear the active upload — called when the user navigates away after
 *  success, dismisses the chip, or resets the workspace. */
export function clearUpload(): void {
  cached = { current: null };
  persist(cached);
  emit();
}
