// DocumentChip.tsx — persistent top-bar indicator for the active upload.
//
// What it does
// ────────────
// Renders a small pill in the top header showing the currently-active
// upload's filename + status. Visible on every page (Dashboard,
// Products, Benchmark, Settings, Chat) because it reads from the
// global uploadStore, not from any page-local state.
//
// States rendered
// ───────────────
//   • In-progress (queued / extracting / mapping / computing / narrating):
//     spinner icon + truncated filename + "Analyzing…"
//   • Analyzed: green checkmark + filename + dismiss × to clear
//   • Failed: red alert icon + filename + dismiss ×
//   • Idle (no active upload): nothing rendered
//
// Click target: opens a small popover with full filename, started-at
// timestamp, and a Reset/Dismiss action. Keeping it compact in the top
// bar avoids stealing space from the navigation.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  Loader2,
  X,
} from "lucide-react";

import { clearUpload, useUploadStore } from "@/lib/uploadStore";
import type { DocumentStatus } from "@/lib/supabase";

const IN_FLIGHT_STATUSES: ReadonlySet<DocumentStatus> = new Set<DocumentStatus>([
  "queued",
  "extracting",
  "mapping",
  "computing",
  "narrating",
]);

function statusLabel(status: DocumentStatus): string {
  switch (status) {
    case "queued":     return "Queued";
    case "extracting": return "Reading";
    case "mapping":    return "Mapping";
    case "computing":  return "Computing";
    case "narrating":  return "Briefing";
    case "analyzed":   return "Ready";
    case "failed":     return "Failed";
    default:           return String(status);
  }
}

export function DocumentChip() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const upload = useUploadStore().current;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!upload || !upload.docId) return null;

  const isInFlight = IN_FLIGHT_STATUSES.has(upload.status);
  const isAnalyzed = upload.status === "analyzed";
  const isFailed = upload.status === "failed";

  // Truncate long filenames so the chip doesn't blow out the top bar.
  const shortName = upload.filename.length > 24
    ? upload.filename.slice(0, 22) + "…"
    : upload.filename;

  // Color tokens follow the rest of the product (brand for in-flight,
  // emerald for success, alert/red for failure). No new design tokens.
  const toneClasses = isFailed
    ? "border-alert/40 bg-alert/10 text-alert"
    : isAnalyzed
    ? "border-success/40 bg-success/10 text-success"
    : "border-brand/40 bg-brand/10 text-ink";

  return (
    <div ref={ref} className="relative" data-testid="document-chip">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={upload.filename}
        className={`
          inline-flex items-center gap-1.5
          h-9 sm:h-8 px-2.5 rounded-full
          border ${toneClasses}
          text-[12px] font-medium
          transition-colors hover:opacity-90 active:opacity-75
          max-w-[120px] sm:max-w-[260px]
        `}
      >
        {isInFlight && <Loader2 size={12} className="animate-spin shrink-0" />}
        {isAnalyzed && <CheckCircle2 size={12} className="shrink-0" />}
        {isFailed && <AlertCircle size={12} className="shrink-0" />}
        {!isInFlight && !isAnalyzed && !isFailed && <FileText size={12} className="shrink-0" />}
        <span className="truncate">{shortName}</span>
        <span className="hidden sm:inline text-[10.5px] uppercase tracking-[0.06em] opacity-70 shrink-0">
          {statusLabel(upload.status)}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          className="
            absolute right-0 top-full mt-2 z-50
            min-w-[280px] max-w-[360px]
            rounded-lg border border-rule bg-surface shadow-lg
            p-3
          "
        >
          <div className="text-[11px] uppercase tracking-[0.1em] text-ink-mute mb-1">
            {t("document_chip.active_document", "Active document")}
          </div>
          <div className="text-[12.5px] font-medium text-ink break-all leading-snug">
            {upload.filename}
          </div>
          <div className="mt-1 text-[11px] text-ink-soft">
            {statusLabel(upload.status)}
            {upload.error && <span className="block text-alert mt-0.5">{upload.error}</span>}
          </div>
          <div className="mt-3 flex items-center gap-2 justify-between">
            {upload.periodId && (
              <button
                type="button"
                onClick={() => {
                  navigate(`/dashboard?period=${encodeURIComponent(upload.periodId!)}`);
                  setOpen(false);
                }}
                className="text-[11.5px] font-medium text-ink-soft hover:text-ink underline-offset-2 hover:underline"
              >
                {t("document_chip.view_analysis", "View analysis")}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                clearUpload();
                setOpen(false);
              }}
              data-testid="document-chip-dismiss"
              className="
                ml-auto inline-flex items-center gap-1
                text-[11.5px] font-medium text-ink-soft hover:text-ink
              "
            >
              <X size={11} />
              {t("document_chip.dismiss", "Dismiss")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
