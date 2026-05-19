// useIndustryAssignment — single hook that backs every Phase D component
// (IndustryBadge, IndustryPicker, IndustrySuggestionCard, IndustryAuditTrail).
//
// Responsibilities
// ────────────────
//   · Fetch the current assignment + the latest auto-detection in parallel
//     on mount (and re-fetch on `periodId` change).
//   · Expose imperative `save`, `toggleLock`, `recalc` that update the
//     local state on success so callers don't have to re-fetch.
//   · Surface a single `refresh()` entry point for the rare full reload.
//
// State machine
// ─────────────
//   loading=true               → first fetch in flight (assignment + detect)
//   loading=false, error=null  → resolved; assignment may be null (no row yet)
//   loading=false, error!=null → last fetch / mutation failed; surface to UI
//
// Why no react-query? The rest of the codebase uses raw fetch + useState
// (see `cfoApi.ts` and `BenchmarkReport.tsx`). One hook on one route
// per-page isn't worth adding a dep — but the shape is intentionally
// react-query-compatible so swapping later is trivial.

import { useCallback, useEffect, useState } from "react";

import {
  AssignmentRow,
  AssignmentUpsertBody,
  DetectResponse,
  IndustryApiError,
  detectIndustry,
  getAssignment,
  recalcAssignment,
  toggleAssignmentLock,
  upsertAssignment,
} from "@/lib/industryApi";

export interface UseIndustryAssignmentState {
  /** Current persisted assignment, or null if none exists yet. */
  assignment: AssignmentRow | null;
  /** Latest auto-detection result. Always present (fallback returns one). */
  detection: DetectResponse | null;
  loading: boolean;
  /** Set when any of the three mutations is in flight (save/lock/recalc). */
  mutating: boolean;
  error: IndustryApiError | null;
  /** True when the backend reported HTTP 404 on EITHER the assignment
   *  read or the detection call — meaning the period id in the URL
   *  doesn't exist server-side. Distinct from `assignment === null`,
   *  which is the legitimate "no assignment yet" first-render state.
   *  See diagnostics/SET_INDUSTRY_PERIOD_NOT_FOUND_2026-05-18.md
   *  (defect D3). */
  periodNotFound: boolean;
  /** Force a fresh fetch of both assignment + detection. */
  refresh: () => Promise<void>;
  /** POST a user override (or auto-source write). */
  save: (body: AssignmentUpsertBody) => Promise<AssignmentRow | null>;
  /** Lock or unlock the assignment. */
  toggleLock: (locked: boolean, reason?: string) => Promise<AssignmentRow | null>;
  /** Re-run detection and persist primary. Will 409 if locked. */
  recalc: () => Promise<AssignmentRow | null>;
}

export function useIndustryAssignment(periodId: string | null | undefined): UseIndustryAssignmentState {
  const [assignment, setAssignment] = useState<AssignmentRow | null>(null);
  const [detection, setDetection] = useState<DetectResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<IndustryApiError | null>(null);
  // D3 — explicit periodNotFound flag. Distinct from `assignment === null`
  // (legitimate first-render empty state) and from `error` (transport
  // failure). Set when EITHER /assignment/:id OR /detect/:id returns 404.
  const [periodNotFound, setPeriodNotFound] = useState(false);

  const fetchBoth = useCallback(
    async (pid: string) => {
      setLoading(true);
      setError(null);
      // Reset the 404 flag at the start of every fetch. If either of the
      // two calls below returns 404 we'll flip it back on; if both return
      // valid responses we want the prior 404 state cleared (could
      // happen on a periodId change to a fresh, real period).
      setPeriodNotFound(false);

      // The two reads have different "expected 404" semantics:
      //   · getAssignment: 404 = "no assignment yet" (legitimate empty).
      //     industryApi.getAssignment ALREADY swallows 404 → null. So a
      //     null result here means EITHER "no assignment" OR "period
      //     doesn't exist" — we can't tell apart from this layer alone.
      //   · detectIndustry: 404 = "period doesn't exist" (period not found).
      //     The backend defensively raises 404 when the period row is
      //     gone; that's the unambiguous signal we use to flip the flag.
      let sawPeriodNotFound = false;
      try {
        const [a, d] = await Promise.all([
          getAssignment(pid).catch((e) => {
            // getAssignment internally swallows 404 to null, so the
            // only way to land here is non-404. Treat as transport
            // error and surface it via `error`.
            if (e instanceof IndustryApiError) {
              setError(e);
            }
            return null;
          }),
          detectIndustry(pid).catch((e) => {
            if (e instanceof IndustryApiError && e.status === 404) {
              // STALE URL — the period referenced doesn't exist.
              // Flip the explicit flag instead of silently returning
              // null, which would look identical to "detection
              // produced no candidates" (a very different condition).
              sawPeriodNotFound = true;
              return null;
            }
            throw e;
          }),
        ]);
        setAssignment(a);
        setDetection(d);
        setPeriodNotFound(sawPeriodNotFound);
      } catch (e) {
        if (e instanceof IndustryApiError) setError(e);
        else setError(new IndustryApiError(String(e), 0, null));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Initial + periodId-change load.
  useEffect(() => {
    if (!periodId) {
      setAssignment(null);
      setDetection(null);
      setLoading(false);
      setError(null);
      setPeriodNotFound(false);
      return;
    }
    void fetchBoth(periodId);
  }, [periodId, fetchBoth]);

  const refresh = useCallback(async () => {
    if (!periodId) return;
    await fetchBoth(periodId);
  }, [periodId, fetchBoth]);

  // ── Mutations ─────────────────────────────────────────────────
  // Each returns the new server row so callers can read fresh values
  // without waiting for a refresh — handy for toast copy ("Switched
  // to Real estate commercial rental").

  const save = useCallback(
    async (body: AssignmentUpsertBody): Promise<AssignmentRow | null> => {
      if (!periodId) return null;
      setMutating(true);
      setError(null);
      try {
        const row = await upsertAssignment(periodId, body);
        setAssignment(row);
        return row;
      } catch (e) {
        if (e instanceof IndustryApiError) setError(e);
        else setError(new IndustryApiError(String(e), 0, null));
        return null;
      } finally {
        setMutating(false);
      }
    },
    [periodId],
  );

  const toggleLock = useCallback(
    async (locked: boolean, reason?: string): Promise<AssignmentRow | null> => {
      if (!periodId) return null;
      setMutating(true);
      setError(null);
      try {
        const row = await toggleAssignmentLock(periodId, locked, reason);
        setAssignment(row);
        return row;
      } catch (e) {
        if (e instanceof IndustryApiError) setError(e);
        else setError(new IndustryApiError(String(e), 0, null));
        return null;
      } finally {
        setMutating(false);
      }
    },
    [periodId],
  );

  const recalc = useCallback(async (): Promise<AssignmentRow | null> => {
    if (!periodId) return null;
    setMutating(true);
    setError(null);
    try {
      const row = await recalcAssignment(periodId);
      setAssignment(row);
      // The recalc endpoint also wrote a new detection — pull a fresh
      // copy so the suggestion card reflects what just got persisted.
      const fresh = await detectIndustry(periodId).catch(() => null);
      if (fresh) setDetection(fresh);
      return row;
    } catch (e) {
      if (e instanceof IndustryApiError) setError(e);
      else setError(new IndustryApiError(String(e), 0, null));
      return null;
    } finally {
      setMutating(false);
    }
  }, [periodId]);

  return {
    assignment,
    detection,
    loading,
    mutating,
    error,
    periodNotFound,
    refresh,
    save,
    toggleLock,
    recalc,
  };
}
