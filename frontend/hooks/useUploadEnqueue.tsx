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

import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";

import { ExtraDocConfirmDialog } from "@/components/cfo/pricing/ExtraDocConfirmDialog";
import { NonRoUpgradeDialog } from "@/components/cfo/pricing/NonRoUpgradeDialog";
import { useToast } from "@/hooks/use-toast";
import { enqueuePipeline, type EnqueuePipelineResult } from "@/lib/supabase";

/** What the caller actually sees after `await upload.enqueue(docId)`. */
export type UploadOutcome =
  | { kind: "queued" }
  | { kind: "extra_doc_cancelled" }    // user dismissed the dialog
  | { kind: "quota_blocked"; message: string; upgradeUrl: string }
  // 2026-08 — non-RO document on a plan without the Multi-Country
  // entitlement. The hook shows NonRoUpgradeDialog itself; this outcome
  // just tells the caller the upload did not queue.
  | { kind: "non_ro_blocked"; message: string }
  | { kind: "transport_failed"; message: string };

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
  const navigate = useNavigate();
  const [pending, setPending] = useState<PendingExtra | null>(null);
  const [pendingNonRo, setPendingNonRo] = useState<PendingNonRo | null>(null);

  /** Enqueue a pipeline run for `documentId`. Returns once the flow
   *  has reached a terminal state (queued, cancelled, blocked, failed). */
  const enqueue = useCallback(
    async (documentId: string): Promise<UploadOutcome> => {
      const first = await enqueuePipeline(documentId);
      return _resolveEnqueueOutcome(first, documentId);
    },
    [],
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
        setPending({
          documentId,
          planKey: result.planKey,
          docsUsed: result.docsUsed,
          docsIncluded: result.docsIncluded,
          extraDocEur: result.extraDocEur,
          serverMessage: result.message,
          resolve,
        });
      });
    },
    [toast],
  );

  // ── Dialog handlers ─────────────────────────────────────────
  const handleClose = useCallback(() => {
    if (!pending) return;
    pending.resolve({ kind: "extra_doc_cancelled" });
    setPending(null);
  }, [pending]);

  const handleConfirmed = useCallback(async () => {
    if (!pending) return;
    const docId = pending.documentId;
    const settle = pending.resolve;
    setPending(null);
    // After confirm, retry the enqueue. The server now sees the
    // reserved extra slot and should return 202.
    const retry = await enqueuePipeline(docId);
    settle(await _resolveEnqueueOutcome(retry, docId));
  }, [pending, _resolveEnqueueOutcome]);

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
    /** Pretty-named convenience for callers that prefer to navigate
     *  to /pricing themselves on quota-blocked. */
    goToPricing: () => navigate("/pricing"),
  };
}
