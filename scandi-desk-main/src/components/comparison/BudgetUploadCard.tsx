// F6.0.1b (2026-06-21) — Budget upload + template card.
//
// Lets the user bring their own budget (and optional last-year) figures via a
// .csv / .xlsx file matching the downloadable template. Parsing is
// client-side (parseBudgetFile). Shows the current data source (uploaded vs
// illustrative demo) and a remove control.

import { useRef, useState } from "react";
import { Upload, Download, FileSpreadsheet, X, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { parseBudgetFile } from "@/lib/comparison/parseBudget";
import { VARIANCE_LINES, type ComparisonDataset } from "@/lib/comparison/types";
import { cn } from "@/lib/utils";

interface Props {
  /** The uploaded dataset (null when none). */
  uploaded: ComparisonDataset | null;
  /** True when the currently-displayed comparison is the demo seed. */
  isDemo: boolean;
  onSave: (ds: ComparisonDataset) => void;
  onClear: () => void;
}

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

export function BudgetUploadCard({ uploaded, isDemo, onSave, onClear }: Props) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

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
      className="rounded-xl border border-rule bg-surface px-4 py-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium text-ink">Budget &amp; last-year data</div>
          <div className="mt-0.5 text-[11.5px] text-ink-mute">
            {uploaded ? (
              <span data-testid="budget-source-uploaded">
                Using your upload:{" "}
                <span className="text-ink-soft">{uploaded.label ?? "budget file"}</span>
              </span>
            ) : isDemo ? (
              <span data-testid="budget-source-demo">
                Showing an <span className="text-amber-600 dark:text-amber-400">illustrative demo budget</span> — upload yours to compare real figures.
              </span>
            ) : (
              <span data-testid="budget-source-none">
                Upload a budget file to compare Actual vs Budget. Last year auto-fills from a prior uploaded period.
              </span>
            )}
          </div>
        </div>
        {uploaded && (
          <button
            type="button"
            onClick={onClear}
            data-testid="budget-clear"
            aria-label="Remove uploaded budget"
            className="text-ink-mute hover:text-ink min-w-[32px] min-h-[32px] grid place-items-center rounded hover:bg-bg-2 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          // Extensions AND MIME types: a macOS file picker greys out files
          // when only an extension is given and it can't map it to a UTI —
          // that's why ".pptx" could be unselectable. The MIME types make
          // PowerPoint / Excel / CSV reliably selectable across OS + browser.
          accept={[
            ".csv", ".txt", ".xlsx", ".xls", ".pptx", ".ppt",
            "text/csv", "text/plain",
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-powerpoint",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          ].join(",")}
          className="hidden"
          data-testid="budget-file-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
          }}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          data-testid="budget-upload-btn"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg px-3 min-h-[40px] text-[12.5px] font-medium",
            "bg-brand/10 text-brand-d hover:bg-brand/15 transition-colors disabled:opacity-60",
          )}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
          {uploaded ? "Replace budget" : "Upload budget"}
        </button>
        <button
          type="button"
          onClick={downloadTemplate}
          data-testid="budget-template-btn"
          className="inline-flex items-center gap-1.5 rounded-lg px-3 min-h-[40px] text-[12.5px] text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors"
        >
          <Download className="w-3.5 h-3.5" />
          Template
        </button>
        <span className="inline-flex items-center gap-1 text-[11px] text-ink-mute">
          <FileSpreadsheet className="w-3 h-3" />
          .csv, .xlsx or .pptx budget deck
        </span>
      </div>
    </div>
  );
}
