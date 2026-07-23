// DocsPanel — right-anchored slide-out for switching between uploaded
// periods. Apple-Mail-style: opens via a header pill or Cmd/Ctrl+D,
// closes with the same toggle. Active period sticky at top; other
// periods listed below; recently-deleted shelf at the bottom.
//
// Review/switch only — uploads happen elsewhere (Dashboard empty state
// + header Replace dropdown). This panel intentionally omits an upload
// button so the user can't accidentally drop a file into the wrong
// surface; the user-facing model is "browse and switch", not "upload".
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
import { ToastAction } from "@/components/ui/toast";
import { useDocsPanelOpen } from "@/lib/docsPanel";
import { periodQueryKey } from "@/lib/activePeriod";
import {
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
  /** "financial" | "sku" — used by the dashboard's recently-deleted
   *  section to keep ONLY financial docs (trial balances / statutory /
   *  public-records). SKU trading-analysis deletes belong to
   *  /products → DatasetsPanel, not here. */
  scope?: string | null;
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
  const payload = (await res.json()) as ApiResponse;
  // Domain isolation: keep ONLY financial docs in recently_deleted.
  // Backend returns financial + sku as a union (DatasetsPanel filters
  // for scope === 'sku' symmetrically). Without this filter, the
  // dashboard's deleted shelf would surface deleted SKU trading-
  // analysis files that belong to /products.
  const all = payload.recently_deleted ?? [];
  return {
    ...payload,
    recently_deleted: all.filter((row) => !row.scope || row.scope === "financial"),
  };
}

async function restoreDoc(id: string): Promise<boolean> {
  return await callDocEndpoint(`/api/documents/${id}/restore`, "POST");
}

async function softDeleteDoc(id: string): Promise<boolean> {
  return await callDocEndpoint(`/api/documents/${id}`, "DELETE");
}

// Hard-delete: only works on already-soft-deleted documents. Backend
// rejects (400) if `deleted_at` is null — that asymmetry is intentional
// so accidental destruction of a live doc isn't possible from this path.
async function permanentDeleteDoc(id: string): Promise<boolean> {
  return await callDocEndpoint(`/api/documents/${id}/permanent`, "DELETE");
}

// Wipe every soft-deleted document in the user's org. Backend uses the
// admin client after a per-user RLS scope check so other orgs' rows
// can't be touched. Returns true on 2xx.
async function clearAllRecentlyDeletedDocs(): Promise<boolean> {
  return await callDocEndpoint(`/api/documents/clear-deleted`, "DELETE");
}

async function patchDoc(id: string, body: { display_name?: string; is_active?: boolean }): Promise<boolean> {
  return await callDocEndpoint(`/api/documents/${id}`, "PATCH", body);
}

/** Human-readable "5 days ago" without pulling in date-fns just for this. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 14) return `${day} ${day === 1 ? "day" : "days"} ago`;
  const wk = Math.round(day / 7);
  if (wk < 8) return `${wk} ${wk === 1 ? "week" : "weeks"} ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo} ${mo === 1 ? "month" : "months"} ago`;
  const yr = Math.round(day / 365);
  return `${yr} ${yr === 1 ? "year" : "years"} ago`;
}

/** Soft-delete every live document on a period. Returns the deleted-doc ids
 *  so the caller can offer an undo (POST /restore on each). */
async function softDeletePeriodDocs(period: PeriodRow): Promise<string[]> {
  const liveIds = period.documents.filter((d) => !!d.is_active).map((d) => d.id);
  if (liveIds.length === 0) return [];
  await Promise.all(liveIds.map((id) => softDeleteDoc(id)));
  return liveIds;
}

