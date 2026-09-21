// useUploadEnqueue — wraps `enqueuePipeline` with gap-C/D handling.
//
// WHAT IT DOES
// ────────────
// The Pricing V3 backend (`POST /api/pipeline/run`) returns three
// outcomes that the UI must distinguish:
//
//   · 202 queued                   → start polling document status
//   · 402 extra_doc_confirmation  → render <ExtraDocConfirmDialog/>;
//                                    on confirm, retry once
//   · 429 doc_quota_blocked        → render upgrade prompt (no retry)
//
// Wrapping this logic in one hook means every upload call site
// (FinancialStatements, DocsPanel, Products) gets identical
// behaviour for free — gap C/D enforcement can't be skipped by a
// caller forgetting to handle the 402/429 paths.
//
// USAGE
// ─────
//   const upload = useUploadEnqueue();
//   const result = await upload.enqueue(docId);
//   if (result.kind === "queued")           { /* poll status */ }
//   if (result.kind === "extra_doc_required") { /* dialog opens auto;
//                                                 await user choice */ }
//   if (result.kind === "quota_blocked")    { /* show upgrade */ }
//
// `await upload.enqueue(docId)` returns ONCE — after the user has
// resolved any modal. So callers always see a final outcome.

import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { ExtraDocConfirmDialog } from "@/components/cfo/pricing/ExtraDocConfirmDialog";
import { NonRoUpgradeDialog } from "@/components/cfo/pricing/NonRoUpgradeDialog";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { alreadyUploadedHref } from "@/lib/alreadyUploaded";
import { enqueuePipeline, type AlreadyUploaded, type EnqueuePipelineResult } from "@/lib/supabase";

/** What the caller actually sees after `await upload.enqueue(docId)`. */
export type UploadOutcome =
  | { kind: "queued" }
  | { kind: "extra_doc_cancelled" }    // user dismissed the dialog
  | { kind: "quota_blocked"; message: string; upgradeUrl: string }
  // 2026-08 — non-RO document on a plan without the Multi-Country
  // entitlement. The hook shows NonRoUpgradeDialog itself; this outcome
  // just tells the caller the upload did not queue.
  | { kind: "non_ro_blocked"; message: string }
  // 2026-09-21 — the server archived the document as a duplicate of a live
  // copy (same file, account, company, period). The hook has already shown
  // "Already uploaded — open it"; the caller clears its card — this is not
  // a failure and nothing was counted.
  | { kind: "duplicate"; existingDocumentId: string; periodId: string | null }
  | { kind: "transport_failed"; message: string };

/** Where an upload was made from — decides where "open it" leads. */
export type UploadSurface = "financial" | "sku";

interface PendingExtra {
  documentId: string;
  planKey: string;
  docsUsed: number;
  docsIncluded: number;
  extraDocEur: number | null;
  serverMessage: string;
  /** Settled with the eventual outcome after the user dismisses or confirms. */
  resolve: (outcome: UploadOutcome) => void;
}

interface PendingNonRo {
  serverMessage: string;
  /** Settled once the user closes the upgrade prompt. */
  resolve: (outcome: UploadOutcome) => void;
}

