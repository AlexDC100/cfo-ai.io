// DocumentSwitcher — single control that lists every analyzed document
// for the org (trial-balance periods AND public-records uploads) and
// lets the user instantly switch the displayed analysis.
//
// Reads /api/org/periods-with-documents which (post-Bug-A-prep) returns:
//   periods[]         — financial_periods with their docs (trial balance,
//                       statutory filings, annual reports)
//   public_records[]  — listafirme.ro / termene.ro / firme.info uploads
//                       (period_id = NULL by design, kind=public_records_summary)
//
// Switch semantics:
//   · Picking a period entry  → ?period=<id>  (the existing useActivePeriod
//                                              mechanism re-renders all
//                                              dashboard tiles)
//   · Picking a public-records entry → ?doc=<id>  AND if currently on
//                                       /dashboard, navigate to
//                                       /multi-year-history (that page
//                                       reads ?doc and renders the
//                                       multi-year history view)
//
// Delete semantics:
//   · Per-entry trash icon → confirm modal → DELETE /api/documents/{id}
//     (existing soft-delete endpoint; sets only THIS doc's deleted_at,
//      never touches sibling docs — that NULL-cascade is Bug A's domain
//      and we deliberately do not replicate it here)
//   · After delete: react-query invalidates the list; if the deleted
//     doc was the active one, the parent page picks the new most-recent
//     entry as the fallback.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import {
  ChevronDown, Check, FileSpreadsheet, FileText, Trash2,
  Loader2, AlertCircle, Building2,
} from "lucide-react";
import { getSupabase } from "@/lib/supabase";
import { PUBLIC_RECORDS_ENABLED } from "@/config/features";

const apiBase = (): string =>
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

// ─── Types ──────────────────────────────────────────────────────────────────

interface DocInPeriod {
  id: string;
  display_name: string;
  detected_type?: string | null;
  status: string;
  is_active: boolean;
}
interface PeriodEntry {
  period_id: string;
  period_label: string;
  period_start: string | null;
  period_end: string | null;
  is_active: boolean;
  currency: string | null;
  documents: DocInPeriod[];
  extraction_confidence: number | null;
}
interface PublicRecordEntry {
  document_id: string;
  display_name: string;
  status: string;
  detected_type?: string | null;
  created_at: string;
  company_name: string | null;
  cui: string | null;
  caen_code: string | null;
  caen_description: string | null;
  years_count: number;
  year_min: number | null;
  year_max: number | null;
  confidence: number | null;
}
interface ListPayload {
  active_period_id: string | null;
  periods: PeriodEntry[];
  public_records: PublicRecordEntry[];
}

// Normalized union — each entry is either kind=period or kind=public_record.
type SwitcherEntry =
  | {
      kind: "period";
      key: string;                  // = period_id
      title: string;                // company name fallback to period_label
      subtitle: string;             // period range + currency
      typeLabel: string;            // "Trial balance" / "Statutory" / "P&L"...
      isActive: boolean;
      sortKey: number;              // epoch ms for ordering
      documentId: string;           // primary doc on the period (for delete)
      periodId: string;
    }
  | {
      kind: "public_record";
      key: string;                  // = document_id
      title: string;                // company_name
      subtitle: string;             // "CAEN 4511 · 20 years (2005–2024)"
      typeLabel: string;            // "Public records"
      isActive: boolean;
      sortKey: number;              // upload time
      documentId: string;
      periodId: null;
    };

// ─── Fetchers ───────────────────────────────────────────────────────────────

async function authHeaders(): Promise<Record<string, string> | null> {
  const sb = getSupabase(); if (!sb) return null;
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token; if (!token) return null;
  return { Authorization: `Bearer ${token}` };
}

async function fetchList(): Promise<ListPayload | null> {
  const h = await authHeaders(); if (!h) return null;
  const r = await fetch(`${apiBase()}/api/org/periods-with-documents`, { headers: h });
  if (!r.ok) return null;
  return (await r.json()) as ListPayload;
}

async function deleteDoc(id: string): Promise<boolean> {
  const h = await authHeaders(); if (!h) return false;
  const r = await fetch(`${apiBase()}/api/documents/${id}`, { method: "DELETE", headers: h });
  return r.ok;
}

// ─── Mapper ─────────────────────────────────────────────────────────────────

function detectedTypeLabel(t?: string | null): string {
  switch (t) {
    case "trial_balance":       return "Trial balance";
    case "statutory_f30_f10":   return "Statutory";
    case "bilant":              return "Balance sheet";
    case "pl":                  return "P&L";
    case "annual_report":       return "Annual report";
    case "public_records_summary": return "Public records";
    default:                    return t ? t.replace(/_/g, " ") : "Document";
  }
}

