// DocsPanel — right-anchored slide-out for switching between uploaded
// periods. Apple-Mail-style: opens via a header pill or Cmd/Ctrl+D,
// closes with the same toggle. Active period sticky at top; other
// periods listed below; recently-deleted shelf at the bottom; upload
// CTA closes the loop.
//
// Switching periods uses `router.replace`, not push — period switching
// is substitution, not navigation. The user's back button stays clean.

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Check,
  ChevronRight,
  Download,
  FileText,
  Loader2,
  MoreHorizontal,
  Pencil,
  Power,
  RefreshCcw,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDocsPanelOpen } from "@/lib/docsPanel";
import {
  enqueuePipeline,
  getSupabase,
  retryPipeline,
  signedDocumentUrl,
} from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";

interface DocRow {
  id: string;
  display_name: string;
  original_filename: string;
  storage_path: string;
  mime_type: string | null;
  detected_type: string | null;
  size_bytes: number;
  uploaded_at: string;
  status: string;
  is_active: boolean;
  confidence: number | null;
  error: string | null;
}

interface PeriodRow {
  period_id: string;
  period_label: string;
  period_start: string | null;
  period_end: string | null;
  is_active: boolean;
  currency: string | null;
  documents: DocRow[];
  extraction_confidence: number | null;
}

interface DeletedRow {
  id: string;
  display_name: string;
  deleted_at: string;
  restorable_until: string;
}

interface ApiResponse {
  active_period_id: string | null;
  periods: PeriodRow[];
  recently_deleted: DeletedRow[];
}

async function fetchPanelData(): Promise<ApiResponse | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) return null;
  const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
  const res = await fetch(`${apiUrl}/api/org/periods-with-documents`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as ApiResponse;
}

async function restoreDoc(id: string): Promise<boolean> {
  return await callDocEndpoint(`/api/documents/${id}/restore`, "POST");
}

async function softDeleteDoc(id: string): Promise<boolean> {
  return await callDocEndpoint(`/api/documents/${id}`, "DELETE");
}

async function patchDoc(id: string, body: { display_name?: string; is_active?: boolean }): Promise<boolean> {
  return await callDocEndpoint(`/api/documents/${id}`, "PATCH", body);
}

async function callDocEndpoint(path: string, method: "POST" | "DELETE" | "PATCH", body?: object): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) return false;
  const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.ok;
}

// ─── The toggle pill (lives in the header) ──────────────────────────────────

