// DatasetsPanel — right-anchored slide-out for switching between sales
// datasets on /products. Same pattern as DocsPanel on /dashboard but
// scoped to sales-datasets and triggered by Cmd/Ctrl+Shift+D so the
// shortcuts don't collide.
//
// Switching uses navigate({search}, {replace: true}) — same substitution
// pattern as the Docs panel. The Products page re-fetches via React
// Query when ?dataset= changes; the panel stays open across switches.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  Check,
  Download,
  FileText,
  GitCompareArrows,
  Layers,
  Loader2,
  MoreHorizontal,
  Pencil,
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
import { useDatasetsPanelOpen } from "@/lib/datasetsPanel";
import { getSupabase, retryPipeline, signedDocumentUrl } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";
import { activeLocale, formatDateTime } from "@/lib/locale";

// ─── Types ──────────────────────────────────────────────────────────────────

interface DatasetSummary {
  id: string;
  label: string;
  source_filename: string | null;
  row_count: number | null;
  sku_count: number | null;
  uploaded_at: string;
  is_active: boolean;
  document_status: string | null;
  document_id?: string | null;
  storage_path?: string | null;
}

interface DatasetsListPayload {
  active_dataset_id: string | null;
  datasets: DatasetSummary[];
}

interface DeletedRow {
  id: string;
  display_name: string;
  deleted_at: string;
  /** "financial" | "sku" — drives the per-panel scope filter so
   *  DatasetsPanel never shows trial-balance / public-records deletes. */
  scope?: string | null;
}

// ─── API helpers ────────────────────────────────────────────────────────────

async function authHeader(): Promise<Record<string, string> | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : null;
}
const apiBase = (): string =>
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

async function fetchDatasets(): Promise<DatasetsListPayload | null> {
  const h = await authHeader();
  if (!h) return null;
  const r = await fetch(`${apiBase()}/api/sales-datasets`, { headers: h });
  if (!r.ok) return null;
  return (await r.json()) as DatasetsListPayload;
}

async function fetchDeletedDatasets(): Promise<DeletedRow[]> {
  // Reuses the shared documents-with-soft-deletes endpoint and FILTERS
  // to sku-scope rows on the client (the endpoint returns financial +
  // sku as a union for backwards-compat with DocsPanel). Without this
  // filter, the Products panel would surface every deleted trial
  // balance / public-records PDF the dashboard ever soft-deleted — the
  // exact cross-domain bleed this prompt isolates.
  const h = await authHeader();
  if (!h) return [];
  const r = await fetch(`${apiBase()}/api/org/periods-with-documents`, { headers: h });
  if (!r.ok) return [];
  const j = await r.json() as { recently_deleted: DeletedRow[] };
  const all = j.recently_deleted ?? [];
  return all.filter((row) => row.scope === "sku");
}

