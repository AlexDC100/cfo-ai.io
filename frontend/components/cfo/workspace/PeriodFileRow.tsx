// PeriodFileRow — one attached file, with the two dates that are not the
// same fact, and the menu that lets a person correct the filing.
//
// PART E, THE HONEST DISPLAY
// --------------------------
// A file row carries TWO dates and the old UI showed one:
//
//   · UPLOADED — when this file arrived. A property of the account.
//   · FILE SAYS — the month the DOCUMENT itself covers, as the engine
//     recorded it at write time. A property of the document.
//
// Conflating them is how "Carniprod Trial Balance 2025.xlsx" sat under
// 2017-12 without anyone noticing: the row showed a plausible upload
// date and said nothing about the eight-year gap. When the engine
// recorded nothing about a file's own month, the row says exactly that —
// "File date not recorded" — instead of borrowing the period's date and
// presenting it as the file's. ABSENT != ZERO.
//
// SOURCE vs ATTACHMENT
// --------------------
// A period's numbers come from exactly ONE file: the engine's
// `financial_periods.source_document_id`, the same id it stamps into the
// envelope's provenance. Everything else attached is an attachment. The
// badge is read from that pointer, not from a most-recently-analyzed
// guess — the guess silently picked a winner on the audited period that
// held two different companies' files.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarClock, FileSpreadsheet, Loader2, MoreHorizontal, MoveRight, Star } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { formatDateOnly, useActiveLocale } from "@/lib/locale";
import { formatPeriodMonth, formatPeriodMonthLoose } from "@/lib/orgPeriods";
import { makeDocumentSource, type PeriodDetection } from "./periodFiling";
import "./periodFilingI18n";

export interface PeriodFile {
  id: string;
  filename?: string | null;
  status?: string | null;
  uploaded_at?: string | null;
}

export function PeriodFileRow({
  orgId,
  file,
  isSource,
  showRole,
  detection,
  onMove,
  onChanged,
}: {
  orgId: string;
  file: PeriodFile;
  /** True only when the ENGINE declares this file the analysis source. */
  isSource: boolean;
  /** Roles are only meaningful once a period holds more than one file. */
  showRole: boolean;
  /** The engine's persisted verdict, but ONLY when it describes THIS
   *  document. `null` for attachments and for legacy rows. */
  detection: PeriodDetection | null;
  onMove: (file: PeriodFile) => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const [busy, setBusy] = useState(false);

  const name = file.filename ?? file.id;
  const uploaded = file.uploaded_at
    ? formatDateOnly(file.uploaded_at, { dateStyle: "medium" })
    : null;

  // What the DOCUMENT said about itself, as recorded. Deliberately not
  // derived from the period it sits in — that is the number under
  // suspicion, and repeating it here would make every row self-consistent
  // and every mistake invisible.
  const documentDate = detection?.detected?.proposed_period_end ?? null;
  const documentLabel = documentDate
    ? formatPeriodMonth(documentDate, locale) ??
      formatPeriodMonthLoose(documentDate, locale) ??
      documentDate
    : null;

  async function makeSource() {
    setBusy(true);
    try {
      const res = await makeDocumentSource(orgId, file.id);
      if (!res.changed) {
        toast.info(t("pf.sourceAlready"));
      } else {
        if (res.orphaned_after && res.orphaned_after.length > 0) {
          toast.warning(t("pf.leftBehind"));
        }
        toast.success(t("pf.sourceDone", { file: name }));
        onChanged();
      }
    } catch (err) {
      toast.error(t("pf.sourceFailed"), {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid={`pf-file-${file.id}`}
      data-role={isSource ? "source" : "attachment"}
      className="group/file flex items-start gap-1.5 min-w-0 py-0.5"
    >
      <FileSpreadsheet
        size={12}
        strokeWidth={1.5}
        className="shrink-0 mt-[3px] text-ink-mute"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            title={name}
            className="truncate max-w-[34ch] text-[11.5px] text-ink-soft"
          >
            {name}
          </span>
          {showRole &&
            (isSource ? (
              <span
                title={t("pf.sourceTitle")}
                data-testid={`pf-file-source-${file.id}`}
                className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-brand/15 text-brand-d px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.08em]"
              >
                <Star size={8} strokeWidth={2.5} />
                {t("pf.source")}
              </span>
            ) : (
              <span
                title={t("pf.attachmentTitle")}
                data-testid={`pf-file-attachment-${file.id}`}
                className="shrink-0 inline-flex items-center rounded-full bg-bg-2/70 text-ink-mute px-1.5 py-px text-[9px] font-medium uppercase tracking-[0.08em]"
              >
                {t("pf.attachment")}
              </span>
            ))}
        </div>
        {/* Two facts, side by side and labelled, because they answer
            different questions. */}
        <div className="flex flex-wrap items-center gap-x-2 text-[10.5px] text-ink-mute">
          {uploaded && <span>{t("pf.uploaded", { date: uploaded })}</span>}
          {documentLabel ? (
            <span className="inline-flex items-center gap-1">
              <CalendarClock size={10} strokeWidth={1.75} />
              {t("pf.documentDate", { date: documentLabel })}
            </span>
          ) : (
            <span
              title={t("pf.documentDateUnknownTitle")}
              className="italic opacity-80"
            >
              {t("pf.documentDateUnknown")}
            </span>
          )}
        </div>
      </div>

      {busy ? (
        <Loader2 size={12} className="shrink-0 mt-[3px] animate-spin text-ink-mute" />
      ) : (
        /* ALWAYS VISIBLE (r1 defect 1). This menu is the only route to
           "Move to another period…", and it was hover-revealed — which
           means it did not exist on any touch device. A correction
           affordance for wrong data cannot be a hover-worthy detail; it
           recedes at low contrast instead of disappearing. */
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("pf.menuAria", { file: name })}
              data-testid={`pf-file-menu-${file.id}`}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              className="shrink-0 grid place-items-center h-5 w-5 rounded text-ink-mute/60 group-hover/file:text-ink-mute hover:!text-ink hover:bg-bg-2/70 transition-colors"
            >
              <MoreHorizontal size={13} strokeWidth={1.75} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-[210px]"
            onClick={(e) => e.stopPropagation()}
          >
            <DropdownMenuItem
              onSelect={() => onMove(file)}
              data-testid={`pf-file-move-${file.id}`}
              className="gap-2"
            >
              <MoveRight size={14} strokeWidth={1.75} />
              {t("pf.move")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={isSource}
              onSelect={() => void makeSource()}
              data-testid={`pf-file-makesource-${file.id}`}
              className="gap-2"
            >
              <Star size={14} strokeWidth={1.75} />
              {t("pf.makeSource")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
