// PeriodFilingReview — the warning chip on a period row, and the one-tap
// review behind it.
//
// WHAT THE CHIP MEANS, AND WHAT IT REFUSES TO MEAN
// ------------------------------------------------
// It renders straight off the detection record `stage_persist` wrote when
// the period was last analysed. Two distinct states, never merged:
//
//   DATE DISPUTED  the engine resolved a real month from the document's
//                  own evidence and it is NOT the month the period is
//                  filed under. `period_detection.mismatch`, read — never
//                  recomputed here. A UI verdict could disagree with the
//                  row it describes while looking authoritative.
//
//   DATE UNKNOWN   nothing in the document said which month it covers, so
//                  it was filed under the upload day (`fallback_today`).
//                  There is no disagreement to show — there is an absence
//                  to resolve, and only a person can resolve it.
//
// A period with NO record renders NOTHING. Periods written before the
// stamp shipped have none, and "no record" is not "no problem": showing a
// reassuring green state for them would be inventing a verdict.
//
// The review never edits anything by itself. It lays the two claims side
// by side with the literal evidence behind them and offers the move; the
// other button is "Keep it here", which changes nothing at all. Wrong
// rows are surfaced for a human to correct, never silently rewritten.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, HelpCircle, Loader2, MoveRight } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { useActiveLocale } from "@/lib/locale";
import { formatPeriodMonth, formatPeriodMonthLoose } from "@/lib/orgPeriods";
import {
  detectedPeriodEnd,
  isMismatch,
  moveDocumentToPeriod,
  needsAttention,
  type PeriodFilingFacts,
} from "./periodFiling";
import "./periodFilingI18n";

function monthLabel(iso: string | null | undefined, locale: string): string | null {
  if (!iso) return null;
  return (
    formatPeriodMonth(iso, locale) ?? formatPeriodMonthLoose(iso, locale) ?? iso
  );
}

/** The chip itself — inline in the period row's header line. Renders
 *  nothing at all when the engine recorded no complaint. */
export function PeriodFilingChip({
  facts,
  onReview,
}: {
  facts: PeriodFilingFacts | undefined;
  onReview: () => void;
}) {
  const { t } = useTranslation();
  if (!needsAttention(facts)) return null;
  const disputed = isMismatch(facts);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onReview();
      }}
      title={t(disputed ? "pf.mismatchChipTitle" : "pf.unknownChipTitle")}
      data-testid={`pf-chip-${facts?.period_id}`}
      data-state={disputed ? "mismatch" : "unknown"}
      className="shrink-0 inline-flex items-center gap-1 rounded-full bg-caution-tint text-caution px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-[0.06em] hover:brightness-110 transition-[filter] duration-micro"
    >
      {disputed ? (
        <AlertTriangle size={9} strokeWidth={2.5} />
      ) : (
        <HelpCircle size={9} strokeWidth={2.5} />
      )}
      {t(disputed ? "pf.mismatchChip" : "pf.unknownChip")}
      <span className="font-medium normal-case tracking-normal opacity-80">
        · {t("pf.openReview")}
      </span>
    </button>
  );
}

export interface ReviewTarget {
  facts: PeriodFilingFacts;
  /** The file the record describes — the period's analysis source. */
  documentId: string;
  documentName: string;
}