async function restoreMany(ids: string[]): Promise<void> {
  await Promise.all(ids.map((id) => restoreDoc(id)));
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
 *  Returns null while loading so the pill renders without flashing "(0)".
 *  Defensively filters empty periods — Step 5 of the docs-panel fix
 *  guarantees the backend doesn't return them either, but belt-and-suspenders. */
export function useDocsCount(): number | null {
  const { data, isLoading } = useQuery({
    queryKey: ["periods-with-documents"],
    queryFn: fetchPanelData,
  });
  if (isLoading || !data) return null;
  const active = data.periods.find(
    (p) => p.is_active && p.documents.length > 0,
  );
  return active?.documents.length ?? 0;
}

// ─── The panel itself ──────────────────────────────────────────────────────

const SHOW_OLDER_KEY = "cfo.docsPanel.showOlder";
const SHOW_DELETED_KEY = "cfo.docsPanel.showDeleted";
const OTHER_PERIODS_VISIBLE_DEFAULT = 3;

function readBoolFlag(key: string, fallback = false): boolean {
  try { return localStorage.getItem(key) === "1"; } catch { return fallback; }
}
function writeBoolFlag(key: string, value: boolean): void {
  try { localStorage.setItem(key, value ? "1" : "0"); } catch { /* quota */ }
}

export function DocsPanel() {
  const [open, setOpen] = useDocsPanelOpen();
  const navigate = useNavigate();
  const [params, setSearchParams] = useSearchParams();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showOlder, setShowOlder] = useState<boolean>(() => readBoolFlag(SHOW_OLDER_KEY));
  const [showDeleted, setShowDeleted] = useState<boolean>(() => readBoolFlag(SHOW_DELETED_KEY));

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

  // ── ALL HOOKS ABOVE THE EARLY RETURN (rules of hooks) ─────────────────
  // Permanent-delete confirmation state for the Recently Deleted section.
  // Two modes: "single" deletes one soft-deleted doc; "all" wipes the
  // entire bucket. Both require explicit confirmation — no toast undo
  // (this is irreversible, opposite of the soft delete's 6-second
  // optimistic undo).
  //
  // CRITICAL: this `useState` MUST live above the `if (!open) return null`
  // below. Previously placed after the early return, it produced
  // "Rendered fewer/more hooks than expected" the first time the panel
  // toggled open — the closed render skipped the hook and the open
  // render included it.
  const [confirmPermanent, setConfirmPermanent] = useState<
    | { mode: "single"; id: string; name: string }
    | { mode: "all"; count: number }
    | null
  >(null);

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

  async function handlePermanentDelete(id: string) {
    const ok = await permanentDeleteDoc(id);
    if (ok) {
      toast({ title: "Permanently deleted" });
      void qc.invalidateQueries({ queryKey: ["periods-with-documents"] });
    } else {
      toast({ title: "Couldn't delete permanently", variant: "destructive" });
    }
  }

  async function handleClearAllDeleted() {
    const ok = await clearAllRecentlyDeletedDocs();
    if (ok) {
      toast({ title: "Recently deleted cleared" });
      void qc.invalidateQueries({ queryKey: ["periods-with-documents"] });
    } else {
      toast({ title: "Couldn't clear", variant: "destructive" });
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

        <div className="flex-1 overflow-y-auto overscroll-contain px-3 py-4 space-y-5">
          {isLoading && (
            <div className="text-center py-8 text-[12px] text-ink-mute">
              <Loader2 size={14} className="inline animate-spin mr-1" />
              Loading documents…
            </div>
          )}

          {/* Active period — hero card. Sticky so it stays in view as the
              user scrolls older periods. Filter to non-empty periods only
              (Step 5 defense — empty periods should never reach the UI). */}
          {activePeriod && activePeriod.documents.length > 0 && (
            <section data-testid="docs-panel-section-active" className="sticky top-0 z-10 -mx-3 px-3 pb-3 bg-surface/85 backdrop-blur-xl">
              <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-2">Active period</div>
              <PeriodCard
                period={activePeriod}
                isActive
                isCurrent={currentPeriodInUrl === activePeriod.period_id}
              />
            </section>
          )}

          {/* Other periods — compact one-liner cards, collapsible after 3 */}
          {otherPeriods.filter((p) => p.documents.length > 0).length > 0 && (
            <section data-testid="docs-panel-section-others">
              <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-2">
                Other periods
              </div>
              <div className="space-y-2">
                {otherPeriods
                  .filter((p) => p.documents.length > 0)
                  .slice(0, showOlder ? undefined : OTHER_PERIODS_VISIBLE_DEFAULT)
                  .map((p) => (
                    <OtherPeriodRow
                      key={p.period_id}
                      period={p}
                      isCurrent={currentPeriodInUrl === p.period_id}
                      onSwitch={() => switchTo(p.period_id)}
                      onQuickDelete={async () => {
                        const ids = await softDeletePeriodDocs(p);
                        if (ids.length === 0) return;
                        void qc.invalidateQueries({ queryKey: ["periods-with-documents"] });
                        toast({
                          title: `Deleted ${p.period_end ? new Date(p.period_end).toLocaleDateString("en-GB", { dateStyle: "medium" }) : "period"}`,
                          description: `${ids.length} ${ids.length === 1 ? "document" : "documents"} moved to Recently deleted.`,
                          duration: 6_000,
                          action: (
                            <ToastAction
                              altText="Undo delete"
                              data-testid="undo-toast-action"
                              onClick={async () => {
                                await restoreMany(ids);
                                void qc.invalidateQueries({ queryKey: ["periods-with-documents"] });
                                toast({ title: "Restored" });
                              }}
                            >
                              Undo
                            </ToastAction>
                          ),
                        });
                      }}
                    />
                  ))}
              </div>
              {otherPeriods.filter((p) => p.documents.length > 0).length > OTHER_PERIODS_VISIBLE_DEFAULT && (
                <button
                  type="button"
                  data-testid="docs-panel-show-older"
                  onClick={() => {
                    const next = !showOlder;
                    setShowOlder(next);
                    writeBoolFlag(SHOW_OLDER_KEY, next);
                  }}
                  className="mt-2 inline-flex items-center gap-1 text-[11.5px] text-ink-mute hover:text-ink"
                >
                  <ChevronRight
                    size={11}
                    strokeWidth={2}
                    className={`transition-transform ${showOlder ? "rotate-90" : ""}`}
                  />
                  {showOlder
                    ? `Hide ${otherPeriods.filter((p) => p.documents.length > 0).length - OTHER_PERIODS_VISIBLE_DEFAULT} older periods`
                    : `Show ${otherPeriods.filter((p) => p.documents.length > 0).length - OTHER_PERIODS_VISIBLE_DEFAULT} older periods`}
                </button>
              )}
            </section>
          )}

          {/* Recently deleted — collapsed by default, tap to expand. */}
          {recentlyDeleted.length > 0 && (
            <section data-testid="docs-panel-section-deleted">
              <div className="flex items-center justify-between gap-2 mb-2">
                <button
                  type="button"
                  data-testid="recently-deleted-toggle"
                  onClick={() => {
                    const next = !showDeleted;
                    setShowDeleted(next);
                    writeBoolFlag(SHOW_DELETED_KEY, next);
                  }}
                  className="flex-1 flex items-center justify-between text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium hover:text-ink"
                >
                  <span>Recently deleted ({recentlyDeleted.length}) · auto-delete in 28 days</span>
                  <ChevronRight
                    size={11}
                    strokeWidth={2}
                    className={`transition-transform ${showDeleted ? "rotate-90" : ""}`}
                  />
                </button>
                {showDeleted && (
                  <button
                    type="button"
                    data-testid="recently-deleted-clear-all"
                    onClick={() => setConfirmPermanent({ mode: "all", count: recentlyDeleted.length })}
                    className="text-[10.5px] font-medium text-[hsl(var(--alert))] hover:text-[hsl(var(--alert-d,var(--alert)))] hover:bg-alert-tint px-2 py-1 rounded transition-colors"
                  >
                    Clear all
                  </button>
                )}
              </div>
              {showDeleted && (
                <ul data-testid="recently-deleted-list" className="space-y-1.5">
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
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          aria-label={`Restore ${d.display_name}`}
                          title="Restore"
                          onClick={() => void handleRestore(d.id)}
                          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-brand-d hover:text-brand hover:bg-bg-2 px-2 py-1 rounded transition-colors"
                        >
                          <RotateCcw size={12} strokeWidth={1.75} />
                          <span>Restore</span>
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${d.display_name} permanently`}
                          title="Delete permanently — cannot be undone"
                          data-testid={`recently-deleted-permanent-${d.id}`}
                          onClick={() =>
                            setConfirmPermanent({ mode: "single", id: d.id, name: d.display_name })
                          }
                          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[hsl(var(--alert))] hover:text-[hsl(var(--alert-d,var(--alert)))] hover:bg-alert-tint px-2 py-1 rounded transition-colors"
                        >
                          <Trash2 size={12} strokeWidth={1.75} />
                          <span>Delete forever</span>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* Confirmation dialog for permanent delete (single OR clear-all).
              Destructive tone: confirm button is red, no toast undo, the
              action removes the underlying storage blob + DB row. */}
          <AlertDialog
            open={confirmPermanent !== null}
            onOpenChange={(open) => { if (!open) setConfirmPermanent(null); }}
          >
            <AlertDialogContent data-testid="permanent-delete-dialog">
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {confirmPermanent?.mode === "single"
                    ? "Delete this file permanently?"
                    : confirmPermanent?.mode === "all"
                      ? `Permanently delete all ${confirmPermanent.count} file${confirmPermanent.count === 1 ? "" : "s"}?`
                      : "Delete permanently?"}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {confirmPermanent?.mode === "single" ? (
                    <>
                      "<span className="font-medium text-ink">{confirmPermanent.name}</span>" will be permanently deleted. This cannot be undone.
                    </>
                  ) : confirmPermanent?.mode === "all" ? (
                    <>
                      All {confirmPermanent.count} file{confirmPermanent.count === 1 ? "" : "s"} in Recently Deleted will be permanently removed from storage. This cannot be undone.
                    </>
                  ) : null}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setConfirmPermanent(null)}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  data-testid="permanent-delete-confirm"
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
                  {confirmPermanent?.mode === "single" ? "Delete forever" : "Delete all forever"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {data &&
            (!activePeriod || activePeriod.documents.length === 0) &&
            otherPeriods.filter((p) => p.documents.length > 0).length === 0 && (
              <div className="text-center py-12">
                <FileText size={28} className="mx-auto text-ink-mute mb-2" strokeWidth={1.5} />
                <p className="text-[13px] text-ink-soft">No documents yet.</p>
                <p className="text-[11.5px] text-ink-mute mt-1">
                  Upload from the dashboard to populate this list.
                </p>
              </div>
            )}
        </div>
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
              <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.06em] font-semibold text-[hsl(var(--success))] px-1.5 py-0.5 rounded-full bg-success-tint">
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

// ─── OtherPeriodRow — compact one-liner for non-active periods ──────────

function OtherPeriodRow({
  period,
  isCurrent,
  onSwitch,
  onQuickDelete,
}: {
  period: PeriodRow;
  isCurrent: boolean;
  onSwitch: () => void;
  onQuickDelete: () => void;
}) {
  const label = period.period_end
    ? new Date(period.period_end).toLocaleDateString("en-GB", { dateStyle: "medium" })
    : period.period_label;
  const topDoc = period.documents.find((d) => d.is_active) ?? period.documents[0];
  const ring = isCurrent
    ? "border-brand bg-brand/[0.06]"
    : "border-rule bg-bg-2/30 hover:border-rule-strong hover:bg-bg-2/70";

  return (
    <div
      data-testid="other-period-card"
      className={`group relative rounded-xl border ${ring} transition-colors`}
    >
      {/* Quick delete — visible on hover/focus. Single click → soft-delete +
          undo toast. No confirmation dialog (Apple "Move to Bin" pattern). */}
      <button
        type="button"
        data-testid="quick-delete"
        aria-label={`Delete ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          onQuickDelete();
        }}
        className="absolute top-1.5 right-1.5 p-1 rounded-md text-ink-mute opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-red-700 hover:bg-bg-2 transition-opacity"
      >
        <Trash2 size={11} strokeWidth={1.75} />
      </button>

      {/* Whole-card click switches periods. The visible "Switch →" is the
          affordance, but the user doesn't need to hit it exactly. */}
      <button
        type="button"
        onClick={onSwitch}
        data-testid="any-period-card"
        className="w-full text-left px-3.5 py-2.5"
      >
        <div className="flex items-center gap-2">
          <span className="font-serif text-[13.5px] text-ink leading-tight">{label}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <div className="min-w-0 flex items-center gap-1.5 text-[11px] text-ink-mute">
            <FileText size={10} strokeWidth={1.75} className="shrink-0" />
            <span className="truncate">{topDoc?.display_name ?? topDoc?.original_filename ?? "—"}</span>
            {topDoc && (
              <span className="shrink-0 text-ink-mute/80">· {relativeTime(topDoc.uploaded_at)}</span>
            )}
          </div>
          <span className="shrink-0 text-[11px] text-ink-soft group-hover:text-ink transition-colors">
            Switch →
          </span>
        </div>
      </button>
    </div>
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
        <span className={`text-[9.5px] uppercase tracking-[0.06em] font-medium shrink-0 ${doc.status === "failed" ? "text-red-700" : "text-[#2AA89B]"}`}>
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