function buildEntries(
  data: ListPayload | null,
  activePeriodId: string | null,
  activeDocId: string | null,
): SwitcherEntry[] {
  if (!data) return [];
  const out: SwitcherEntry[] = [];

  for (const p of data.periods) {
    // Pick the primary doc on this period (newest first; the panel ordered
    // documents by created_at desc).
    const primaryDoc = p.documents[0];
    if (!primaryDoc) continue;
    const periodEnd = p.period_end ?? "?";
    const subtitle = [periodEnd, p.currency || "RON"].filter(Boolean).join(" · ");
    out.push({
      kind: "period",
      key: p.period_id,
      title: primaryDoc.display_name,
      subtitle,
      typeLabel: detectedTypeLabel(primaryDoc.detected_type) || "Trial balance",
      isActive: p.period_id === activePeriodId,
      sortKey: Date.parse(p.period_end ?? "") || 0,
      documentId: primaryDoc.id,
      periodId: p.period_id,
    });
  }
  // Public-records entries gated behind PUBLIC_RECORDS_ENABLED. When the
  // flag is off, the backend may still return public_records rows (the
  // endpoint isn't gated), so we filter here at the UI boundary. Flipping
  // the flag back on instantly restores these entries.
  if (PUBLIC_RECORDS_ENABLED) for (const pr of data.public_records) {
    const yr = pr.year_min && pr.year_max
      ? (pr.year_min === pr.year_max ? `${pr.year_max}` : `${pr.year_min}–${pr.year_max}`)
      : "";
    const subtitle = [
      pr.caen_code ? `CAEN ${pr.caen_code}` : "",
      pr.cui ? `CUI ${pr.cui}` : "",
      yr ? `${pr.years_count} yrs (${yr})` : `${pr.years_count} yrs`,
    ].filter(Boolean).join(" · ");
    out.push({
      kind: "public_record",
      key: pr.document_id,
      title: pr.company_name || pr.display_name,
      subtitle,
      typeLabel: "Public records",
      isActive: pr.document_id === activeDocId,
      sortKey: Date.parse(pr.created_at) || 0,
      documentId: pr.document_id,
      periodId: null,
    });
  }
  // Newest first.
  out.sort((a, b) => b.sortKey - a.sortKey);
  return out;
}

// ─── Component ──────────────────────────────────────────────────────────────

interface Props {
  /** Optional class for parent layout. */
  className?: string;
  /** Compact mode — used in dense headers (just the trigger, no full label). */
  compact?: boolean;
}

