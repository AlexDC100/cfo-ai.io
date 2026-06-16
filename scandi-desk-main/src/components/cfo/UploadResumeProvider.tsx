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
      if (!state.current || !isInFlight(state.current.status)) return;
      if (!state.current.docId) return;
      try {
        const { subscribeToDocumentStatus } = await import("@/lib/supabase");
        if (cancelled) return;
        unsubscribe = subscribeToDocumentStatus(state.current.docId, (next) => {
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
