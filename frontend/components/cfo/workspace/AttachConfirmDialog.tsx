// AttachConfirmDialog — the one confirm step between a file and a period.
//
// WHY IT EXISTS
// ─────────────
// `documents.period_end_hint` is a CONFIRMATION channel: the engine's
// `stage_persist` ranks it ABOVE its own (correct) detection because the
// hint is supposed to mean "a human confirmed that THIS document belongs
// to THIS month". The workspace filled it with the DROP TARGET's date:
//
//     uploadDocument(file, { periodEndHint: p.period_end })   // ← the row
//
// Nothing in that number came off the document, so the engine dutifully
// discarded a correct reading and filed "Carniprod Trial Balance 2025"
// under 2017-12. The 2026-08-30 production audit found every mismatched
// row carrying `hint == stored` — the signature of exactly this.
//
// This dialog is the confirmation that channel was always supposed to
// carry. Nothing it returns comes from the UI: the month is pre-filled
// from the DOCUMENT and from nothing else, and the caller may write a
// hint only from what a human confirmed here.
//
// THE RULES IT ENFORCES
//   1. PRE-FILL FROM EVIDENCE ONLY. The drop target, the open period and
//      the month the user was typing in the add dialog are shown as
//      labelled one-click choices — never as the default.
//   2. ABSENT != ZERO. "Not detected" empties the field and disables the
//      confirm until a human picks. Never today, never the open period.
//   3. ALWAYS SAY WHY. The evidence line names the signal and quotes the
//      text it was read from, so the user can judge the proposal.
//   4. DISAGREEMENT IS ALLOWED, NEVER SILENT. Choosing a month the
//      document contradicts requires an explicit acknowledgement, and so
//      does dropping a second company into one month — where the primary
//      way out is a new period, not the acknowledgement.
//
// The dialog decides nothing about storage. It returns a confirmed
// result; PeriodsSection performs the create / upload / enqueue.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CalendarDays, FileSpreadsheet, Loader2, Search } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDateTime, useActiveLocale } from "@/lib/locale";
import { isImplausiblePeriod, type OrgPeriod, type OrgPeriodDocument } from "@/lib/orgPeriods";
import {
  ABSENT_DETECTION,
  ABSENT_ENTITY,
  entitiesConflict,
  inspectDocument,
  resolvePeriodEntity as resolvePeriodEntityDefault,
  type DocumentInspection,
  type EntityIdentity,
  type PeriodDetection,
} from "@/lib/periodDetect";
import "./attachConfirmI18n";

// ─── contract ────────────────────────────────────────────────────────────

export type AttachMode = "attach" | "replace";

/** The row/month the user acted on. CONTEXT ONLY — it is rendered as a
 *  labelled choice and never pre-fills the month. */
export interface AttachContext {
  periodId: string | null;
  periodEnd: string | null;
  reason: "dropped" | "chosen" | "replacing";
}

export interface AttachConfirmResult {
  /** ISO date the HUMAN confirmed for THIS document. The only value the
   *  caller may pass as `periodEndHint`. */
  periodEnd: string;
  /** Existing period it lands in, or null → create one for `periodEnd`. */
  periodId: string | null;
  /** What the document itself said, kept for the toast / the record. */
  detection: PeriodDetection;
  /** True when the confirmed month contradicts the document. */
  overrodeDetection: boolean;
}

export interface AttachConfirmDialogProps {
  open: boolean;
  mode: AttachMode;
  file: File | null;
  periods: OrgPeriod[];
  context: AttachContext | null;
  /** Replace mode: the document being replaced. */
  replacing: OrgPeriodDocument | null;
  onConfirm: (result: AttachConfirmResult) => void;
  onCancel: () => void;
  /** Seams. Defaults are the real ones; tests and offline paths swap them.
   *  `inspect` takes the FILE and nothing else — that signature is this
   *  component's half of W1 (UI state cannot reach the decision). */
  inspect?: (file: File) => Promise<DocumentInspection>;
  resolvePeriodEntity?: (periodId: string) => Promise<EntityIdentity | null>;
}