export function DocumentSwitcher({ className, compact }: Props) {
  const [open, setOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busyDeleteId, setBusyDeleteId] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();

  const activePeriodFromUrl = params.get("period");
  const activeDocFromUrl = params.get("doc");

  const { data, isLoading } = useQuery({
    queryKey: ["periods-with-documents"],
    queryFn: fetchList,
    staleTime: 5_000,
  });

  // Active selection: URL params take precedence, fall back to backend's
  // "active period" hint.
  const activePeriodId = activePeriodFromUrl || data?.active_period_id || null;
  const entries = buildEntries(data, activePeriodId, activeDocFromUrl);
  const active = entries.find((e) => e.isActive) ?? null;

  function selectEntry(e: SwitcherEntry) {
    setOpen(false);
    if (e.kind === "period") {
      const sp = new URLSearchParams(params);
      sp.set("period", e.periodId);
      sp.delete("doc");
      setParams(sp, { replace: true });
      // If we're on multi-year-history (which is for public-records only),
      // jump to the dashboard so the period actually renders.
      if (loc.pathname === "/multi-year-history") {
        nav(`/dashboard?${sp.toString()}`);
      }
    } else {
      // Public records — navigate to multi-year-history with this doc.
      const sp = new URLSearchParams();
      sp.set("doc", e.documentId);
      nav(`/multi-year-history?${sp.toString()}`);
    }
  }

  async function confirmDelete(documentId: string) {
    setBusyDeleteId(documentId);
    const ok = await deleteDoc(documentId);
    setBusyDeleteId(null);
    setConfirmDeleteId(null);
    if (!ok) {
      // eslint-disable-next-line no-alert
      alert("Couldn't delete that document. Try again or refresh.");
      return;
    }
    void qc.invalidateQueries({ queryKey: ["periods-with-documents"] });
    void qc.invalidateQueries({ queryKey: ["public-records-latest"] });

    // If the active doc was deleted, navigate to dashboard's empty state.
    if (
      (active?.kind === "period" && active.periodId === entries.find((e) => e.documentId === documentId)?.periodId) ||
      (activeDocFromUrl === documentId)
    ) {
      const sp = new URLSearchParams(params);
      sp.delete("period");
      sp.delete("doc");
      nav(`/dashboard?${sp.toString()}`);
    }
  }

  // Empty state — render nothing rather than a confusing placeholder.
  if (!isLoading && entries.length === 0) return null;

  return (
    <div className={className} data-testid="document-switcher">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full inline-flex items-center justify-between gap-2 rounded-lg border border-rule bg-surface hover:bg-bg-2/40 px-3 py-2 text-left transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-ink-mute shrink-0" />
          ) : active?.kind === "public_record" ? (
            <Building2 className="h-4 w-4 text-ink-mute shrink-0" />
          ) : (
            <FileSpreadsheet className="h-4 w-4 text-ink-mute shrink-0" />
          )}
          <div className="min-w-0">
            <div className="text-[10.5px] uppercase tracking-[0.06em] text-ink-soft">
              {compact ? "Active" : "Active analysis"}
            </div>
            <div className="text-[13px] font-semibold text-ink truncate">
              {active ? active.title : (isLoading ? "Loading…" : "No analysis selected")}
            </div>
            {active && !compact && (
              <div className="text-[11px] text-ink-soft truncate">
                {active.typeLabel} · {active.subtitle}
              </div>
            )}
          </div>
        </div>
        <ChevronDown className={`h-4 w-4 text-ink-mute shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="relative">
          <div
            className="fixed inset-0 z-30"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute z-40 mt-1 w-full max-w-[480px] max-h-[460px] overflow-y-auto rounded-lg border border-rule bg-surface shadow-lg">
            {entries.length === 0 ? (
              <div className="p-4 text-[12.5px] text-ink-soft">
                No analyzed documents yet. Upload a trial balance or a
                listafirme.ro public-records PDF from the Dashboard.
              </div>
            ) : (
              <ul className="divide-y divide-rule/60">
                {entries.map((e) => (
                  <li key={e.key} className="flex items-stretch">
                    <button
                      type="button"
                      onClick={() => selectEntry(e)}
                      className={`flex-1 min-w-0 text-left px-3 py-2.5 hover:bg-bg-2/40 transition-colors ${
                        e.isActive ? "bg-[hsl(var(--warning-2-tint))]/50" : ""
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {e.isActive && <Check className="h-3.5 w-3.5 text-[hsl(var(--warning-2))] shrink-0" />}
                        <span className="text-[13px] font-semibold text-ink truncate">
                          {e.title}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={`inline-block text-[9.5px] uppercase tracking-[0.05em] font-semibold px-1.5 py-0.5 rounded ${
                          e.kind === "public_record"
                            ? "bg-info-tint text-[hsl(var(--info))]"
                            : "bg-success-tint text-[hsl(var(--success))]"
                        }`}>
                          {e.typeLabel}
                        </span>
                        <span className="text-[11px] text-ink-soft truncate">
                          {e.subtitle}
                        </span>
                      </div>
                    </button>
                    <button
                      type="button"
                      title="Remove this analysis"
                      data-testid={`delete-${e.kind}-${e.documentId}`}
                      onClick={(ev) => { ev.stopPropagation(); setConfirmDeleteId(e.documentId); }}
                      className="px-3 hover:bg-alert-tint/60 text-ink-mute hover:text-[hsl(var(--alert))] transition-colors flex items-center"
                    >
                      {busyDeleteId === e.documentId
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Trash2 className="h-3.5 w-3.5" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Confirmation modal — single-doc soft-delete, restorable. */}
      {confirmDeleteId && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
          onClick={() => setConfirmDeleteId(null)}
        >
          <div
            className="bg-surface rounded-lg shadow-xl border border-rule max-w-md w-full p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-3">
              <div className="h-9 w-9 rounded-full bg-[hsl(var(--warning-2-tint))] text-[hsl(var(--warning-2))] flex items-center justify-center shrink-0">
                <AlertCircle className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-serif text-[18px] text-ink leading-tight">
                  Remove this analysis?
                </h3>
                <p className="text-[12.5px] text-ink-soft mt-1">
                  Hides it from the dashboard and switcher. Restorable from the
                  Recently Deleted shelf for 30 days. Sibling analyses are not
                  affected.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={() => setConfirmDeleteId(null)}
                className="h-9 px-3 rounded-md border border-rule text-[12.5px] font-medium text-ink hover:bg-bg-2 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { void confirmDelete(confirmDeleteId); }}
                disabled={busyDeleteId === confirmDeleteId}
                data-testid="confirm-delete-doc"
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-red-600 hover:bg-red-700 text-white text-[12.5px] font-medium disabled:opacity-60 transition-colors"
              >
                {busyDeleteId === confirmDeleteId
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Removing…</>
                  : <><Trash2 className="h-3.5 w-3.5" />Remove</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
