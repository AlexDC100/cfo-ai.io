// Upload dialog — accepts an Excel/CSV file and posts it to /api/upload-excel.
//
// Behaviour today:
//   · The legacy /api/upload-excel endpoint exists and works against the
//     legacy inventory-workbook shape. For now we POST the file there; on
//     success we toast "Imported" and close. On failure (network down or
//     unmapped columns) we toast the error.
//   · No-op-friendly: if the user clicks "Choose file" without uploading
//     they can dismiss the dialog. Drag-and-drop also accepted.

import { useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { UploadCloud, FileSpreadsheet, Trash2, X } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { uploadExcelToBackend } from "@/lib/api";
import {
  clearActiveRun,
  setActiveRun,
  setAnalysis,
  setUploadAlerts,
  useRunMeta,
} from "@/lib/runStore";
import { clearUserPersistedState, supabaseEnabled } from "@/lib/supabase";
// Surface the canonical Excel template at the top of the upload dialog
// so first-time users grab the known-good format instead of uploading
// arbitrary workbooks and hitting the silent-extract failure modes.
// `compact` variant matches the modal's information density.
import { TemplateDownloadCard } from "@/components/cfo/products/TemplateDownloadCard";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UploadDialog({ open, onOpenChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const meta = useRunMeta();
  const hasActiveDataset = meta.source === "upload";

  function reset() {
    setFile(null);
    setBusy(false);
    setDragOver(false);
    setConfirmingDelete(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  function close() {
    onOpenChange(false);
    setTimeout(reset, 250);
  }

  async function deleteDataset() {
    setBusy(true);
    try {
      // Local state first — even if Supabase fails, the user always wants
      // the in-browser dataset gone before re-uploading.
      clearActiveRun();
      let remoteDescription = "Workspace cleared. Drop a new workbook.";
      if (supabaseEnabled) {
        const counts = await clearUserPersistedState();
        if (counts) {
          const total = counts.alert_states + counts.recommendations + counts.activity + counts.datasets;
          if (total > 0) {
            remoteDescription = `Removed ${counts.alert_states} alerts, ${counts.activity} activity events from your account.`;
          }
        }
      }
      toast.success("Dataset deleted", { description: remoteDescription });
      setConfirmingDelete(false);
    } catch (err) {
      toast.error("Reset failed", {
        description: err instanceof Error ? err.message : "Couldn't clear workspace state.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function upload() {
    if (!file) return;
    setBusy(true);
    try {
      // Typed roundtrip — gives us run, raw_rows, analysis, and the new
      // server-derived `alerts` block so the /alerts page can render the
      // backend's view of the dataset instead of the local seed-derive.
      const result = await uploadExcelToBackend(file);
      setActiveRun(
        result.run,
        { fileName: result.file_name, rowCount: result.transaction_rows, uploadedAt: new Date().toISOString() },
        result.raw_rows.map((r) => ({
          sku: r.sku,
          category: r.category,
          volumeT: r.volume_tons,
          revenue: r.revenue_kron,
          grossMarginPct: r.gross_margin_pct,
          dioDays: 90,
          strategicFlag: false,
        })),
      );
      setAnalysis({ ...result.analysis, generatedAt: new Date().toISOString() });
      setUploadAlerts(result.alerts ?? null);
      const alertCount = result.alerts?.length ?? 0;
      const skuCount = result.skus?.sku_count ?? 0;
      toast.success("Workbook imported", {
        description: `${skuCount} SKUs classified${alertCount ? ` · ${alertCount} alerts ready` : ""}.`,
      });
      close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      toast.error("Upload failed", {
        description: msg.includes("Failed to fetch")
          ? "Backend not running. Start the engine API and try again."
          : msg,
      });
      setBusy(false);
    }
  }

  function onPick(f: FileList | null) {
    if (!f || f.length === 0) return;
    const picked = f[0];
    const ok =
      picked.name.toLowerCase().endsWith(".xlsx") ||
      picked.name.toLowerCase().endsWith(".csv");
    if (!ok) {
      toast.error("Unsupported file", {
        description: "Drop a .xlsx or .csv workbook.",
      });
      return;
    }
    setFile(picked);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <DialogContent
        className="
          p-0 overflow-hidden
          bg-surface dark:bg-bg-2
          border border-rule shadow-4
          [&>button.absolute]:hidden
          inset-x-0 bottom-0 top-auto translate-x-0 translate-y-0
          w-full max-h-[92vh] overflow-y-auto overscroll-contain rounded-t-2xl rounded-b-none
          sm:inset-auto sm:top-1/2 sm:left-1/2
          sm:-translate-x-1/2 sm:-translate-y-1/2
          sm:w-full sm:max-w-[520px] sm:max-h-[85vh] sm:rounded-2xl
        "
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3 flex items-start justify-between gap-3 border-b border-rule">
          <div>
            <DialogTitle className="text-[16px] font-medium text-ink leading-tight">
              Upload your data
            </DialogTitle>
            <DialogDescription className="mt-1 text-[12.5px] text-ink-soft leading-snug">
              Drop an Excel or CSV with SKU sales, margin, and inventory.
              We'll classify every product into one of six decision buckets.
            </DialogDescription>
          </div>
          <button
            onClick={close}
            aria-label="Close"
            className="text-ink-mute hover:text-ink p-1 -m-1 rounded-md transition-colors"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5">
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.csv"
            className="hidden"
            onChange={(e) => onPick(e.target.files)}
          />

          {/* Canonical template download — first thing inside the body so
              first-time users see the recommended path before staring at
              an empty dropzone. Hidden once an active dataset banner is
              showing (rename/replace flow) because the user is past the
              "what format?" question at that point. */}
          {!hasActiveDataset && !confirmingDelete && (
            <TemplateDownloadCard variant="compact" />
          )}

          {/* Active-dataset banner — shown only when an upload is loaded.
              Lets the operator wipe the current dataset (locally + remotely
              if signed in) before dropping a replacement. */}
          {hasActiveDataset && !confirmingDelete && (
            <div className="mb-4 rounded-lg border border-rule bg-bg-2 dark:bg-surface-hi/40 px-3.5 py-3 flex items-center gap-3">
              <FileSpreadsheet size={16} strokeWidth={1.75} className="text-brand-d shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-ink truncate">
                  {meta.fileName ?? "Active dataset"}
                </div>
                <div className="text-[11px] text-ink-mute">
                  {meta.rowCount ? `${meta.rowCount.toLocaleString()} rows · ` : ""}
                  {meta.uploadedAt ? new Date(meta.uploadedAt).toLocaleString() : "in memory"}
                </div>
              </div>
              <button
                onClick={() => setConfirmingDelete(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-surface hover:border-alert/40 hover:text-alert px-2.5 py-1.5 text-[12px] text-ink-soft transition-colors"
              >
                <Trash2 size={12} strokeWidth={1.75} />
                Delete
              </button>
            </div>
          )}

          {/* Confirm screen — kept inline so the existing dialog frame stays. */}
          {confirmingDelete && (
            <div className="mb-4 rounded-lg border border-alert/30 bg-alert-tint px-4 py-4">
              <div className="text-[13.5px] text-alert font-medium">
                Delete this dataset?
              </div>
              <p className="mt-1 text-[12.5px] text-ink-soft leading-snug">
                Wipes the active workbook from this browser
                {supabaseEnabled ? " and removes alert states, recommendations, datasets, and activity events from your Supabase account" : ""}.
                You'll need to upload a workbook again to see live alerts.
              </p>
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={deleteDataset}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-md bg-alert text-paper hover:brightness-110 px-3 py-1.5 text-[12px] font-medium disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  <Trash2 size={12} strokeWidth={1.75} />
                  {busy ? "Deleting…" : "Yes, delete"}
                </button>
                <button
                  onClick={() => setConfirmingDelete(false)}
                  disabled={busy}
                  className="px-3 py-1.5 text-[12px] text-ink-soft hover:text-ink rounded-md transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              onPick(e.dataTransfer.files);
            }}
            className={`
              rounded-xl border-2 border-dashed
              transition-colors
              px-6 py-10 text-center
              ${dragOver
                ? "border-brand bg-brand/5"
                : "border-rule bg-bg-2 dark:bg-surface-hi/40"}
            `}
          >
            {file ? (
              <div className="flex items-center justify-center gap-3">
                <FileSpreadsheet size={20} strokeWidth={1.75} className="text-brand" />
                <div className="text-left">
                  <div className="text-[13.5px] text-ink">{file.name}</div>
                  <div className="text-[11.5px] text-ink-mute">
                    {(file.size / 1024).toFixed(0)} KB · ready to upload
                  </div>
                </div>
                <button
                  onClick={() => setFile(null)}
                  className="text-[11px] text-ink-mute hover:text-ink underline-offset-2 hover:underline ml-2"
                >
                  change
                </button>
              </div>
            ) : (
              <>
                <UploadCloud size={26} strokeWidth={1.5} className="text-ink-mute mx-auto" />
                <div className="mt-3 text-[13.5px] text-ink">Drop your workbook here</div>
                <div className="mt-1 text-[11.5px] text-ink-mute">.xlsx or .csv up to 25MB</div>
                <button
                  onClick={() => inputRef.current?.click()}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-bg-2 dark:bg-surface border border-rule hover:border-rule-strong px-3 py-1.5 text-[12px] text-ink-soft hover:text-ink transition-colors"
                >
                  Choose file
                </button>
              </>
            )}
          </div>

          {/* Action row */}
          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              onClick={close}
              className="px-3 py-2 text-[13px] text-ink-soft hover:text-ink rounded-md transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={upload}
              disabled={!file || busy}
              className="
                inline-flex items-center gap-1.5
                rounded-md bg-brand text-bg
                px-4 py-2 text-[13px] font-medium
                hover:brightness-110
                disabled:opacity-40 disabled:cursor-not-allowed
                transition
              "
            >
              {busy ? "Uploading…" : "Import"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
