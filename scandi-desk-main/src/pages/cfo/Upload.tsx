// /upload — drop a real document, watch the pipeline finish, get pushed to
// the populated Dashboard.
//
// Flow:
//   1. uploadDocument() pushes the file to {org_id}/uploads/{document_id}.{ext}
//      and inserts a documents row at status='queued'.
//   2. enqueuePipeline() POSTs to /api/pipeline/run on the FastAPI backend.
//   3. The backend runs detect → ocr → extract → map → assemble → validate →
//      compute → narrate, mutating documents.status as each stage starts.
//   4. We subscribe to Postgres Changes on this document and re-render the
//      progress card with the current stage. When status hits 'analyzed',
//      we navigate to /dashboard?period=<period_id>.
//
// When Supabase isn't configured the page shows an authentication-required
// banner — every code path here requires a real session.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AppShell } from "@/components/cfo/AppShell";
import {
  AlertCircle,
  ArrowRight,
  Check,
  ClockAlert,
  FileText,
  Loader2,
  RefreshCcw,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import {
  deleteDocument,
  enqueuePipeline,
  listDocuments,
  retryPipeline,
  subscribeToDocumentStatus,
  supabaseEnabled,
  uploadDocument,
  type DocumentRow,
  type DocumentDetectedType,
  type DocumentStatus,
} from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { useActiveOrg } from "@/lib/org";
import { useToast } from "@/hooks/use-toast";

const ACCEPTED = ".pdf,.xlsx,.xls,.csv,.jpg,.jpeg,.png";
const MAX_BYTES = 25 * 1024 * 1024;

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

interface StageMeta { label: string; ordinal: number; total: number }
const STAGES: Record<DocumentStatus, StageMeta> = {
  queued:     { label: "Queued for analysis…",        ordinal: 0, total: 6 },
  extracting: { label: "Reading the document…",       ordinal: 1, total: 6 },
  mapping:    { label: "Mapping accounts…",           ordinal: 2, total: 6 },
  computing:  { label: "Computing ratios…",           ordinal: 3, total: 6 },
  narrating:  { label: "Generating insights…",        ordinal: 4, total: 6 },
  analyzed:   { label: "Analysis ready",              ordinal: 6, total: 6 },
  failed:     { label: "Analysis failed",             ordinal: 0, total: 6 },
};

export default function UploadPage() {
  const { status: authStatus } = useAuth();
  const { org } = useActiveOrg();
  const { toast } = useToast();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [loading, setLoading] = useState(true);

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

  useEffect(() => { void refresh(); }, [refresh]);

  // Subscribe to live status changes for every document in this workspace.
  // When any of them transitions to 'analyzed' with a period_id, navigate.
  useEffect(() => {
    if (!supabaseEnabled || authStatus !== "signed_in") return;
    const unsub = subscribeToDocumentStatus(null, (row) => {
      setDocs((prev) => {
        const idx = prev.findIndex((d) => d.id === row.id);
        if (idx < 0) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], ...row };
        return next;
      });
      if (row.status === "analyzed" && row.period_id) {
        toast({
          title: "Analysis ready",
          description: `${row.original_filename} is loaded into Dashboard.`,
        });
        navigate(`/dashboard?period=${row.period_id}`);
      } else if (row.status === "failed" && row.error) {
        toast({
          title: "Analysis failed",
          description: row.error,
          variant: "destructive",
        });
      }
    });
    return unsub;
  }, [authStatus, navigate, toast]);

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
    const { row, error } = await uploadDocument(file);
    if (!row) {
      setBusy(false);
      toast({
        title: "Upload failed",
        description: error ?? "Unknown error.",
        variant: "destructive",
      });
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    // Optimistic update so the new row is visible immediately.
    setDocs((prev) => [row, ...prev]);

    const enqueued = await enqueuePipeline(row.id);
    setBusy(false);
    if (!enqueued) {
      toast({
        title: "Couldn't start analysis",
        description: "Backend is unreachable. The file uploaded but analysis didn't start.",
        variant: "destructive",
      });
    } else {
      toast({
        title: "Analysis started",
        description: `${file.name} — you'll be redirected when it's ready.`,
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

  async function onRetry(doc: DocumentRow) {
    const ok = await retryPipeline(doc.id);
    if (!ok) {
      toast({ title: "Retry failed", description: "Backend unreachable.", variant: "destructive" });
      return;
    }
    setDocs((prev) => prev.map((d) => d.id === doc.id ? { ...d, status: "queued", error: null } : d));
  }

  const showAuthWarning = !supabaseEnabled || authStatus !== "signed_in";
  const inFlight = docs.find((d) => d.status !== "analyzed" && d.status !== "failed");

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
        {org?.industry_display_name && (
          <p className="mt-1.5 text-[12.5px] text-ink-mute">
            Workspace: <span className="text-ink">{org.name}</span> · {org.industry_display_name}
          </p>
        )}
      </section>

      {showAuthWarning && (
        <div className="mb-6 rounded-2xl border border-amber-300/60 bg-amber-50 text-amber-800 px-4 py-3 text-[13px]">
          {!supabaseEnabled ? (
            <>Authentication isn't configured on this build (missing{" "}
              <code className="px-1 rounded bg-amber-100">VITE_SUPABASE_URL</code>{" "}
              or <code className="px-1 rounded bg-amber-100">VITE_SUPABASE_ANON_KEY</code>).</>
          ) : (
            <>Sign in to upload documents. <Link to="/login?next=/upload" className="font-medium underline">Sign in →</Link></>
          )}
        </div>
      )}

      {/* In-flight pipeline progress card. Always present when any doc is processing. */}
      {inFlight && (
        <div data-testid="pipeline-progress" className="mb-6 rounded-2xl border border-rule bg-surface p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Loader2 size={16} className="text-brand animate-spin" strokeWidth={2} />
              <span className="text-[13.5px] font-medium text-ink">Analyzing your document…</span>
            </div>
            <span className="text-[11.5px] text-ink-mute tabular-nums">
              Step {STAGES[inFlight.status].ordinal} of {STAGES[inFlight.status].total}
            </span>
          </div>
          <div className="text-[13px] text-ink-soft mb-2">
            <span className="text-ink font-medium">{inFlight.original_filename}</span>{" "}
            · {STAGES[inFlight.status].label}
          </div>
          <div className="h-1.5 rounded-full bg-bg-2 overflow-hidden">
            <div
              className="h-full bg-brand transition-all duration-500"
              style={{ width: `${(STAGES[inFlight.status].ordinal / STAGES[inFlight.status].total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Dropzone */}
      <div
        data-testid="upload-dropzone"
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
            Open Dashboard <ArrowRight size={12} strokeWidth={2} />
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
                  <tr key={doc.id} className="border-t border-rule align-top" data-testid={`doc-row-${doc.id}`}>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2.5">
                        <FileIcon mime={doc.mime_type} />
                        <div>
                          <div className="text-ink truncate max-w-[280px]">{doc.original_filename}</div>
                          {doc.status === "failed" && doc.error && (
                            <div className="mt-0.5 text-[11.5px] text-alert flex items-start gap-1.5">
                              <AlertCircle size={11} className="mt-0.5 shrink-0" />
                              <span className="line-clamp-2 max-w-[320px]">{doc.error}</span>
                            </div>
                          )}
                        </div>
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
                        {doc.status === "analyzed" && doc.period_id && (
                          <Link
                            to={`/dashboard?period=${doc.period_id}`}
                            data-testid="open-analysis"
                            className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[11.5px] font-medium text-brand-d border border-brand/30 bg-brand-tint hover:bg-brand/15 transition-colors"
                          >
                            Open <ArrowRight size={11} strokeWidth={2} />
                          </Link>
                        )}
                        {doc.status === "failed" && (
                          <button
                            type="button"
                            onClick={() => onRetry(doc)}
                            data-testid="retry-pipeline"
                            className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[11.5px] font-medium text-brand-d border border-brand/30 bg-brand-tint hover:bg-brand/15 transition-colors"
                          >
                            <RefreshCcw size={11} strokeWidth={2} />
                            Re-run
                          </button>
                        )}
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
  const config: Record<DocumentStatus, { icon: typeof Check; bg: string; text: string; spin?: boolean }> = {
    queued:     { icon: ClockAlert, bg: "bg-amber-50",   text: "text-amber-700" },
    extracting: { icon: Loader2,    bg: "bg-blue-50",    text: "text-blue-700",    spin: true },
    mapping:    { icon: Loader2,    bg: "bg-blue-50",    text: "text-blue-700",    spin: true },
    computing:  { icon: Loader2,    bg: "bg-indigo-50",  text: "text-indigo-700",  spin: true },
    narrating:  { icon: Loader2,    bg: "bg-violet-50",  text: "text-violet-700",  spin: true },
    analyzed:   { icon: Check,      bg: "bg-emerald-50", text: "text-emerald-700" },
    failed:     { icon: X,          bg: "bg-red-50",     text: "text-red-700" },
  };
  const { icon: Icon, bg, text, spin } = config[status];
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full ${bg} ${text}`}>
      <Icon size={11} strokeWidth={2} className={spin ? "animate-spin" : ""} />
      {STAGES[status].label}
    </span>
  );
}
