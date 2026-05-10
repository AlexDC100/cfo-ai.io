// /app/upload — Phase 1 real upload route.
//
// Drop a file → uploadDocument() pushes it to Supabase Storage and inserts a
// row in the documents table. List below refreshes from the database (not
// optimistic state) so we know the row truly persisted.
//
// What this page does NOT do (yet):
//   • Run extraction / OCR — that's Phase 2's pipeline worker.
//   • Render the parsed financial statements — `/dashboard` does.
//
// When Supabase isn't configured the page falls back to an explicit warning;
// it does not silently pretend the upload "worked".

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AppShell } from "@/components/cfo/AppShell";
import {
  ArrowRight,
  Check,
  ClockAlert,
  FileText,
  Loader2,
  Sparkles,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import {
  deleteDocument,
  listDocuments,
  setDocumentStatus,
  signedDocumentUrl,
  supabaseEnabled,
  uploadDocument,
  type DocumentRow,
  type DocumentDetectedType,
  type DocumentStatus,
} from "@/lib/supabase";
import { parseFinancialDocument } from "@/lib/api";
import { buildStatementsFromAccounts } from "@/lib/trialBalanceParser";
import type { DocumentType } from "@/lib/financialStatementTabs";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";

// Hand-off payload key — when the parse pipeline finishes, we stash the
// resulting Statements here and navigate. The FinancialStatements page picks
// it up on mount and clears the slot.
const HANDOFF_KEY = "cfoai.parsed";

const ACCEPTED = ".pdf,.xlsx,.xls,.csv,.jpg,.jpeg,.png";
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB ceiling — anything bigger likely needs server-side chunking

const DETECTED_LABEL: Record<DocumentDetectedType, string> = {
  trial_balance: "Trial balance",
  bilant: "Bilanț (balance sheet)",
  pl: "P&L statement",
  invoice: "Invoice",
  annual_report: "Annual report",
  xlsx_workbook: "Excel workbook",
  csv: "CSV",
  image: "Image",
  unknown: "Document",
};

const STATUS_LABEL: Record<DocumentStatus, string> = {
  uploaded: "Uploaded · awaiting extraction",
  extracting: "Extracting…",
  mapped: "Mapped",
  analyzed: "Analyzed",
  failed: "Failed",
};

export default function UploadPage() {
  const { status: authStatus, demoActive } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [loading, setLoading] = useState(true);
  // Per-document analysis state — guards the spinner + disables the button
  // while Claude is working on this specific file.
  const [analyzing, setAnalyzing] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!supabaseEnabled) {
      setDocs([]);
      setLoading(false);
      return;
    }
    const rows = await listDocuments();
    setDocs(rows);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (file.size > MAX_BYTES) {
      toast({
        title: "File too large",
        description: `${(file.size / 1_000_000).toFixed(1)} MB exceeds the 25 MB single-file limit.`,
        variant: "destructive",
      });
      return;
    }
    setBusy(true);
    const row = await uploadDocument(file);
    setBusy(false);
    if (row) {
      toast({ title: "Uploaded", description: `${file.name} · ${DETECTED_LABEL[row.detected_type ?? "unknown"]}` });
      await refresh();
    } else {
      toast({
        title: "Upload failed",
        description: supabaseEnabled
          ? "Sign in is required to upload documents."
          : "Authentication isn't configured on this build.",
        variant: "destructive",
      });
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDrag(false);
    void handleFiles(e.dataTransfer.files);
  }

  async function onDelete(doc: DocumentRow) {
    const ok = await deleteDocument(doc);
    if (ok) {
      toast({ title: "Deleted", description: doc.original_filename });
      await refresh();
    } else {
      toast({ title: "Couldn't delete", variant: "destructive" });
    }
  }

  /**
   * Run the Phase 2 extraction pipeline on one document:
   *   1. Mint a 5-min signed Storage URL.
   *   2. POST to backend → Claude Opus 4.7 reads the PDF and returns
   *      structured Romanian trial-balance accounts.
   *   3. Map account codes → standardized buckets (frontend, no AI).
   *   4. Stash the resulting Statements in sessionStorage and navigate
   *      to /dashboard; that page hydrates from the slot.
   *
   * Document.status is updated through the lifecycle so the table chip
   * reflects what's happening (extracting → mapped → analyzed).
   */
  async function onAnalyze(doc: DocumentRow) {
    setAnalyzing((prev) => new Set(prev).add(doc.id));
    await setDocumentStatus(doc, { status: "extracting" });
    void refresh();
    try {
      const url = await signedDocumentUrl(doc);
      if (!url) throw new Error("Could not mint Storage signed URL — check Supabase config.");

      const parsed = await parseFinancialDocument({
        pdf_url: url,
        original_filename: doc.original_filename,
      });

      const { statements } = buildStatementsFromAccounts(parsed.accounts, {
        companyName: parsed.company_name ?? "Imported entity",
        currency: parsed.currency,
        periodLabel: parsed.period_label,
      });

      // Tab visibility — the same shape a sample contributes.
      const availableTypes: DocumentType[] = (() => {
        const t = parsed.detected_type;
        if (t === "trial_balance") return ["trial_balance", "bilant", "pl"];
        if (t === "bilant") return ["bilant", "pl"];
        if (t === "pl") return ["pl"];
        if (t === "annual_report") return ["annual_report", "bilant", "pl"];
        return ["bilant", "pl"]; // fallback — we got accounts so BS+PL surfaces should appear
      })();

      sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({
        statements,
        availableTypes,
        source: {
          documentId: doc.id,
          documentName: doc.original_filename,
          confidence: parsed.confidence,
          warnings: parsed.warnings,
          accountCount: parsed.accounts.length,
        },
      }));
      await setDocumentStatus(doc, {
        status: "analyzed",
        extraction_confidence: parsed.confidence,
        detected_type: parsed.detected_type as never,
      });
      toast({
        title: "Analysis complete",
        description: `Extracted ${parsed.accounts.length} accounts at ${(parsed.confidence * 100).toFixed(0)}% confidence.`,
      });
      navigate("/dashboard");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error.";
      await setDocumentStatus(doc, { status: "failed", error: msg });
      void refresh();
      toast({
        title: "Analysis failed",
        description: msg,
        variant: "destructive",
      });
    } finally {
      setAnalyzing((prev) => {
        const next = new Set(prev);
        next.delete(doc.id);
        return next;
      });
    }
  }

  // Real Storage upload requires a real Supabase session — demo mode alone
  // is not enough (the RLS policy keys off auth.uid()). Warn explicitly.
  const showAuthWarning = !supabaseEnabled || authStatus !== "signed_in";

  return (
    <AppShell>
      <section className="mb-8">
        <div className="label-eyebrow">Upload</div>
        <h1 className="mt-3 font-serif text-[36px] sm:text-[44px] leading-[1.05] tracking-[-0.02em] text-ink max-w-[720px]">
          Add a document.{" "}
          <span className="text-grad font-medium">We take it from there</span>.
        </h1>
        <p className="mt-4 text-[14.5px] text-ink-soft max-w-[640px]">
          Romanian <span className="text-ink">balanță de verificare</span>,{" "}
          <span className="text-ink">bilanț</span>, P&L, invoice exports —
          PDF / XLSX / CSV / JPG / PNG. Files land in your private workspace
          and become available to every analysis surface.
        </p>
      </section>

      {showAuthWarning && (
        <div className="mb-6 rounded-2xl border border-amber-300/60 bg-amber-50 text-amber-800 px-4 py-3 text-[13px]">
          {!supabaseEnabled ? (
            <>Authentication isn't configured on this build (missing{" "}
              <code className="px-1 rounded bg-amber-100">VITE_SUPABASE_URL</code>{" "}
              or <code className="px-1 rounded bg-amber-100">VITE_SUPABASE_ANON_KEY</code>).
              You can browse demo data, but upload requires sign-in.</>
          ) : (
            <>Sign in to upload documents. <Link to="/login?next=/upload" className="font-medium underline">Sign in →</Link></>
          )}
        </div>
      )}

      {/* Dropzone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={`rounded-2xl border-2 border-dashed transition-colors ${
          drag ? "border-brand bg-brand/5" : "border-rule bg-bg-2/30"
        } px-6 py-14 text-center`}
      >
        <div className="mx-auto h-14 w-14 rounded-2xl bg-brand-tint text-brand-d flex items-center justify-center mb-4">
          <UploadCloud size={22} strokeWidth={1.75} />
        </div>
        <h2 className="font-serif text-[20px] text-ink">Drop a file or click to browse</h2>
        <p className="text-[13px] text-ink-soft mt-1">
          Up to 25 MB · {ACCEPTED.replaceAll(",", " · ")}
        </p>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy || showAuthWarning}
          className="mt-5 inline-flex items-center gap-2 h-10 px-5 rounded-lg bg-brand text-paper text-[13px] font-medium hover:bg-brand-d transition-colors disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <UploadCloud size={14} strokeWidth={2} />}
          {busy ? "Uploading…" : "Choose a file"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED}
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {/* Documents list */}
      <section className="mt-10">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="font-serif text-[22px] text-ink">Your documents</h2>
          <Link
            to="/dashboard"
            className="text-[13px] text-brand-d hover:text-brand transition-colors inline-flex items-center gap-1"
          >
            Open Statements AI <ArrowRight size={12} strokeWidth={2} />
          </Link>
        </div>

        {loading ? (
          <div className="rounded-2xl border border-rule bg-surface p-10 text-center text-[13px] text-ink-soft">
            <Loader2 size={16} className="animate-spin inline mr-2" />
            Loading documents…
          </div>
        ) : docs.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-bg-2/40 text-[11px] uppercase tracking-[0.08em] text-ink-mute">
                  <th className="text-left py-2.5 px-4 font-medium">File</th>
                  <th className="text-left py-2.5 px-4 font-medium">Type</th>
                  <th className="text-left py-2.5 px-4 font-medium">Status</th>
                  <th className="text-right py-2.5 px-4 font-medium">Size</th>
                  <th className="text-right py-2.5 px-4 font-medium">Uploaded</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {docs.map((doc) => (
                  <tr key={doc.id} className="border-t border-rule">
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2.5">
                        <FileIcon mime={doc.mime_type} />
                        <span className="text-ink truncate max-w-[280px]">{doc.original_filename}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-ink-soft">
                      {DETECTED_LABEL[doc.detected_type ?? "unknown"]}
                    </td>
                    <td className="py-3 px-4">
                      <StatusChip status={doc.status} />
                    </td>
                    <td className="py-3 px-4 text-right tabular-nums text-ink-soft">
                      {(doc.size_bytes / 1024).toFixed(0)} KB
                    </td>
                    <td className="py-3 px-4 text-right text-ink-soft">
                      {new Date(doc.created_at).toLocaleString("en-GB", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </td>
                    <td className="py-3 px-2">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => onAnalyze(doc)}
                          disabled={analyzing.has(doc.id) || doc.status === "extracting"}
                          title="Run extraction with Claude Opus 4.7"
                          aria-label="Run analysis"
                          className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[11.5px] font-medium text-brand-d border border-brand/30 bg-brand-tint hover:bg-brand/15 transition-colors disabled:opacity-50 disabled:cursor-progress"
                        >
                          {analyzing.has(doc.id)
                            ? <Loader2 size={11} strokeWidth={2} className="animate-spin" />
                            : <Sparkles size={11} strokeWidth={2} />}
                          {analyzing.has(doc.id) ? "Analyzing…" : doc.status === "analyzed" ? "Re-analyze" : "Run analysis"}
                        </button>
                        <button
                          onClick={() => onDelete(doc)}
                          title="Delete"
                          aria-label="Delete document"
                          className="text-ink-mute hover:text-alert transition-colors p-1.5 rounded-md hover:bg-alert/5"
                        >
                          <Trash2 size={14} strokeWidth={1.75} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </AppShell>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-rule bg-bg-2/20 p-12 text-center">
      <div className="mx-auto h-12 w-12 rounded-full bg-bg-2 text-ink-mute flex items-center justify-center mb-3">
        <FileText size={20} strokeWidth={1.5} />
      </div>
      <h3 className="font-serif text-[18px] text-ink">No documents yet</h3>
      <p className="text-[13px] text-ink-soft mt-1 max-w-[420px] mx-auto">
        Upload your first balance sheet, trial balance, or invoice export.
        Everything stays scoped to your workspace.
      </p>
    </div>
  );
}

function FileIcon({ mime }: { mime: string }) {
  const tone =
    mime.includes("pdf") ? "text-red-500 bg-red-50" :
    mime.includes("spreadsheet") ? "text-emerald-700 bg-emerald-50" :
    mime.includes("csv") || mime.includes("text") ? "text-blue-600 bg-blue-50" :
    mime.startsWith("image/") ? "text-purple-600 bg-purple-50" :
    "text-ink-mute bg-bg-2";
  return (
    <span className={`inline-flex items-center justify-center h-8 w-8 rounded-lg ${tone}`}>
      <FileText size={14} strokeWidth={1.75} />
    </span>
  );
}

function StatusChip({ status }: { status: DocumentStatus }) {
  const config: Record<DocumentStatus, { icon: typeof Check; bg: string; text: string }> = {
    uploaded: { icon: ClockAlert, bg: "bg-amber-50", text: "text-amber-700" },
    extracting: { icon: Loader2, bg: "bg-blue-50", text: "text-blue-700" },
    mapped: { icon: Check, bg: "bg-blue-50", text: "text-blue-700" },
    analyzed: { icon: Check, bg: "bg-emerald-50", text: "text-emerald-700" },
    failed: { icon: X, bg: "bg-red-50", text: "text-red-700" },
  };
  const { icon: Icon, bg, text } = config[status];
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full ${bg} ${text}`}>
      <Icon size={11} strokeWidth={2} className={status === "extracting" ? "animate-spin" : ""} />
      {STATUS_LABEL[status]}
    </span>
  );
}