export function PeriodFilingReviewDialog({
  orgId,
  target,
  onClose,
  onMoved,
  onChooseMonth,
}: {
  orgId: string;
  target: ReviewTarget | null;
  onClose: () => void;
  onMoved: () => void;
  /** Hand the user to the month picker. Required, not optional: without
   *  it the "date unknown" review is a dead end — it tells the reader to
   *  pick the month it really covers and then offers no way to pick
   *  (r1 defect 2). */
  onChooseMonth: (target: ReviewTarget) => void;
}) {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const [busy, setBusy] = useState(false);

  if (!target) return null;

  const detection = target.facts.period_detection;
  const disputed = isMismatch(target.facts);
  const filedAs = monthLabel(target.facts.period_end, locale);
  const detectedIso = detectedPeriodEnd(target.facts);
  const detectedLabel = monthLabel(detectedIso, locale);
  const signalLabel = (signal: string | undefined) =>
    signal ? t(`pf.signal.${signal}`, { defaultValue: signal }) : null;

  const otherCandidates = (detection?.detected?.candidates ?? []).filter(
    (c) => c.period_end !== detectedIso,
  );

  async function moveToDetected() {
    if (!detectedIso) return;
    setBusy(true);
    try {
      const res = await moveDocumentToPeriod(
        orgId,
        target.documentId,
        detectedIso.slice(0, 7),
      );
      if (res.orphaned_after && res.orphaned_after.length > 0) {
        toast.warning(t("pf.leftBehind"));
      }
      toast.success(
        t("pf.moveDone", {
          file: target.documentName,
          month: detectedLabel ?? detectedIso,
        }),
      );
      onMoved();
      onClose();
    } catch (err) {
      toast.error(t("pf.moveFailed"), {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[480px]" data-testid="pf-review-dialog">
        <DialogHeader>
          <DialogTitle>{t("pf.reviewTitle")}</DialogTitle>
          <DialogDescription>
            {t(disputed ? "pf.reviewMismatchBody" : "pf.reviewUnknownBody")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2.5">
          <p className="truncate text-[12.5px] font-medium text-ink" title={target.documentName}>
            {target.documentName}
          </p>

          <dl className="rounded-lg border border-rule divide-y divide-rule/60 overflow-hidden text-[12.5px]">
            <div className="flex items-baseline gap-3 px-3 py-2">
              <dt className="w-[92px] shrink-0 text-[11px] uppercase tracking-[0.08em] text-ink-mute">
                {t("pf.filedAs")}
              </dt>
              <dd
                className="font-medium tabular-nums text-ink"
                data-testid="pf-review-filed-as"
              >
                {filedAs ?? "—"}
              </dd>
            </div>
            <div className="flex items-baseline gap-3 px-3 py-2">
              <dt className="w-[92px] shrink-0 text-[11px] uppercase tracking-[0.08em] text-ink-mute">
                {t("pf.fileSays")}
              </dt>
              <dd className="min-w-0" data-testid="pf-review-file-says">
                <span className="font-medium tabular-nums text-ink">
                  {detectedLabel ?? "—"}
                </span>
                {signalLabel(detection?.detected?.signal_used) && (
                  <span className="ml-1.5 text-[11.5px] text-ink-mute">
                    ({signalLabel(detection?.detected?.signal_used)})
                  </span>
                )}
              </dd>
            </div>
            {detection?.detected?.evidence_snippet && (
              <div className="flex items-baseline gap-3 px-3 py-2">
                <dt className="w-[92px] shrink-0 text-[11px] uppercase tracking-[0.08em] text-ink-mute">
                  {t("pf.evidence")}
                </dt>
                <dd className="min-w-0 break-words text-[11.5px] text-ink-soft">
                  “{detection.detected.evidence_snippet}”
                </dd>
              </div>
            )}
            {otherCandidates.length > 0 && (
              <div className="flex items-baseline gap-3 px-3 py-2">
                <dt className="w-[92px] shrink-0 text-[11px] uppercase tracking-[0.08em] text-ink-mute">
                  {t("pf.alsoSeen")}
                </dt>
                <dd className="min-w-0 text-[11.5px] text-ink-soft">
                  {otherCandidates.map((c) => (
                    <div key={`${c.signal}-${c.period_end}`} className="truncate">
                      <span className="tabular-nums">
                        {monthLabel(c.period_end, locale)}
                      </span>{" "}
                      <span className="text-ink-mute">
                        ({signalLabel(c.signal)})
                      </span>
                    </div>
                  ))}
                </dd>
              </div>
            )}
          </dl>

          {detection?.signal_used === "user_confirmed" && (
            <p className="text-[11.5px] text-ink-mute">
              {/* Names the month rather than saying "this month" (r1
                  defect 4): in a dialog whose whole job is telling two
                  months apart, a demonstrative points at the wrong one. */}
              {t("pf.confirmedByPerson", { month: filedAs ?? "—" })}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              toast.info(t("pf.keepHereDone"));
              onClose();
            }}
            data-testid="pf-review-keep"
            className="shrink-0 whitespace-nowrap inline-flex items-center h-8 px-3.5 rounded-sm border border-rule text-[12.5px] font-medium text-ink hover:bg-bg-2 disabled:opacity-50 transition-colors duration-micro"
          >
            {t("pf.keepHere")}
          </button>
          {/* There is ALWAYS a way to pick a month. When the engine named
              one it is the primary action and this is the alternative;
              when it named none this IS the action. */}
          <button
            type="button"
            disabled={busy}
            onClick={() => onChooseMonth(target)}
            data-testid="pf-review-choose"
            className={
              detectedIso
                ? "shrink-0 whitespace-nowrap inline-flex items-center h-8 px-3.5 rounded-sm border border-rule text-[12.5px] font-medium text-ink hover:bg-bg-2 disabled:opacity-50 transition-colors duration-micro"
                : "shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-8 px-4 rounded-sm bg-brand text-paper text-[12.5px] font-medium hover:bg-brand-dark disabled:opacity-40 transition-colors duration-micro"
            }
          >
            {t(detectedIso ? "pf.chooseAnotherMonth" : "pf.chooseMonth")}
          </button>
          {detectedIso && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void moveToDetected()}
              data-testid="pf-review-move"
              className="shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-8 px-4 rounded-sm bg-brand text-paper text-[12.5px] font-medium hover:bg-brand-dark disabled:opacity-40 transition-colors duration-micro"
            >
              {busy ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <MoveRight size={14} strokeWidth={1.75} />
              )}
              {t("pf.moveToDetected", { month: detectedLabel ?? detectedIso })}
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