export function useUploadEnqueue() {
  const { toast } = useToast();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [pending, setPending] = useState<PendingExtra | null>(null);
  const [pendingNonRo, setPendingNonRo] = useState<PendingNonRo | null>(null);
  // OWNERSHIP of the pending promise lives in a ref, not in `pending`
  // state. MEASURED IN PRODUCTION (2026-09-12, 05:50 UTC): the dialog
  // fired onConfirmed() and then onClose() in the same tick. handleConfirmed
  // called setPending(null) and awaited the retry enqueue; handleClose ran
  // next, read the STALE closure `pending` (state does not update inside a
  // render's closures), and resolved the upload as extra_doc_cancelled
  // first. The caller marked the document "failed" ("Analysis failed" at
  // step 1 of 5) while the retry it never heard about went 202 → analyzed
  // in the background. Every paid extra document hit this. The ref is
  // read at call time, so whichever handler takes the promise first owns
  // it and the other is a no-op.
  const pendingRef = useRef<PendingExtra | null>(null);

  /** "Already uploaded — open it" (RO "Deja încărcat — deschide"), with
   *  the action that opens the existing analysis. Shown for a
   *  pre-storage duplicate (uploadDocument's `duplicate`) and for one the
   *  server caught at /api/pipeline/run — never as an error. */
  const notifyAlreadyUploaded = useCallback(
    (dup: AlreadyUploaded, surface: UploadSurface = "financial") => {
      const href = alreadyUploadedHref(dup, surface);
      toast({
        title: t("upload.alreadyUploaded"),
        description: t("upload.alreadyUploadedBody"),
        action: (
          <ToastAction
            altText={t("upload.alreadyUploaded")}
            data-testid="already-uploaded-link"
            onClick={() => navigate(href)}
          >
            {t("upload.openExisting")}
          </ToastAction>
        ),
      });
    },
    [navigate, t, toast],
  );

  /** Enqueue a pipeline run for `documentId`. Returns once the flow
   *  has reached a terminal state (queued, cancelled, blocked, failed). */
  const enqueue = useCallback(
    async (documentId: string, opts: { surface?: UploadSurface } = {}): Promise<UploadOutcome> => {
      const first = await enqueuePipeline(documentId);
      if (first.kind === "duplicate") {
        notifyAlreadyUploaded(
          { existingDocumentId: first.existingDocumentId, periodId: first.periodId },
          opts.surface ?? "financial",
        );
        return { kind: "duplicate", existingDocumentId: first.existingDocumentId, periodId: first.periodId };
      }
      return _resolveEnqueueOutcome(first, documentId);
    },
    [notifyAlreadyUploaded],
  );

  /** Internal: turn an EnqueuePipelineResult into a UploadOutcome,
   *  possibly via the modal. Lives inside the hook closure so it can
   *  setState. */
  const _resolveEnqueueOutcome = useCallback(
    async (
      result: EnqueuePipelineResult,
      documentId: string,
    ): Promise<UploadOutcome> => {
      if (result.kind === "queued") return { kind: "queued" };
      if (result.kind === "duplicate") {
        notifyAlreadyUploaded({ existingDocumentId: result.existingDocumentId, periodId: result.periodId });
        return { kind: "duplicate", existingDocumentId: result.existingDocumentId, periodId: result.periodId };
      }
      if (result.kind === "transport_failed") {
        toast({
          title: "Couldn't start analysis",
          description: result.message,
          variant: "destructive",
        });
        return { kind: "transport_failed", message: result.message };
      }
      if (result.kind === "quota_blocked") {
        toast({
          title: "Document quota reached",
          description: result.message,
          variant: "destructive",
        });
        return {
          kind: "quota_blocked",
          message: result.message,
          upgradeUrl: result.upgradeUrl ?? "/pricing",
        };
      }
      if (result.kind === "non_ro_blocked") {
        // Friendly upgrade prompt, not an error toast — the plan simply
        // doesn't include non-RO documents. Resolves when dismissed.
        return new Promise<UploadOutcome>((resolve) => {
          setPendingNonRo({ serverMessage: result.message, resolve });
        });
      }
      // 402 extra_doc_required → modal
      return new Promise<UploadOutcome>((resolve) => {
        const next: PendingExtra = {
          documentId,
          planKey: result.planKey,
          docsUsed: result.docsUsed,
          docsIncluded: result.docsIncluded,
          extraDocEur: result.extraDocEur,
          serverMessage: result.message,
          resolve,
        };
        pendingRef.current = next;
        setPending(next);
      });
    },
    [toast, notifyAlreadyUploaded],
  );

  // ── Dialog handlers ─────────────────────────────────────────
  const handleClose = useCallback(() => {
    // Dismissed WITHOUT confirming. If handleConfirmed already took the
    // promise (ref is null), a trailing close from the dialog unmounting
    // is a no-op — it must not resolve a confirmed upload as cancelled.
    const owned = pendingRef.current;
    if (!owned) return;
    pendingRef.current = null;
    owned.resolve({ kind: "extra_doc_cancelled" });
    setPending(null);
  }, []);

  const handleConfirmed = useCallback(async () => {
    // Take ownership SYNCHRONOUSLY, before the first await, so no close
    // event racing this handler can settle the promise underneath it.
    const owned = pendingRef.current;
    if (!owned) return;
    pendingRef.current = null;
    setPending(null);
    // After confirm, retry the enqueue. The server now sees the
    // reserved extra slot and should return 202.
    const retry = await enqueuePipeline(owned.documentId);
    owned.resolve(await _resolveEnqueueOutcome(retry, owned.documentId));
  }, [_resolveEnqueueOutcome]);

  const handleNonRoClose = useCallback(() => {
    if (!pendingNonRo) return;
    pendingNonRo.resolve({
      kind: "non_ro_blocked",
      message: pendingNonRo.serverMessage,
    });
    setPendingNonRo(null);
  }, [pendingNonRo]);

  // ── Dialog element — caller mounts this once in their tree ──
  const dialog = pending ? (
    <ExtraDocConfirmDialog
      open
      onClose={handleClose}
      onConfirmed={handleConfirmed}
      planKey={pending.planKey}
      docsUsed={pending.docsUsed}
      docsIncluded={pending.docsIncluded}
      extraDocEur={pending.extraDocEur}
      serverMessage={pending.serverMessage}
    />
  ) : pendingNonRo ? (
    <NonRoUpgradeDialog
      open
      onClose={handleNonRoClose}
      serverMessage={pendingNonRo.serverMessage}
    />
  ) : null;

  return {
    enqueue,
    dialog,
    notifyAlreadyUploaded,
    /** Pretty-named convenience for callers that prefer to navigate
     *  to /pricing themselves on quota-blocked. */
    goToPricing: () => navigate("/pricing"),
  };
}