export function DocsToggle({ count }: { count: number | null }) {
  const [open, setOpen] = useDocsPanelOpen();
  return (
    <button
      type="button"
      data-testid="docs-toggle"
      aria-expanded={open}
      aria-controls="docs-panel"
      onClick={() => setOpen(!open)}
      title="Documents · ⌘D"
      className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border text-[12.5px] font-medium transition-colors ${
        open
          ? "bg-ink text-paper border-ink"
          : "bg-surface text-ink border-rule hover:bg-bg-2"
      }`}
    >
      <FileText size={13} strokeWidth={1.75} />
      Docs{count !== null && count > 0 ? ` (${count})` : ""}
      <ChevronRight
        size={12}
        strokeWidth={2}
        className={`transition-transform ${open ? "rotate-90" : ""}`}
      />
    </button>
  );
}

/** Returns the document-count for the header pill (active period's docs).
 *  Returns null while loading so the pill renders without flashing "(0)".  */
export function useDocsCount(): number | null {
  const { data, isLoading } = useQuery({
    queryKey: ["periods-with-documents"],
    queryFn: fetchPanelData,
  });
  if (isLoading || !data) return null;
  const active = data.periods.find((p) => p.is_active);
  return active?.documents.length ?? 0;
}

// ─── The panel itself ──────────────────────────────────────────────────────

export function DocsPanel() {
  const [open, setOpen] = useDocsPanelOpen();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ["periods-with-documents"],
    queryFn: fetchPanelData,
    enabled: open,
  });

  // Esc closes the panel — matches the Cmd+D toggle and the X button.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  const currentPeriodInUrl = params.get("period");
  const activePeriod = data?.periods.find((p) => p.is_active) ?? null;
  const otherPeriods = data?.periods.filter((p) => !p.is_active) ?? [];
  const recentlyDeleted = data?.recently_deleted ?? [];

  function switchTo(periodId: string) {
    const sp = new URLSearchParams(params);
    sp.set("period", periodId);
    // `replace` not `navigate` — period switching is substitution, not
    // navigation, so the back button stays clean.
    navigate({ search: `?${sp.toString()}` }, { replace: true });
  }

  async function handleRestore(id: string) {
    const ok = await restoreDoc(id);
    if (ok) {
      toast({ title: "Document restored" });
      void qc.invalidateQueries({ queryKey: ["periods-with-documents"] });
    } else {
      toast({ title: "Couldn't restore", variant: "destructive" });
    }
  }

  return (
    <>
      {/* Narrow viewport (<1280px): backdrop overlay. Click closes.
          Wider viewports: backdrop is invisible/no-op, content reflows
          via the .lg:ml-[360px] class on the page wrapper.            */}
      <div
        data-testid="docs-panel-backdrop"
        onClick={() => setOpen(false)}
        aria-hidden
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] lg:hidden motion-safe:animate-in motion-safe:fade-in"
      />

      <aside
        id="docs-panel"
        data-testid="docs-panel"
        className="
          fixed right-0 top-16 bottom-0 z-50
          w-[90vw] max-w-[420px] lg:w-[360px]
          bg-surface border-l border-rule shadow-2xl
          flex flex-col
          motion-safe:animate-in motion-safe:slide-in-from-right
          motion-safe:duration-200 motion-safe:ease-out
        "
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-rule">
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">Documents</div>
            <h2 className="font-serif text-[17px] text-ink leading-tight mt-0.5">All your uploads</h2>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close documents panel"
            className="text-ink-mute hover:text-ink p-1 rounded-md hover:bg-bg-2 transition-colors"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
          {isLoading && (
            <div className="text-center py-8 text-[12px] text-ink-mute">
              <Loader2 size={14} className="inline animate-spin mr-1" />
              Loading documents…
            </div>
          )}

          {/* Active period — sticky so it stays in view as the user scrolls others */}
          {activePeriod && (
            <section data-testid="docs-panel-section-active" className="sticky top-0 z-10 -mx-3 px-3 pb-3 bg-surface">
              <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-2">Active period</div>
              <PeriodCard
                period={activePeriod}
                isActive
                isCurrent={currentPeriodInUrl === activePeriod.period_id}
              />
            </section>
          )}

          {/* Other periods */}
          {otherPeriods.length > 0 && (
            <section data-testid="docs-panel-section-others">
              <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-2">
                Other periods ({otherPeriods.length})
              </div>
              <div className="space-y-2">
                {otherPeriods.map((p) => (
                  <PeriodCard
                    key={p.period_id}
                    period={p}
                    isActive={false}
                    isCurrent={currentPeriodInUrl === p.period_id}
                    onSwitch={() => switchTo(p.period_id)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Recently deleted */}
          {recentlyDeleted.length > 0 && (
            <section data-testid="docs-panel-section-deleted">
              <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-2">
                Recently deleted ({recentlyDeleted.length})
              </div>
              <ul className="space-y-1.5">
                {recentlyDeleted.map((d) => (
                  <li
                    key={d.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-rule bg-bg-2/40 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-[12.5px] text-ink truncate">{d.display_name}</div>
                      <div className="text-[10.5px] text-ink-mute">
                        Deleted {new Date(d.deleted_at).toLocaleDateString("en-GB", { dateStyle: "medium" })}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleRestore(d.id)}
                      className="inline-flex items-center gap-1 text-[11.5px] font-medium text-brand-d hover:text-brand"
                    >
                      <RotateCcw size={11} strokeWidth={1.75} />
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data && !activePeriod && otherPeriods.length === 0 && (
            <div className="text-center py-12">
              <FileText size={28} className="mx-auto text-ink-mute mb-2" strokeWidth={1.5} />
              <p className="text-[13px] text-ink-soft">No documents yet.</p>
              <p className="text-[11.5px] text-ink-mute mt-1">Drop a trial balance on the dashboard to begin.</p>
            </div>
          )}
        </div>

        <footer className="px-3 py-3 border-t border-rule">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              // The dashboard's empty-state dropzone is the canonical upload
              // surface; the panel doesn't duplicate it. Close + scroll to top.
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            data-testid="docs-panel-upload"
            className="w-full inline-flex items-center justify-center gap-2 h-10 rounded-lg border border-dashed border-rule text-[12.5px] font-medium text-ink-soft hover:text-ink hover:border-rule-strong hover:bg-bg-2 transition-colors"
          >
            <Upload size={13} strokeWidth={1.75} />
            Upload document
          </button>
        </footer>
      </aside>
    </>
  );
}

// ─── PeriodCard ────────────────────────────────────────────────────────────

function PeriodCard({
  period,
  isActive,
  isCurrent,
  onSwitch,
}: {
  period: PeriodRow;
  isActive: boolean;
  isCurrent: boolean;
  onSwitch?: () => void;
}) {
  const label = period.period_end
    ? new Date(period.period_end).toLocaleDateString("en-GB", { dateStyle: "medium" })
    : period.period_label;
  const ring = isCurrent
    ? "border-brand bg-brand/[0.06]"
    : "border-rule bg-bg-2/40 hover:border-rule-strong hover:bg-bg-2/70";

  return (
    <article
      data-testid="period-card"
      className={`rounded-xl border ${ring} px-3.5 py-3 transition-colors`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-serif text-[14px] text-ink leading-tight">{label}</span>
            {isCurrent && (
              <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.06em] font-semibold text-brand-d px-1.5 py-0.5 rounded-full bg-brand-tint">
                <span className="h-1.5 w-1.5 rounded-full bg-brand" /> Viewing
              </span>
            )}
            {isActive && !isCurrent && (
              <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.06em] font-semibold text-emerald-700 px-1.5 py-0.5 rounded-full bg-emerald-50">
                Active
              </span>
            )}
          </div>
          <ul className="mt-1.5 space-y-0.5">
            {period.documents.length === 0 && (
              <li className="text-[11.5px] text-ink-mute">No documents</li>
            )}
            {period.documents.slice(0, 3).map((d) => (
              <DocRowItem key={d.id} doc={d} />
            ))}
            {period.documents.length > 3 && (
              <li className="text-[10.5px] text-ink-mute">+ {period.documents.length - 3} more</li>
            )}
          </ul>
        </div>
      </div>
      {onSwitch && !isCurrent && (
        <button
          type="button"
          onClick={onSwitch}
          className="mt-2 w-full inline-flex items-center justify-center gap-1 h-7 rounded-md text-[11.5px] font-medium text-ink hover:bg-bg-2 border border-rule transition-colors"
        >
          <RefreshCcw size={10} strokeWidth={1.75} />
          Switch
        </button>
      )}
    </article>
  );
}

// ─── DocRowItem — single document line with rename + menu ─────────────────

function DocRowItem({ doc }: { doc: DocRow }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(doc.display_name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  function invalidate() {
    void qc.invalidateQueries({ queryKey: ["periods-with-documents"] });
  }

  async function commitRename() {
    const next = draftName.trim();
    if (!next || next === doc.display_name) {
      setRenaming(false);
      setDraftName(doc.display_name);
      return;
    }
    const ok = await patchDoc(doc.id, { display_name: next });
    if (ok) {
      toast({ title: "Renamed" });
      invalidate();
    } else {
      toast({ title: "Couldn't rename", variant: "destructive" });
      setDraftName(doc.display_name);
    }
    setRenaming(false);
  }

  async function handleDownload() {
    setDownloading(true);
    const url = await signedDocumentUrl({
      // signedDocumentUrl reads doc.storage_path; the other DocumentRow
      // fields it doesn't touch can be undefined for this call.
      id: doc.id,
      storage_path: doc.storage_path,
    } as never);
    setDownloading(false);
    if (!url) {
      toast({ title: "Couldn't generate download link", variant: "destructive" });
      return;
    }
    window.open(url, "_blank", "noopener");
  }

  async function handleRerun() {
    const ok = await retryPipeline(doc.id);
    if (ok) {
      toast({ title: "Re-running analysis", description: doc.display_name });
      invalidate();
    } else {
      toast({ title: "Couldn't start re-run", variant: "destructive" });
    }
  }

  async function handleToggleActive() {
    const ok = await patchDoc(doc.id, { is_active: !doc.is_active });
    if (ok) {
      toast({ title: doc.is_active ? "Marked inactive" : "Marked active" });
      invalidate();
    } else {
      toast({ title: "Couldn't update", variant: "destructive" });
    }
  }

  async function handleDelete() {
    setConfirmDelete(false);
    const ok = await softDeleteDoc(doc.id);
    if (ok) {
      toast({ title: "Deleted", description: `${doc.display_name} — restorable for 30 days.` });
      invalidate();
    } else {
      toast({ title: "Couldn't delete", variant: "destructive" });
    }
  }

  const isInflight = !["analyzed", "failed"].includes(doc.status);

  return (
    <li
      data-testid="doc-row"
      className={`group flex items-center gap-1.5 text-[11.5px] ${doc.is_active ? "text-ink-soft" : "text-ink-mute line-through"}`}
    >
      <FileText size={9} strokeWidth={1.75} className="text-ink-mute shrink-0" />
      {renaming ? (
        <input
          ref={inputRef}
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commitRename();
            if (e.key === "Escape") { setRenaming(false); setDraftName(doc.display_name); }
          }}
          onBlur={() => void commitRename()}
          className="flex-1 min-w-0 bg-bg-2 border border-rule rounded px-1 py-0.5 text-[11px] text-ink outline-none focus:border-brand"
        />
      ) : (
        <span className="truncate flex-1 min-w-0">{doc.display_name}</span>
      )}
      {!renaming && doc.status !== "analyzed" && (
        <span className={`text-[9.5px] uppercase tracking-[0.06em] font-medium shrink-0 ${doc.status === "failed" ? "text-red-700" : "text-amber-700"}`}>
          · {doc.status}
        </span>
      )}
      {!renaming && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              data-testid="doc-menu"
              aria-label="Document actions"
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity h-5 w-5 inline-flex items-center justify-center rounded text-ink-mute hover:text-ink hover:bg-bg-2"
            >
              <MoreHorizontal size={11} strokeWidth={1.75} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={() => setRenaming(true)} className="text-[12px] cursor-pointer">
              <Pencil size={11} strokeWidth={1.75} className="mr-2" /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void handleDownload()}
              disabled={downloading}
              className="text-[12px] cursor-pointer"
            >
              <Download size={11} strokeWidth={1.75} className="mr-2" />
              {downloading ? "Preparing…" : "Download original"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void handleRerun()}
              disabled={isInflight}
              className="text-[12px] cursor-pointer"
            >
              <RefreshCcw size={11} strokeWidth={1.75} className="mr-2" /> Re-run analysis
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void handleToggleActive()} className="text-[12px] cursor-pointer">
              <Power size={11} strokeWidth={1.75} className="mr-2" />
              {doc.is_active ? "Mark inactive" : "Mark active"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => setConfirmDelete(true)}
              className="text-[12px] cursor-pointer text-red-700 focus:text-red-700"
            >
              <Trash2 size={11} strokeWidth={1.75} className="mr-2" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {doc.display_name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The document is moved to Recently deleted and can be restored
              within 30 days. After that it's removed from storage permanently.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-delete-doc"
              onClick={() => void handleDelete()}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