// ─── helpers ─────────────────────────────────────────────────────────────

/** Trial-balance convention: a period's date is the LAST day of its month. */
function lastDayIso(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return `${monthKey}-${String(last).padStart(2, "0")}`;
}

/** "December 2025" — the LONG month, deliberately. This dialog exists
 *  because "Dec 2025" and "Dec 2017" scan alike at a glance. Accepts
 *  "YYYY-MM" or a full ISO date; UTC-pinned so a date-only string never
 *  slips a month west of Greenwich. */
function longMonth(value: string | null | undefined, locale: string): string {
  if (!value) return "";
  const iso = /^\d{4}-\d{2}$/.test(value) ? `${value}-15` : value;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "UTC" });
}

const monthKeyOf = (p: OrgPeriod) => (p.period_end ?? "").slice(0, 7);

// ─── component ───────────────────────────────────────────────────────────

export function AttachConfirmDialog({
  open,
  mode,
  file,
  periods,
  context,
  replacing,
  onConfirm,
  onCancel,
  inspect = inspectDocument,
  resolvePeriodEntity = resolvePeriodEntityDefault,
}: AttachConfirmDialogProps) {
  const { t } = useTranslation();
  const locale = useActiveLocale();

  const [inspection, setInspection] = useState<DocumentInspection | null>(null);
  const [reading, setReading] = useState(true);
  const [month, setMonth] = useState("");
  const [ack, setAck] = useState(false);
  const [existingEntity, setExistingEntity] = useState<EntityIdentity | null>(null);

  const maxYear = new Date().getFullYear() + 1;
  const minMonth = "2000-01";
  const maxMonth = `${maxYear}-12`;

  // ── read the document, then pre-fill from what IT says ─────────────────
  useEffect(() => {
    if (!open || !file) return;
    let cancelled = false;
    setReading(true);
    setInspection(null);
    setMonth("");
    setAck(false);
    setExistingEntity(null);
    (async () => {
      let result: DocumentInspection;
      try {
        result = await inspect(file);
      } catch {
        // An unreadable file is ABSENT, not a reason to guess.
        result = { detection: ABSENT_DETECTION, entity: { ...ABSENT_ENTITY } };
      }
      if (cancelled) return;
      setInspection(result);
      // THE ONLY PRE-FILL IN THIS COMPONENT. No drop target, no open
      // period, no today.
      setMonth(result.detection.proposedPeriodEnd?.slice(0, 7) ?? "");
      setReading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, file, inspect]);

  const detection = inspection?.detection ?? null;
  const detectedMonth = detection?.proposedPeriodEnd
    ? detection.proposedPeriodEnd.slice(0, 7)
    : null;

  const monthValid =
    /^\d{4}-\d{2}$/.test(month) && month >= minMonth && month <= maxMonth;

  const selectable = useMemo(
    () =>
      periods
        .filter((p) => !!p.period_end && !isImplausiblePeriod(p.period_end))
        .slice()
        .sort((a, b) => (b.period_end ?? "").localeCompare(a.period_end ?? "")),
    [periods],
  );

  // The period the confirmed month lands in. When several share the month
  // (the workspace allows that), the one the user acted on wins.
  const chosenPeriod = useMemo(() => {
    if (!monthValid) return null;
    const sameMonth = selectable.filter((p) => monthKeyOf(p) === month);
    return (
      sameMonth.find((p) => p.period_id === context?.periodId) ?? sameMonth[0] ?? null
    );
  }, [selectable, month, monthValid, context?.periodId]);

  // An existing period keeps its own period_end (attaching must not mint a
  // sibling row one day apart); a new month uses the last-day convention.
  const resolvedEnd = chosenPeriod?.period_end ?? (monthValid ? lastDayIso(month) : null);

  // ── who the target month already belongs to ───────────────────────────
  useEffect(() => {
    const pid = chosenPeriod?.period_id ?? null;
    if (!open || !pid) {
      setExistingEntity(null);
      return;
    }
    let cancelled = false;
    (async () => {
      let entity: EntityIdentity | null = null;
      try {
        entity = await resolvePeriodEntity(pid);
      } catch {
        entity = null; // ABSENT — the guard stays quiet rather than guessing.
      }
      if (!cancelled) setExistingEntity(entity);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, chosenPeriod?.period_id, resolvePeriodEntity]);

  // A fresh disagreement is never pre-acknowledged.
  useEffect(() => {
    setAck(false);
  }, [month]);

  const mismatch = !!detectedMonth && monthValid && month !== detectedMonth;
  const entityConflict =
    !!chosenPeriod && entitiesConflict(inspection?.entity ?? null, existingEntity);
  const needsAck = mismatch || entityConflict;

  const canSubmit = !reading && !!resolvedEnd && monthValid && (!needsAck || ack);
  const canCreateNew = !reading && monthValid && (!mismatch || ack);

  function confirm(target: "chosen" | "new") {
    const periodEnd =
      target === "new" ? (monthValid ? lastDayIso(month) : null) : resolvedEnd;
    if (!periodEnd) return;
    onConfirm({
      periodEnd,
      periodId: target === "new" ? null : chosenPeriod?.period_id ?? null,
      detection: detection ?? ABSENT_DETECTION,
      overrodeDetection: mismatch,
    });
  }

  // ── evidence copy ─────────────────────────────────────────────────────
  const signal = detection?.signalUsed ?? "none";
  const evidenceText = t(`attachConfirm.evidence.${signal}`, {
    month: longMonth(detectedMonth, locale),
  });
  // Part B hands back every tier that resolved — show the disagreement,
  // not just the winner, when a lower-ranked signal says another month.
  const disagreeingCandidate = (detection?.candidates ?? []).find(
    (c) => c.periodEnd.slice(0, 7) !== (detectedMonth ?? ""),
  );

  const incomingName = inspection?.entity.name ?? null;
  const existingName = existingEntity?.name ?? null;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="sm:max-w-[520px]" data-testid="attach-confirm-dialog">
        <DialogHeader>
          <DialogTitle>{t(`attachConfirm.title.${mode}`)}</DialogTitle>
          <DialogDescription>{t("attachConfirm.desc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* The file itself */}
          {file && (
            <div className="flex items-center gap-2 min-w-0 rounded-lg border border-rule bg-bg-2/30 px-3 py-2">
              <FileSpreadsheet size={14} strokeWidth={1.5} className="shrink-0 text-ink-mute" />
              <span className="truncate text-[12.5px] font-medium text-ink" title={file.name}>
                {file.name}
              </span>
            </div>
          )}

          {/* What is being replaced — filename, period, upload date. */}
          {mode === "replace" && replacing && (
            <div
              data-testid="attach-confirm-replacing"
              className="rounded-lg border border-rule bg-bg-2/30 px-3 py-2"
            >
              <div className="text-[10.5px] uppercase tracking-[0.1em] font-semibold text-ink-mute">
                {t("attachConfirm.replacing.title")}
              </div>
              <div className="mt-1 flex items-center gap-1.5 min-w-0">
                <FileSpreadsheet size={12} strokeWidth={1.5} className="shrink-0 text-ink-mute" />
                <span className="truncate text-[12.5px] text-ink" title={replacing.filename ?? undefined}>
                  {replacing.filename ?? replacing.id}
                </span>
              </div>
              <div className="mt-0.5 text-[11px] text-ink-mute tabular-nums">
                {t("attachConfirm.replacing.meta", {
                  month: longMonth(context?.periodEnd ?? null, locale),
                  date: formatDateTime(replacing.uploaded_at, { dateStyle: "medium" }),
                })}
              </div>
              <p className="mt-1 text-[11px] text-ink-mute leading-relaxed">
                {t("attachConfirm.replacing.note")}
              </p>
            </div>
          )}

          {/* WHY — the evidence line. Rendered only once the document has
              actually been read, so it never claims a verdict it doesn't
              have yet. */}
          {reading ? (
            <div
              data-testid="attach-confirm-reading"
              className="flex items-center gap-2 text-[12px] text-ink-mute"
            >
              <Loader2 size={14} className="animate-spin" />
              {t("attachConfirm.reading")}
            </div>
          ) : (
            <div className="space-y-1">
              {/* r2: this sentence is the entire justification for the
                  pre-filled month, so it carries body weight — at caption
                  weight it read as a footnote under the filename. */}
              <div
                data-testid="attach-confirm-evidence"
                className={`flex items-start gap-2 text-[12.5px] ${
                  detectedMonth ? "text-ink" : "text-caution"
                }`}
              >
                <Search size={14} strokeWidth={1.75} className="shrink-0 mt-px text-ink-mute" />
                <span>{evidenceText}</span>
              </div>
              {detection?.evidenceSnippet && (
                <p className="pl-[22px] text-[11px] text-ink-mute truncate" title={detection.evidenceSnippet}>
                  {detection.evidenceSnippet}
                </p>
              )}
              {disagreeingCandidate && (
                <p className="pl-[22px] text-[11px] text-ink-mute">
                  {t("attachConfirm.evidence.disagree", {
                    month: longMonth(disagreeingCandidate.periodEnd, locale),
                  })}
                </p>
              )}
              {detection?.origin === "browser" && (
                <p className="pl-[22px] text-[11px] text-ink-mute">
                  {t("attachConfirm.evidence.browser")}
                </p>
              )}
            </div>
          )}

          {/* The picker — always visible. */}
          <div>
            <label
              htmlFor="attach-confirm-month-input"
              className="block text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-mute mb-1.5"
            >
              {t("attachConfirm.monthLabel")}
            </label>
            <input
              id="attach-confirm-month-input"
              type="month"
              value={month}
              min={minMonth}
              max={maxMonth}
              onChange={(e) => setMonth(e.target.value)}
              data-testid="attach-confirm-month"
              // r2: while the document told us nothing and nothing has been
              // chosen, the empty native month field reads as broken rather
              // than as required — carry the same caution colour as the line
              // that just asked for it.
              className={`w-full h-8 px-3 rounded-sm border bg-surface text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand/50 ${
                !reading && !detectedMonth && !monthValid
                  ? "border-caution/60"
                  : "border-rule"
              }`}
            />
            {!monthValid && month !== "" && (
              <p className="mt-1.5 text-[11.5px] text-caution">
                {t("attachConfirm.monthRange", { year: maxYear })}
              </p>
            )}
            {monthValid && !chosenPeriod && (
              <p
                data-testid="attach-confirm-new-period-note"
                className="mt-1.5 text-[11.5px] text-ink-mute"
              >
                {t("attachConfirm.newPeriod", { month: longMonth(month, locale) })}
              </p>
            )}
          </div>

          {/* Existing periods — including the one the user acted on, as a
              LABELLED choice rather than a silent default. */}
          {selectable.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-mute mb-1.5">
                {t("attachConfirm.existing")}
              </div>
              <div className="max-h-[168px] overflow-y-auto rounded-lg border border-rule divide-y divide-rule/60">
                {selectable.map((p) => {
                  const key = monthKeyOf(p);
                  const selected = key === month;
                  const tag =
                    context?.periodId === p.period_id ? context.reason : null;
                  return (
                    <button
                      key={p.period_id}
                      type="button"
                      onClick={() => setMonth(key)}
                      data-testid={`attach-confirm-period-${p.period_id}`}
                      aria-pressed={selected}
                      // r2: the left accent rule (the workspace nav's own
                      // idiom) makes the list read as a shortcut INTO the
                      // month field above, not as a second control.
                      className={`w-full flex items-center gap-2 border-l-2 px-3 py-2 text-left transition-colors ${
                        selected
                          ? "border-brand bg-brand/[0.07]"
                          : "border-transparent hover:bg-bg-2/50"
                      }`}
                    >
                      <CalendarDays
                        size={13}
                        strokeWidth={1.5}
                        className={`shrink-0 ${selected ? "text-brand-d" : "text-ink-mute"}`}
                      />
                      <span className="text-[12.5px] text-ink tabular-nums">
                        {longMonth(p.period_end, locale)}
                      </span>
                      <span className="text-[11px] text-ink-mute">
                        {(p.documents ?? []).length > 0
                          ? (p.documents ?? [])[0]?.filename ?? ""
                          : ""}
                      </span>
                      {tag && (
                        <span className="ml-auto shrink-0 text-[10px] uppercase tracking-[0.06em] text-ink-mute">
                          {t(`attachConfirm.tag.${tag}`)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* GUARD 1 — the file's month and the chosen month disagree. */}
          {mismatch && (
            <div
              data-testid="attach-confirm-mismatch"
              className="rounded-lg border border-caution/30 bg-caution-tint px-3 py-2.5"
            >
              <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-caution">
                <AlertTriangle size={14} strokeWidth={1.75} />
                {t("attachConfirm.mismatch.title", {
                  detected: longMonth(detectedMonth, locale),
                })}
              </div>
              <p className="mt-1 text-[11.5px] text-ink-soft leading-relaxed">
                {t("attachConfirm.mismatch.body", { chosen: longMonth(month, locale) })}
              </p>
            </div>
          )}

          {/* GUARD 2 — a second company in one month. The primary way out
              is a NEW period, not an acknowledgement. */}
          {entityConflict && (
            <div
              data-testid="attach-confirm-entity"
              className="rounded-lg border border-alert/30 bg-alert-tint px-3 py-2.5"
            >
              <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-alert">
                <AlertTriangle size={14} strokeWidth={1.75} />
                {t("attachConfirm.entity.title")}
              </div>
              <p className="mt-1 text-[11.5px] text-ink-soft leading-relaxed">
                {incomingName
                  ? t("attachConfirm.entity.body", {
                      incoming: incomingName,
                      existing: existingName,
                      month: longMonth(month, locale),
                    })
                  : t("attachConfirm.entity.bodyUnknownIncoming", {
                      existing: existingName,
                      month: longMonth(month, locale),
                    })}
              </p>
              <button
                type="button"
                onClick={() => confirm("new")}
                disabled={!canCreateNew}
                data-testid="attach-confirm-new-period"
                className="mt-2 inline-flex items-center h-8 px-3.5 rounded-sm bg-brand text-paper text-[12.5px] font-medium hover:bg-brand-dark disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-micro"
              >
                {t("attachConfirm.entity.newPeriodCta")}
              </button>
            </div>
          )}

          {/* The explicit acknowledgement. One checkbox covers whichever
              guard is up; it is reset whenever the month changes. */}
          {needsAck && (
            <label className="flex items-start gap-2 text-[12px] text-ink-soft cursor-pointer">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
                data-testid="attach-confirm-override"
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-brand"
              />
              <span>
                {mismatch
                  ? t("attachConfirm.mismatch.ack", { chosen: longMonth(month, locale) })
                  : t("attachConfirm.entity.ack", { month: longMonth(month, locale) })}
              </span>
            </label>
          )}
        </div>

        <DialogFooter className="gap-2">
          <button
            type="button"
            onClick={onCancel}
            data-testid="attach-confirm-cancel"
            className="inline-flex items-center h-8 px-3.5 rounded-sm border border-rule text-[12.5px] font-medium text-ink hover:bg-bg-2 transition-colors duration-micro"
          >
            {t("attachConfirm.cancel")}
          </button>
          {/* r2: when the entity guard is up, "Attach to a new period" is the
              recommended action. This one steps down to secondary so the two
              don't read as equals the moment the acknowledgement is ticked. */}
          <button
            type="button"
            onClick={() => confirm("chosen")}
            disabled={!canSubmit}
            data-testid="attach-confirm-submit"
            className={`inline-flex items-center gap-1.5 h-8 px-4 rounded-sm text-[12.5px] font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-micro ${
              entityConflict
                ? "border border-rule text-ink hover:bg-bg-2"
                : "bg-brand text-paper hover:bg-brand-dark"
            }`}
          >
            {reading && <Loader2 size={14} className="animate-spin" />}
            {t(`attachConfirm.confirm.${mode}`)}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
