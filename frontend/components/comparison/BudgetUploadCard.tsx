// F6.0.1b (2026-06-21) — Budget upload dropzone + official-template card.
//
// Lets the user bring their own budget (and optional last-year) figures via a
// .csv / .xlsx file matching the downloadable template. Parsing is
// client-side (parseBudgetFile). Redesigned 2026-07-25 into a premium DROPZONE
// (drag-drop / click), mirroring the dashboard's upload surface, plus a
// separate "Start from the official template" card (BudgetTemplateCard).

import { useEffect, useRef, useState } from "react";
import { Upload, Download, FileSpreadsheet, X, Loader2, Cloud, ArrowUp, Info, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { parseBudgetFile } from "@/lib/comparison/parseBudget";
import { VARIANCE_LINES, type ComparisonDataset } from "@/lib/comparison/types";

interface Props {
  /** The uploaded dataset (null when none). */
  uploaded: ComparisonDataset | null;
  /** True when the currently-displayed comparison is the demo seed. */
  isDemo: boolean;
  onSave: (ds: ComparisonDataset) => void;
  onClear: () => void;
}

// Idle pipeline-steps preview — same treatment as the dashboard / products
// dropzones. Budget parsing is client-side (no engine pipeline), so these are
// a decorative "here's what happens" preview of the variance flow.
const BUDGET_STEPS = [
  "Read file",
  "Match P&L lines",
  "Compute variances",
  "Board-pack view",
] as const;

const BUDGET_ACCEPT = [
  ".csv", ".txt", ".xlsx", ".xls", ".pptx", ".ppt",
  "text/csv", "text/plain",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
].join(",");

function downloadTemplate() {
  const header = "Line,Budget,Last year";
  const body = VARIANCE_LINES.map((l) => `${l.label},,`).join("\n");
  const csv = `${header}\n${body}\n`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "cfo_ai_budget_template.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// View the template as a rendered table in a NEW TAB — same approach + styling
// as the dashboard's example-trial-balance "View" (a plain CSV download can't
// render inline, so we write an HTML preview of the exact template rows).
function viewTemplate() {
  const tab = window.open("", "_blank");
  if (!tab) return;
  const rows = VARIANCE_LINES
    .map((l) => `<tr><td class="l">${l.label}</td><td></td><td></td></tr>`)
    .join("");
  const doc =
    `<!doctype html><html><head><meta charset="utf-8"><title>cfo_ai_budget_template.csv</title><style>` +
    "body{font:13px/1.4 system-ui,Segoe UI,Arial,sans-serif;margin:0;padding:24px;color:#0f172a;background:#fff}" +
    "h1{font-size:15px;margin:0 0 12px;color:#1B7268}" +
    "table{border-collapse:collapse;font-variant-numeric:tabular-nums}" +
    "td,th{border:1px solid #d6dde6;padding:4px 10px;white-space:nowrap;text-align:right}" +
    "th{background:#1B7268;color:#fff;font-weight:600;text-align:left}" +
    "td.l{text-align:left}" +
    "p{margin-top:12px;color:#6B7280;font-size:12px}" +
    `</style></head><body><h1>cfo_ai_budget_template.csv — budget template</h1>` +
    `<table><thead><tr><th>Line</th><th>Budget</th><th>Last year</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<p>Fill in the Budget column (required) and optionally Last year, then re-upload. Fictional/blank template.</p>` +
    `</body></html>`;
  tab.document.open();
  tab.document.write(doc);
  tab.document.close();
}

export function BudgetUploadCard({ uploaded, onSave, onClear }: Props) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  // The header "Replace budget" pill (in Variance.tsx) dispatches this event —
  // it lives outside this card, so it opens the file picker via the event
  // rather than a ref. Same pattern as the products page's upload trigger.
  useEffect(() => {
    const open = () => inputRef.current?.click();
    window.addEventListener("cfo:request-budget-upload", open);
    return () => window.removeEventListener("cfo:request-budget-upload", open);
  }, []);

  async function onFile(file: File) {
    setBusy(true);
    try {
      const ds = await parseBudgetFile(file);
      onSave(ds);
      const bn = Object.keys(ds.budget).length;
      const lyn = Object.keys(ds.lastYear).length;
      toast({
        title: "Budget loaded",
        description: `${bn} budget line${bn === 1 ? "" : "s"}${lyn ? ` + ${lyn} last-year` : ""} parsed from ${file.name}.`,
      });
    } catch (e) {
      toast({
        title: "Couldn't read that file",
        description: e instanceof Error ? e.message : "Unknown parse error.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div
      data-testid="budget-upload-card"
      onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
      onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
      onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        const f = e.dataTransfer.files?.[0];
        if (f) void onFile(f);
      }}
      data-drag-active={dragActive ? "true" : "false"}
      className={`
        relative overflow-hidden
        rounded-2xl border-2 border-dashed
        backdrop-blur-sm
        p-6 sm:p-7
        flex flex-col items-center justify-center text-center
        min-h-[240px]
        transition-all duration-150
        ${dragActive
          ? "border-brand bg-brand/10 ring-2 ring-inset ring-brand/30 shadow-[0_0_0_4px_rgba(92,211,197,0.08)]"
          : "border-rule/80 bg-gradient-to-br from-bg-2/30 via-surface/60 to-surface/40 hover:border-rule-strong hover:from-bg-2/50"}
      `}
    >
      <input
        ref={inputRef}
        type="file"
        accept={BUDGET_ACCEPT}
        className="hidden"
        data-testid="budget-file-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
        }}
      />
      {/* Atmospheric brand glow */}
      <div aria-hidden className="pointer-events-none absolute -top-20 -right-12 h-56 w-56 rounded-full bg-brand/8 blur-3xl" />

      {/* Oversized upload mark — decorative, pinned to the bottom-left corner
          and clipped by the card's overflow-hidden. Opacity on the WRAPPER so
          overlapping strokes never stack. */}
      <div aria-hidden className="pointer-events-none absolute -bottom-32 -left-16 text-ink opacity-[0.08]">
        <Cloud size={440} strokeWidth={1} />
        <ArrowUp size={160} strokeWidth={2.5} className="absolute left-1/2 top-[62%] -translate-x-1/2 -translate-y-1/2" />
      </div>

      {busy ? (
        <div className="relative flex items-center gap-2.5 text-ink-soft">
          <Loader2 size={18} strokeWidth={2} className="animate-spin text-brand-d" />
          <span className="text-[13px]">Reading your budget…</span>
        </div>
      ) : uploaded ? (
        <div className="relative flex flex-col items-center">
          <div className="inline-flex items-center gap-2 rounded-lg border border-rule bg-surface px-3 py-1.5" data-testid="budget-source-uploaded">
            <FileSpreadsheet className="w-4 h-4 text-[#2AA89B]" />
            <span className="text-[13px] font-medium text-ink truncate max-w-[220px]">
              {uploaded.label ?? "budget file"}
            </span>
            <button
              type="button"
              onClick={onClear}
              data-testid="budget-clear"
              aria-label="Remove uploaded budget"
              className="text-ink-mute hover:text-ink grid place-items-center rounded hover:bg-bg-2 w-6 h-6"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            data-testid="budget-upload-btn"
            className="mt-3.5 inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-lg border border-brand/40 ask-ai-anim-fill [animation-duration:10s] text-ink text-[12.5px] font-medium hover:border-brand/60 transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
            Replace budget
          </button>
        </div>
      ) : (
        <div className="relative flex flex-col items-center">
          <h3 className="text-[16px] font-semibold text-ink">
            {dragActive ? "Drop your file to upload" : "Drop your budget file"}
          </h3>
          <p className="text-[12.5px] text-ink-soft mt-1">
            CSV · XLSX · PPTX budget deck
          </p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            data-testid="budget-upload-btn"
            className="mt-4 inline-flex items-center justify-center h-9 px-3.5 rounded-lg border border-brand/40 ask-ai-anim-fill [animation-duration:10s] text-ink text-[12.5px] font-medium hover:border-brand/60 transition-colors"
          >
            Import
          </button>
        </div>
      )}

      {/* Idle pipeline-steps preview — decorative, shown only in the empty
          state (matches the dashboard / products dropzones). */}
      {!busy && !uploaded && (
        <ol
          className="relative w-full max-w-[560px] mx-auto mt-6 flex items-start justify-between gap-2"
          aria-label="Variance pipeline"
          data-testid="budget-upload-pipeline"
        >
          <span aria-hidden className="absolute top-4 left-3 right-3 h-px bg-gradient-to-r from-transparent via-rule to-transparent" />
          {BUDGET_STEPS.map((label, i) => (
            <li key={label} className="relative flex-1 min-w-0 flex flex-col items-center text-center">
              <span className="
                relative z-10 inline-flex items-center justify-center
                h-8 w-8 rounded-full text-[12px] font-semibold tabular-nums
                shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors duration-300
                bg-surface text-ink-soft border border-rule
              ">
                {`0${i + 1}`}
              </span>
              <span className="mt-2 text-[11.5px] uppercase tracking-[0.08em] font-medium leading-tight max-w-[100px] text-ink-mute">
                {label}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ─── Official-template card — budget flavour ────────────────────────────────
// Mirrors the dashboard's "Start from the official template" card
// (TemplateDownloadCard, `prominent` variant): the same animated-gradient
// container, oversized clipped FileSpreadsheet mark, list-item action row, and
// "what's inside" column summary — only the copy is budget-specific
// (Line / Budget / Last year). Restyled 2026-07-25 to match that card.
export function BudgetTemplateCard() {
  return (
    <div
      data-testid="budget-template-card"
      className="
        relative overflow-hidden rounded-2xl
        ask-ai-anim-fill [--af-band:360px] [--af-shift:2036.47px] [animation-duration:28.8s] [--af-a1:0.14] [--af-a2:0.06]
        border border-brand/40
        px-5 py-4 sm:px-6 sm:py-5
      "
    >
      {/* Soft glow blob — Apple-style background accent */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-12 -right-12 h-40 w-40 rounded-full bg-brand/10 blur-3xl"
      />

      {/* Oversized decorative mark — pinned bottom-left, clipped by
          overflow-hidden, same treatment as the trial-balance card. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-20 -left-12 text-ink opacity-[0.08]"
      >
        <FileSpreadsheet size={300} strokeWidth={1} />
      </div>

      <div className="relative flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <h3 className="font-serif text-[24px] text-ink leading-tight tracking-[-0.01em]">
            Start from the official template
          </h3>
          <p className="mt-1.5 text-[12.5px] text-ink-soft leading-relaxed">
            Skip the guesswork — the template has the exact columns the parser
            expects: one row per P&amp;L line, a <span className="text-ink">Budget</span>{" "}
            column, and an optional <span className="text-ink">Last year</span>{" "}
            column. Download, fill in your figures, re-upload above.
          </p>

          {/* Action row — list-item style, same as the trial-balance card. */}
          <div className="mt-3.5 space-y-2">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-rule bg-bg-2/40 px-3 py-2">
              <div className="min-w-0">
                <div className="text-[12.5px] font-medium text-ink truncate">
                  Budget template{" "}
                  <span className="text-ink-mute font-normal">(CSV)</span>
                </div>
                <div className="text-[10.5px] text-ink-mute">
                  One row per P&amp;L line, a Budget column, and an optional Last-year column.
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={viewTemplate}
                  data-testid="budget-template-view"
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium text-ink bg-surface hover:bg-bg-2 ring-1 ring-inset ring-rule transition-colors"
                >
                  <ExternalLink size={12} strokeWidth={2} />
                  View
                </button>
                <button
                  type="button"
                  onClick={downloadTemplate}
                  data-testid="budget-template-btn"
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium text-ink bg-surface hover:bg-bg-2 ring-1 ring-inset ring-rule transition-colors"
                >
                  <Download size={12} strokeWidth={2} />
                  Download
                </button>
              </div>
            </div>
          </div>

          {/* "What's inside" — columns summary, styled like FormatSummary. */}
          <div className="mt-3 pt-3 border-t border-rule/60 space-y-2">
            <div className="flex items-center gap-1.5 text-[11.5px] uppercase tracking-wide text-ink-mute font-medium">
              <Info size={11} strokeWidth={2} />
              Columns in the template
            </div>
            <ul className="space-y-1.5 text-[12px] text-ink-soft leading-snug">
              <li className="flex items-start gap-2">
                <span className="shrink-0 inline-flex items-center font-mono text-ink rounded px-1.5 py-px bg-bg-2 border border-rule">
                  Line
                </span>
                <span className="flex-1">
                  The P&amp;L line label — must match the report&rsquo;s rows.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="shrink-0 inline-flex items-center font-mono text-ink rounded px-1.5 py-px bg-bg-2 border border-rule">
                  Budget
                </span>
                <span className="flex-1">
                  <span className="text-brand-d font-medium">Required</span> — your
                  planned figure for each line.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="shrink-0 inline-flex items-center font-mono text-ink rounded px-1.5 py-px bg-bg-2 border border-rule">
                  Last year
                </span>
                <span className="flex-1">
                  <span className="text-ink-mute italic">Optional</span> — same
                  line&rsquo;s prior-year actual to add a vs-LY column.
                </span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
