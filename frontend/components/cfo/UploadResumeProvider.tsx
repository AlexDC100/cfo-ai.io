// UploadResumeProvider.tsx — mounted once at AppShell. On first mount,
// checks the persisted upload state in localStorage. If the persisted
// upload is still in-flight (queued / extracting / mapping / computing
// / narrating), re-subscribes to subscribeToDocumentStatus to continue
// polling. Without this, a page refresh during an analysis would leave
// the DocumentChip stuck at the last persisted status (no further
// updates) because the original subscription was on the unmounted
// FinancialStatements page.
//
// This is purely a side-effect provider — it renders nothing. The
// useEffect runs once on mount; the cleanup unsubscribes when the app
// shell unmounts (rare). New uploads kicked off from
// FinancialStatements.onFileChosen() establish their own subscription
// in-flight, so this provider only matters for the refresh-during-
// analysis path.

import { useEffect } from "react";

import {
  isInFlight,
  patchUpload,
  readUploadStore,
} from "@/lib/uploadStore";

export function UploadResumeProvider(): null {
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    void (async () => {
      const state = readUploadStore();
      if (!state.current || !state.current.docId) return;
      // A persisted FAILED entry is reconciled against the server ONCE
      // (2026-09-20 P0). The browser can record "failed" for a document the
      // server went on to analyze — a stale code chunk, a dropped socket, a
      // refusal the user later confirmed from another tab. Left alone, that
      // local verdict outlived the truth forever. Only a server status that
      // PROVES progress overrides it; "queued" does not (a refused document
      // stays queued and must keep its failed banner and its actions).
      if (state.current.status === "failed") {
        try {
          const { fetchDocumentStatus } = await import("@/lib/supabase");
          const row = await fetchDocumentStatus(state.current.docId);
          if (cancelled || !row) return;
          const still = readUploadStore().current;
          if (!still || still.docId !== row.id || still.status !== "failed") return;
          if (row.status === "analyzed") {
            patchUpload({ status: "analyzed", error: null, periodId: row.period_id ?? null });
            return;
          }
          if (row.status === "failed" || row.status === "queued") {
            if (row.status === "failed" && row.error) patchUpload({ status: "failed", error: row.error });
            return;
          }
          patchUpload({ status: row.status, error: null, periodId: row.period_id ?? null });
        } catch {
          return; /* offline — keep the local verdict and its actions */
        }
      }
      const live = readUploadStore().current;
      if (!live || !live.docId || !isInFlight(live.status)) return;
      try {
        const { subscribeToDocumentStatus } = await import("@/lib/supabase");
        if (cancelled) return;
        unsubscribe = subscribeToDocumentStatus(live.docId, (next) => {
          patchUpload({
            status: next.status,
            error: next.error,
            periodId: next.period_id ?? null,
          });
        });
      } catch {
        /* supabase not configured / network — chip will read stale state */
      }
    })();
    return () => {
      cancelled = true;
      if (unsubscribe) {
        try { unsubscribe(); } catch { /* non-fatal */ }
      }
    };
  }, []);
  return null;
}
