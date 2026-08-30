// MoveFileDialog — the correction path's one screen.
//
// The user is looking at ONE file and stating which month it covers. That
// statement is written to `documents.period_end_hint`, the channel that
// means "a human confirmed THIS document belongs to THIS month" — and it
// is the only place the frontend is allowed to write it. The bug this
// whole effort exists to end was the upload path filling that channel
// with the DROP TARGET's date, a number read off the screen instead of
// off the document.
//
// So this dialog is built to make the confirmation real:
//
//  · It asks the ENGINE what the file itself says (`/api/period/detect`,
//    stateless and hint-free) and shows the answer with its reason, so
//    the user is agreeing with evidence rather than guessing.
//  · When the file says nothing, NOTHING is pre-selected. ABSENT != ZERO:
//    an unknown month must produce an explicit choice, never a default,
//    and certainly never the period that happens to be open.
//  · The month goes to the engine as "YYYY-MM". Resolving it to the
//    month's last day is the engine's convention and stays there — one
//    authority for what a period end means.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Wand2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { formatPeriodMonth } from "@/lib/orgPeriods";
import { useActiveLocale } from "@/lib/locale";
import {
  detectPeriodForFilename,
  moveDocumentToPeriod,
  type DetectOutcome,
} from "./periodFiling";
import "./periodFilingI18n";

export interface MoveTarget {
  id: string;
  name: string;
  /** The month it sits in today, "YYYY-MM" — used only to refuse a
   *  no-op, never to pre-fill the picker. */
  currentMonth: string | null;
}

const MIN_MONTH = "2000-01";
const MAX_MONTH = "2035-12";

export function MoveFileDialog({
  orgId,
  target,
  onClose,
  onMoved,
}: {
  orgId: string;
  target: MoveTarget | null;
  onClose: () => void;
  onMoved: () => void;
}) {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const [month, setMonth] = useState("");
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [outcome, setOutcome] = useState<DetectOutcome | null>(null);

  const open = !!target;
  const fileId = target?.id ?? null;
  const fileName = target?.name ?? "";

  useEffect(() => {
    if (!open || !fileId) return;
    let live = true;
    setMonth("");
    setBusy(false);
    setOutcome(null);
    setDetecting(true);
    void detectPeriodForFilename(orgId, fileName).then((res) => {
      if (!live) return;
      setDetecting(false);
      setOutcome(res);
      // Pre-select ONLY a month the document itself pointed at. A blank
      // picker is the correct state for a file that says nothing — and
      // for a file we could not ask about.
      const proposed =
        res.kind === "answered" ? res.detection.proposed_period_end : null;
      if (proposed) setMonth(proposed.slice(0, 7));
    });
    return () => {
      live = false;
    };
  }, [open, fileId, fileName, orgId]);

  if (!target) return null;

  const monthValid =
    /^\d{4}-\d{2}$/.test(month) && month >= MIN_MONTH && month <= MAX_MONTH;
  const sameMonth = monthValid && month === target.currentMonth;
  const canSubmit = monthValid && !sameMonth && !busy;

  const monthLabel = (key: string) =>
    formatPeriodMonth(`${key}-15`, locale) ?? key;
  const signalLabel = (signal: string) =>
    t(`pf.signal.${signal}`, { defaultValue: signal });

  const detected = outcome?.kind === "answered" ? outcome.detection : null;
  const proposedMonth = detected?.proposed_period_end?.slice(0, 7) ?? null;
  // Three distinct states, never merged (r1 defect 3): the engine named a
  // month; the engine answered and the document was silent; we never got
  // an answer. Only the middle one may claim anything about the file.
  const unavailable = outcome?.kind === "unavailable";

  async function submit() {
    if (!canSubmit || !target) return;
    setBusy(true);
    try {
      const res = await moveDocumentToPeriod(orgId, target.id, month);
      if (res.orphaned_after && res.orphaned_after.length > 0) {
        // W4 reported a violation on its own work. Surfacing beats a
        // silent success — the user can reload and see what survived.
        toast.warning(t("pf.leftBehind"));
      }
      toast.success(
        t("pf.moveDone", { file: target.name, month: monthLabel(month) }),
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
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[460px]" data-testid="pf-move-dialog">
        <DialogHeader>
          <DialogTitle className="truncate">
            {t("pf.moveTitle", { file: target.name })}
          </DialogTitle>
          <DialogDescription>{t("pf.moveDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* What the FILE says — the evidence the confirmation is made
              against. Never a default that quietly becomes the answer. */}
          <div
            data-testid="pf-move-evidence"
            className="rounded-lg border border-rule bg-bg-2/40 px-3 py-2.5 text-[12px] leading-relaxed text-ink-soft"
          >
            {detecting ? (
              <span className="inline-flex items-center gap-1.5 text-ink-mute">
                <Loader2 size={12} className="animate-spin" />
                {t("pf.moveReading")}
              </span>
            ) : proposedMonth ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                <span>
                  {t("pf.moveFileSays", {
                    month: monthLabel(proposedMonth),
                    signal: signalLabel(detected?.signal_used ?? "none"),
                  })}
                </span>
                {month !== proposedMonth && (
                  <button
                    type="button"
                    onClick={() => setMonth(proposedMonth)}
                    data-testid="pf-move-use-detected"
                    className="inline-flex items-center gap-1 rounded-sm border border-rule px-2 py-0.5 text-[11.5px] font-medium text-ink hover:bg-bg-2 transition-colors duration-micro"
                  >
                    <Wand2 size={11} strokeWidth={1.75} />
                    {t("pf.moveUseDetected", { month: monthLabel(proposedMonth) })}
                  </button>
                )}
                {detected?.evidence_snippet && (
                  <span className="w-full truncate text-[11px] text-ink-mute">
                    {t("pf.evidence")}: “{detected.evidence_snippet}”
                  </span>
                )}
              </div>
            ) : unavailable ? (
              <span data-testid="pf-move-unavailable">
                {t("pf.moveCouldNotRead")}
              </span>
            ) : (
              <span data-testid="pf-move-no-signal">
                {t("pf.moveFileSaysNothing")}
              </span>
            )}
          </div>

          <div>
            <label
              htmlFor="pf-move-month"
              className="block text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-mute mb-1.5"
            >
              {t("pf.moveMonth")}
            </label>
            <input
              id="pf-move-month"
              type="month"
              value={month}
              min={MIN_MONTH}
              max={MAX_MONTH}
              onChange={(e) => setMonth(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) void submit();
              }}
              data-testid="pf-move-month"
              className="w-full h-8 px-3 rounded-sm border border-rule bg-surface text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand/50"
            />
            {!monthValid && month !== "" && (
              <p className="mt-1.5 text-[11.5px] text-caution">{t("pf.moveRange")}</p>
            )}
            {sameMonth && (
              <p className="mt-1.5 text-[11.5px] text-caution" data-testid="pf-move-same">
                {t("pf.moveSame")}
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex items-center h-8 px-3.5 rounded-sm border border-rule text-[12.5px] font-medium text-ink hover:bg-bg-2 disabled:opacity-50 transition-colors duration-micro"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            data-testid="pf-move-confirm"
            className="inline-flex items-center gap-1.5 h-8 px-4 rounded-sm bg-brand text-paper text-[12.5px] font-medium hover:bg-brand-dark disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-micro"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {busy ? t("pf.moveBusy") : t("pf.moveConfirm")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