async function patchDataset(id: string, body: { label?: string }): Promise<boolean> {
  const h = await authHeader();
  if (!h) return false;
  const r = await fetch(`${apiBase()}/api/sales-datasets/${id}`, {
    method: "PATCH",
    headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.ok;
}

async function softDeleteDataset(id: string): Promise<boolean> {
  const h = await authHeader();
  if (!h) return false;
  const r = await fetch(`${apiBase()}/api/sales-datasets/${id}`, {
    method: "DELETE",
    headers: h,
  });
  return r.ok;
}

async function restoreDataset(docId: string): Promise<boolean> {
  const h = await authHeader();
  if (!h) return false;
  const r = await fetch(`${apiBase()}/api/documents/${docId}/restore`, {
    method: "POST",
    headers: h,
  });
  return r.ok;
}

// Hard-delete a soft-deleted document. Backend rejects with 400 if the
// document hasn't been soft-deleted first — so accidental destruction of
// a live row is structurally impossible from this path.
async function permanentDeleteDataset(docId: string): Promise<boolean> {
  const h = await authHeader();
  if (!h) return false;
  const r = await fetch(`${apiBase()}/api/documents/${docId}/permanent`, {
    method: "DELETE",
    headers: h,
  });
  return r.ok;
}

// Wipe the entire Recently Deleted bucket for the caller's org.
async function clearAllRecentlyDeletedDatasets(): Promise<boolean> {
  const h = await authHeader();
  if (!h) return false;
  const r = await fetch(`${apiBase()}/api/documents/clear-deleted`, {
    method: "DELETE",
    headers: h,
  });
  return r.ok;
}

async function rerunDataset(id: string): Promise<number | null> {
  const h = await authHeader();
  if (!h) return null;
  const r = await fetch(`${apiBase()}/api/sales-datasets/${id}/rerun`, {
    method: "POST",
    headers: h,
  });
  if (!r.ok) return null;
  const j = await r.json() as { reclassified: number };
  return j.reclassified;
}

// ─── Toggle pill ────────────────────────────────────────────────────────────

export function DatasetsToggle({ count }: { count: number | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useDatasetsPanelOpen();
  return (
    <button
      type="button"
      data-testid="datasets-toggle"
      aria-expanded={open}
      aria-controls="datasets-panel"
      onClick={() => setOpen(!open)}
      title={t("panels.datasetsToggleTitle")}
      className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border text-[12.5px] font-medium transition-colors ${
        open ? "bg-ink text-paper border-ink" : "bg-surface text-ink border-rule hover:bg-bg-2"
      }`}
    >
      <Layers size={13} strokeWidth={1.75} />
      {t("panels.datasetsLabel")}{count !== null && count > 0 ? ` (${count})` : ""}
    </button>
  );
}

export function useDatasetsCount(): number | null {
  const { data, isLoading } = useQuery({
    queryKey: ["sales-datasets"],
    queryFn: fetchDatasets,
  });
  if (isLoading || !data) return null;
  return data.datasets.length;
}

// ─── The panel itself ──────────────────────────────────────────────────────

export function DatasetsPanel() {
  const { t } = useTranslation();
  const [open, setOpen] = useDatasetsPanelOpen();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ["sales-datasets"],
    queryFn: fetchDatasets,
    enabled: open,
  });
  const { data: deleted } = useQuery({
    queryKey: ["sales-datasets-deleted"],
    queryFn: fetchDeletedDatasets,
    enabled: open,
  });

  // Esc closes (Cmd+Shift+D toggle also works via the hook).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  // ── ALL HOOKS ABOVE THE EARLY RETURN (rules of hooks) ─────────────────
  // Permanent-delete state for the Recently Deleted section. The
  // confirmation dialog has destructive tone; there is NO undo toast
  // (the action is irreversible — opposite of the soft delete's
  // optimistic 6-second undo pattern).
  //
  // CRITICAL: this `useState` MUST live above the `if (!open) return null`
  // below. Previously placed after the early return, it produced
  // "Rendered fewer/more hooks than expected" the first time the panel
  // toggled open — because the closed-state render skipped the hook
  // and the open-state render included it.
  const [confirmPermanent, setConfirmPermanent] = useState<
    | { mode: "single"; id: string; name: string }
    | { mode: "all"; count: number }
    | null
  >(null);

  if (!open) return null;

  const currentInUrl = params.get("dataset");
  const datasets = data?.datasets ?? [];
  // "Active" in the panel = currently-viewed (URL > most recent).
  const activeId = currentInUrl ?? data?.active_dataset_id ?? null;
  const active = datasets.find((d) => d.id === activeId) ?? null;
  const others = datasets.filter((d) => d.id !== activeId);
  const compareId = params.get("compare");

  function switchTo(id: string) {
    // 2026-05-26 — operator reported switching felt broken because:
    // (1) the panel stayed open over the page so no visual feedback,
    // (2) the query cache held stale data so the page showed the old
    //     dataset until the network round-trip landed silently.
    // Fix: close the panel + force-invalidate the relevant queries so
    // React Query refetches and the page renders its loading skeleton.
    const sp = new URLSearchParams(params);
    sp.set("dataset", id);
    sp.delete("compare"); // dropping comparison when switching
    navigate({ search: `?${sp.toString()}` }, { replace: true });
    void qc.invalidateQueries({ queryKey: ["sales-dataset", id] });
    setOpen(false);
    toast({
      title: t("panels.loadingDataset"),
      description: t("panels.loadingDatasetDesc"),
    });
  }
  function setCompare(id: string | null) {
    const sp = new URLSearchParams(params);
    if (id) sp.set("compare", id); else sp.delete("compare");
    navigate({ search: `?${sp.toString()}` }, { replace: true });
  }
  function invalidate() {
    void qc.invalidateQueries({ queryKey: ["sales-datasets"] });
    void qc.invalidateQueries({ queryKey: ["sales-datasets-deleted"] });
    if (activeId) void qc.invalidateQueries({ queryKey: ["sales-dataset", activeId] });
  }
  async function handleRestore(docId: string) {
    const ok = await restoreDataset(docId);
    if (ok) { toast({ title: t("panels.datasetRestored") }); invalidate(); }
    else { toast({ title: t("panels.cantRestore"), variant: "destructive" }); }
  }

  async function handlePermanentDelete(docId: string) {
    const ok = await permanentDeleteDataset(docId);
    if (ok) { toast({ title: t("panels.permanentlyDeleted") }); invalidate(); }
    else { toast({ title: t("panels.cantDeletePermanently"), variant: "destructive" }); }
  }
  async function handleClearAllDeleted() {
    const ok = await clearAllRecentlyDeletedDatasets();
    if (ok) { toast({ title: t("panels.recentlyDeletedCleared") }); invalidate(); }
    else { toast({ title: t("panels.cantClear"), variant: "destructive" }); }
  }

  return (
    <>
      <div
        data-testid="datasets-panel-backdrop"
        onClick={() => setOpen(false)}
        aria-hidden
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] lg:hidden motion-safe:animate-in motion-safe:fade-in"
      />
      <aside
        id="datasets-panel"
        data-testid="datasets-panel"
        className="
          fixed right-0 top-0 bottom-0 z-50
          w-[90vw] max-w-[420px] lg:w-[360px]
          bg-surface/85 backdrop-blur-2xl border-l border-rule shadow-2xl
          flex flex-col
          motion-safe:animate-in motion-safe:slide-in-from-right
          motion-safe:duration-200 motion-safe:ease-out
        "
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-rule">
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">{t("panels.datasetsLabel")}</div>
            <h2 className="font-serif text-[17px] text-ink leading-tight mt-0.5">{t("panels.salesAnalyses")}</h2>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label={t("panels.closeDatasetsAria")}
            className="text-ink-mute hover:text-ink p-1 rounded-md hover:bg-bg-2 transition-colors"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto overscroll-contain px-3 py-4 space-y-5">
          {isLoading && (
            <div className="text-center py-8 text-[12px] text-ink-mute">
              <Loader2 size={14} className="inline animate-spin mr-1" />
              {t("products.loading.datasets")}
            </div>
          )}

          {active && (
            <section data-testid="datasets-panel-section-active" className="sticky top-0 z-10 -mx-3 px-3 pb-3 bg-surface">
              <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-2">{t("datasets.status.active")}</div>
              <DatasetCard
                ds={active}
                isCurrent
                onSwitch={undefined}
                onRename={async (label) => {
                  const ok = await patchDataset(active.id, { label });
                  if (ok) { toast({ title: t("panels.renamed") }); invalidate(); }
                  else toast({ title: t("panels.cantRename"), variant: "destructive" });
                }}
                onRerun={async () => {
                  const n = await rerunDataset(active.id);
                  if (n !== null) { toast({ title: t("panels.reclassified", { count: n }) }); invalidate(); }
                  else toast({ title: t("panels.rerunFailed"), variant: "destructive" });
                }}
                onCompare={undefined}
                onDelete={async () => {
                  const ok = await softDeleteDataset(active.id);
                  if (ok) {
                    toast({ title: t("panels.datasetMovedToDeleted") });
                    invalidate();
                    // Swap to the next dataset if any.
                    const next = others[0];
                    if (next) switchTo(next.id);
                  }
                  else toast({ title: t("panels.cantDelete"), variant: "destructive" });
                }}
              />
            </section>
          )}

          {others.length > 0 && (
            <section data-testid="datasets-panel-section-others">
              <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-2">
                {t("panels.otherDatasets", { count: others.length })}
              </div>
              <div className="space-y-2">
                {others.map((d) => (
                  <DatasetCard
                    key={d.id}
                    ds={d}
                    isCurrent={d.id === compareId}
                    onSwitch={() => switchTo(d.id)}
                    onRename={async (label) => {
                      const ok = await patchDataset(d.id, { label });
                      if (ok) { toast({ title: t("panels.renamed") }); invalidate(); }
                      else toast({ title: t("panels.cantRename"), variant: "destructive" });
                    }}
                    onRerun={async () => {
                      const n = await rerunDataset(d.id);
                      if (n !== null) { toast({ title: t("panels.reclassified", { count: n }) }); invalidate(); }
                      else toast({ title: t("panels.rerunFailed"), variant: "destructive" });
                    }}
                    onCompare={
                      active && active.id !== d.id
                        ? () => { setCompare(d.id); toast({ title: t("panels.comparingWith", { label: d.label }) }); }
                        : undefined
                    }
                    onDelete={async () => {
                      const ok = await softDeleteDataset(d.id);
                      if (ok) { toast({ title: t("panels.datasetMovedToDeleted") }); invalidate(); }
                      else toast({ title: t("panels.cantDelete"), variant: "destructive" });
                    }}
                  />
                ))}
              </div>
            </section>
          )}

          {(deleted ?? []).length > 0 && (
            <section data-testid="datasets-panel-section-deleted">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">
                  {t("panels.recentlyDeletedCount", { count: (deleted ?? []).length })}
                </div>
                <button
                  type="button"
                  data-testid="datasets-recently-deleted-clear-all"
                  onClick={() => setConfirmPermanent({ mode: "all", count: (deleted ?? []).length })}
                  className="text-[10.5px] font-medium text-[hsl(var(--alert))] hover:text-[hsl(var(--alert-d,var(--alert)))] hover:bg-alert-tint px-2 py-1 rounded transition-colors"
                >
                  {t("panels.clearAll")}
                </button>
              </div>
              <ul className="space-y-1.5">
                {(deleted ?? []).map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 rounded-lg border border-rule bg-bg-2/40 px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-[12.5px] text-ink truncate">{d.display_name}</div>
                      <div className="text-[10.5px] text-ink-mute">
                        {t("panels.deletedOn", { date: formatDateTime(d.deleted_at, { dateStyle: "medium" }) })}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        aria-label={t("panels.restoreAria", { name: d.display_name })}
                        title={t("panels.restore")}
                        onClick={() => void handleRestore(d.id)}
                        className="inline-flex items-center gap-1 text-[11.5px] font-medium text-brand-d hover:text-brand hover:bg-bg-2 px-2 py-1 rounded transition-colors"
                      >
                        <RotateCcw size={11} strokeWidth={1.75} />
                        <span>{t("panels.restore")}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={t("panels.deletePermanentlyAria", { name: d.display_name })}
                        title={t("panels.deletePermanentlyTitle")}
                        data-testid={`datasets-recently-deleted-permanent-${d.id}`}
                        onClick={() =>
                          setConfirmPermanent({ mode: "single", id: d.id, name: d.display_name })
                        }
                        className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[hsl(var(--alert))] hover:text-[hsl(var(--alert-d,var(--alert)))] hover:bg-alert-tint px-2 py-1 rounded transition-colors"
                      >
                        <Trash2 size={11} strokeWidth={1.75} />
                        <span>{t("panels.deleteForever")}</span>
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Confirmation dialog for permanent delete (single OR clear-all).
              Destructive tone: confirm button is red. Storage blob + DB
              row are removed. No undo. */}
          <AlertDialog
            open={confirmPermanent !== null}
            onOpenChange={(open) => { if (!open) setConfirmPermanent(null); }}
          >
            <AlertDialogContent data-testid="datasets-permanent-delete-dialog">
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {confirmPermanent?.mode === "single"
                    ? t("panels.deleteFilePermanentlyTitle")
                    : confirmPermanent?.mode === "all"
                      ? t("panels.deleteAllPermanentlyTitle", { count: confirmPermanent.count })
                      : t("panels.deletePermanentlyFallbackTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {confirmPermanent?.mode === "single" ? (
                    <>
                      "<span className="font-medium text-ink">{confirmPermanent.name}</span>" {t("panels.deleteFilePermanentlyBody")}
                    </>
                  ) : confirmPermanent?.mode === "all" ? (
                    <>
                      {t("panels.deleteAllPermanentlyBody", { count: confirmPermanent.count })}
                    </>
                  ) : null}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setConfirmPermanent(null)}>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  data-testid="datasets-permanent-delete-confirm"
                  onClick={async () => {
                    const state = confirmPermanent;
                    setConfirmPermanent(null);
                    if (!state) return;
                    if (state.mode === "single") {
                      await handlePermanentDelete(state.id);
                    } else {
                      await handleClearAllDeleted();
                    }
                  }}
                  className="bg-red-500 hover:bg-red-600 text-white"
                >
                  {confirmPermanent?.mode === "single" ? t("panels.deleteForever") : t("panels.deleteAllForever")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {data && datasets.length === 0 && (
            <div className="text-center py-12">
              <Layers size={28} className="mx-auto text-ink-mute mb-2" strokeWidth={1.5} />
              <p className="text-[13px] text-ink-soft">{t("panels.noDatasetsYet")}</p>
              <p className="text-[11.5px] text-ink-mute mt-1">{t("panels.noDatasetsHint")}</p>
            </div>
          )}
        </div>

        <footer className="px-3 py-3 border-t border-rule">
          <button
            type="button"
            onClick={() => {
              // 2026-05-26 — was: close panel + scroll-to-top, hoping
              // the user would find the upload dropzone. That dropzone
              // is HIDDEN once a dataset is loaded (it only renders in
              // the empty state), so the button silently did nothing
              // for any user already on a dataset. Now: dispatch a
              // window event that Products.tsx listens for; the page
              // closes the panel for us and programmatically clicks
              // the hidden file input — opens the native file picker
              // immediately regardless of whether the dropzone is
              // currently in the DOM.
              setOpen(false);
              window.dispatchEvent(new CustomEvent("cfo:request-sku-upload"));
            }}
            data-testid="datasets-panel-upload"
            className="w-full inline-flex items-center justify-center gap-2 h-10 rounded-lg border border-dashed border-rule text-[12.5px] font-medium text-ink-soft hover:text-ink hover:border-rule-strong hover:bg-bg-2 transition-colors"
          >
            <Upload size={13} strokeWidth={1.75} />
            {t("panels.uploadSalesDataset")}
          </button>
        </footer>
      </aside>
    </>
  );
}

// ─── DatasetCard with per-row menu ─────────────────────────────────────────

function DatasetCard({
  ds, isCurrent, onSwitch, onRename, onRerun, onCompare, onDelete,
}: {
  ds: DatasetSummary;
  isCurrent: boolean;
  onSwitch?: () => void;
  onRename: (label: string) => Promise<void> | void;
  onRerun: () => Promise<void> | void;
  onCompare?: () => void;
  onDelete: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(ds.label);
  const [confirmDel, setConfirmDel] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (renaming) inputRef.current?.select(); }, [renaming]);

  async function commitRename() {
    const next = draft.trim();
    if (!next || next === ds.label) { setRenaming(false); setDraft(ds.label); return; }
    await onRename(next);
    setRenaming(false);
  }

  const ring = isCurrent
    ? "border-brand bg-brand/[0.06]"
    : "border-rule bg-bg-2/40 hover:border-rule-strong hover:bg-bg-2/70";

  return (
    <article
      data-testid="dataset-card"
      className={`rounded-xl border ${ring} px-3.5 py-3 transition-colors`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {renaming ? (
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commitRename();
                  if (e.key === "Escape") { setRenaming(false); setDraft(ds.label); }
                }}
                onBlur={() => void commitRename()}
                className="font-serif text-[14px] text-ink leading-tight bg-bg-2 border border-rule rounded px-1.5 py-0.5 outline-none focus:border-brand min-w-0 flex-1"
              />
            ) : (
              <span className="font-serif text-[14px] text-ink leading-tight truncate">{ds.label}</span>
            )}
            {isCurrent && (
              <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.06em] font-semibold text-brand-d px-1.5 py-0.5 rounded-full bg-brand-tint shrink-0">
                <span className="h-1.5 w-1.5 rounded-full bg-brand" /> {t("panels.viewing")}
              </span>
            )}
          </div>
          {ds.source_filename && (
            <div className="text-[10.5px] text-ink-mute mt-1 truncate">{ds.source_filename}</div>
          )}
          <div className="text-[10.5px] text-ink-soft mt-0.5">
            {typeof ds.sku_count === "number" ? t("panels.skusFmt", { value: ds.sku_count.toLocaleString(activeLocale()) }) : "—"}
            {typeof ds.row_count === "number" ? ` · ${t("panels.linesFmt", { value: ds.row_count.toLocaleString(activeLocale()) })}` : ""}
            {" · "}
            {formatDateTime(ds.uploaded_at, { dateStyle: "medium" })}
          </div>
          {ds.document_status && ds.document_status !== "analyzed" && (
            <div className="text-[10px] uppercase tracking-[0.06em] font-medium text-[#2AA89B] mt-1">
              · {ds.document_status}
            </div>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              data-testid="dataset-menu"
              aria-label={t("panels.datasetActionsAria")}
              className="opacity-60 hover:opacity-100 h-6 w-6 inline-flex items-center justify-center rounded text-ink-mute hover:text-ink hover:bg-bg-2"
            >
              <MoreHorizontal size={12} strokeWidth={1.75} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {onSwitch && (
              <DropdownMenuItem onSelect={onSwitch} className="text-[12px] cursor-pointer">
                <RefreshCcw size={11} strokeWidth={1.75} className="mr-2" /> {t("panels.switchToDataset")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => setRenaming(true)} className="text-[12px] cursor-pointer">
              <Pencil size={11} strokeWidth={1.75} className="mr-2" /> {t("panels.rename")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void onRerun()} className="text-[12px] cursor-pointer">
              <RefreshCcw size={11} strokeWidth={1.75} className="mr-2" /> {t("panels.rerunAnalysis")}
            </DropdownMenuItem>
            {onCompare && (
              <DropdownMenuItem onSelect={onCompare} className="text-[12px] cursor-pointer">
                <GitCompareArrows size={11} strokeWidth={1.75} className="mr-2" /> {t("panels.compareWithActive")}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => setConfirmDel(true)}
              className="text-[12px] cursor-pointer text-red-700 focus:text-red-700"
            >
              <Trash2 size={11} strokeWidth={1.75} className="mr-2" /> {t("common.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {onSwitch && !isCurrent && (
        <button
          type="button"
          onClick={onSwitch}
          className="mt-2 w-full inline-flex items-center justify-center gap-1 h-7 rounded-md text-[11.5px] font-medium text-ink hover:bg-bg-2 border border-rule transition-colors"
        >
          <RefreshCcw size={10} strokeWidth={1.75} />
          {t("panels.switch")}
        </button>
      )}

      <AlertDialog open={confirmDel} onOpenChange={setConfirmDel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("panels.deleteDocTitle", { name: ds.label })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("panels.deleteDatasetBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-delete-dataset"
              onClick={() => { setConfirmDel(false); void onDelete(); }}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  );
}
