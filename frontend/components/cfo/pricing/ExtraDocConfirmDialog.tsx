// ExtraDocConfirmDialog.tsx — modal for the gap-D "this is an extra
// document — confirm to be charged" flow.
//
// FLOW
// ────
// 1. User uploads a document. The FE calls `enqueuePipeline(docId)`.
// 2. If the backend returns HTTP 402 with code `extra_doc_confirmation_required`,
//    the caller renders THIS dialog with the price + current usage.
// 3. User clicks "Confirm and analyse" → FE calls
//    `POST /api/plan/confirm-extra-doc` → on 200, FE retries
//    `enqueuePipeline(docId)` → should now return `kind: "queued"`.
// 4. Pipeline runs. If it SUCCEEDS, the orchestrator's
//    `commit_user_upload(was_extra=True)` charges the extra and
//    consumes the slot. If it FAILS, `release_user_upload(was_extra=True)`
//    drops the reservation — NO CHARGE, NO QUOTA CONSUMED (gap D).
//
// COPY RULES (May 2026 redesign spec §12)
// ───────────────────────────────────────
// · Title: "Extra document analysis"
// · Body (verbatim):
//     "You have used 5 / 5 documents this month. This extra analysis
//      costs €3.00."
//   The {used} / {included} is rendered with a literal slash. The
//   plan name + reset date are surfaced as secondary lines, not in
//   the headline sentence.
// · Buttons: "Cancel" / "Confirm and analyze"  (American spelling per
//   the spec — was previously British "analyse").
// · Gap D note: surface that a failed analysis is NOT charged.
//
// VISUAL — uses the existing shadcn-style dialog primitives so it
// matches every other modal in the app (no new style language).

import { useState } from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { confirmExtraDoc, PlanApiError } from "@/lib/planState";
import { useToast } from "@/hooks/use-toast";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after a successful confirm + reservation. Caller must then
   *  retry the original upload action (e.g., `enqueuePipeline(docId)`). */
  onConfirmed: () => void;

  /** Display fields — sourced from the 402 response body. */
  planKey: string;
  docsUsed: number;
  docsIncluded: number;
  extraDocEur: number | null;
  /** Optional server-supplied message — falls back to a sensible default. */
  serverMessage?: string;
  /** Optional ISO date for "resets on" copy. Not required. */
  resetDateIso?: string;
}

export function ExtraDocConfirmDialog({
  open,
  onClose,
  onConfirmed,
  planKey,
  docsUsed,
  docsIncluded,
  extraDocEur,
  serverMessage,
  resetDateIso,
}: Props) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eurLabel =
    extraDocEur !== null && extraDocEur !== undefined
      ? `€${extraDocEur.toFixed(2)}`
      : "the per-document extra rate";

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    try {
      await confirmExtraDoc();
      toast({
        title: "Extra document confirmed",
        description: `${eurLabel} will be charged only after the analysis completes successfully.`,
      });
      onConfirmed();
      onClose();
    } catch (e) {
      const msg =
        e instanceof PlanApiError
          ? typeof e.detail === "object" && e.detail !== null
            ? (e.detail as { message?: string }).message ??
              `Couldn't confirm extra (HTTP ${e.status}).`
            : `Couldn't confirm extra (HTTP ${e.status}).`
          : "Network error.";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return; // don't let users dismiss mid-request
        if (!next) onClose();
      }}
    >
      <DialogContent
        data-testid="extra-doc-confirm-dialog"
        className="max-w-[440px]"
      >
        <DialogHeader>
          <DialogTitle className="text-[18px] font-serif text-ink">
            Extra document analysis
          </DialogTitle>
          <DialogDescription className="text-[13px] text-ink-soft leading-relaxed pt-1">
            You have used{" "}
            <strong className="text-ink font-semibold">
              {docsUsed} / {docsIncluded}
            </strong>{" "}
            documents this month. This extra analysis costs{" "}
            <strong className="text-ink font-semibold">{eurLabel}</strong>.
          </DialogDescription>
        </DialogHeader>

        {/* Secondary line — plan + (optional) reset date. Kept out of
            the headline sentence so the spec §12 phrasing reads
            cleanly. */}
        <p
          data-testid="extra-doc-context"
          className="text-[12px] text-ink-mute leading-relaxed"
        >
          You're on the{" "}
          <span className="text-ink-soft capitalize font-medium">{planKey}</span>{" "}
          plan.
          {resetDateIso && (
            <>
              {" "}
              Your monthly allowance resets on{" "}
              {new Date(resetDateIso).toLocaleDateString("en-GB", {
                dateStyle: "medium",
              })}
              .
            </>
          )}
        </p>

        {/* Gap D — explicit failure semantics. The user needs to know
            BEFORE confirming that a failed analysis isn't billed. */}
        <div className="rounded-md border border-rule bg-bg-2/60 px-3 py-2.5 text-[12px] text-ink-soft leading-relaxed flex items-start gap-2">
          <CheckCircle2
            size={14}
            strokeWidth={1.75}
            className="text-emerald-600 shrink-0 mt-0.5"
          />
          <span>
            You're only charged if the analysis completes successfully. If it
            fails (parse error, unsupported format), the extra is{" "}
            <strong className="text-ink font-semibold">not billed</strong> and
            doesn't count against your quota.
          </span>
        </div>

        {serverMessage && (
          <p
            data-testid="extra-doc-server-message"
            className="text-[12px] text-ink-mute leading-relaxed"
          >
            {serverMessage}
          </p>
        )}

        {error && (
          <div
            data-testid="extra-doc-confirm-error"
            className="rounded-md border border-amber-300/60 bg-amber-50/40 px-3 py-2 text-[12px] text-amber-800 inline-flex items-center gap-2"
          >
            <AlertCircle size={13} strokeWidth={1.75} />
            {error}
          </div>
        )}

        <DialogFooter className="gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            data-testid="extra-doc-cancel"
            className="h-9 px-3 rounded-md border border-rule bg-surface text-[13px] text-ink hover:bg-bg-2 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleConfirm()}
            data-testid="extra-doc-confirm"
            className="h-9 px-4 rounded-md bg-ink text-paper text-[13px] font-medium hover:bg-ink/90 transition-colors disabled:opacity-50 inline-flex items-center gap-2"
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            Confirm and analyze
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
