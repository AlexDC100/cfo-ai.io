// IndustryConfirmModal — first-time industry confirmation flow.
//
// ──────────────────────────────────────────────────────────────────────
// ⚠️  PHASE F — DEPRECATED, scheduled for removal post-backfill.       ⚠️
// ──────────────────────────────────────────────────────────────────────
// All explicit "change industry" entry points (header button, mismatch
// banner CTA, inline pencil) now open `<IndustryPicker />` from
// `@/components/cfo/industry/IndustryPicker.tsx`, which writes to the
// new per-period `company_industry_assignments` table and triggers the
// audit-log + benchmark-cache-bust flow.
//
// This legacy modal is RETAINED for ONE remaining purpose:
//   the BenchmarkReport's `caen_not_set` first-time gate — until the
//   Phase F backfill (`engine.api.seed.backfill_industry_assignments`)
//   has run on production and the gate is wired to open IndustryPicker
//   instead. After that, this file becomes dead code and can be
//   deleted along with the legacy `POST /api/benchmarks/set-caen`
//   route in `_benchmarks.py`.
//
// DO NOT add new callers. New entry points use `<IndustryPicker />`.
//
// Legacy endpoints driven by this modal (also slated for removal):
//   GET  /api/benchmarks/suggest/{period_id}
//   GET  /api/benchmarks/available-industries
//   POST /api/benchmarks/set-caen
//
// Confidence-aware UX: a high-confidence suggestion (≥0.5) is pre-
// selected; ambiguous matches still appear but the dropdown is the
// primary affordance so the user clearly owns the classification.
//
// Uses the same fixed-right-side panel pattern as DatasetsPanel so
// it composes with the existing AppShell shell. Backdrop + ESC close
// + first-focus on the close button for a11y.

import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { getSupabase } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";
import { SITE } from "@/config/site";

interface Industry {
  caen_code: string;
  caen_label: string;
  industry_category: string;
}

interface Suggestion {
  caen: string | null;
  label: string | null;
  confidence: number;
}

interface Props {
  periodId: string;
  open: boolean;
  onClose: () => void;
  onConfirmed: () => void;
  /** When provided, the modal renders in "reclassification" mode:
   *  title changes to "Change industry", the current CAEN is shown
   *  in a banner, the dropdown is pre-selected to it, and the save
   *  button stays disabled until the user picks a DIFFERENT CAEN.
   *  When omitted (first-time classification flow), behaviour is
   *  unchanged — suggestion-driven pre-select. */
  currentCaen?: string | null;
}

const apiBase = (): string =>
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

async function authHeaders(): Promise<Record<string, string> | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : null;
}

/** @deprecated Phase F — use `<IndustryPicker />` from `@/components/cfo/industry`.
 *  This component is retained only for the `caen_not_set` first-time gate
 *  in BenchmarkReport.tsx until the Phase F backfill completes. */
export function IndustryConfirmModal({ periodId, open, onClose, onConfirmed, currentCaen }: Props) {
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [industries, setIndustries] = useState<Industry[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const h = await authHeaders();
      if (!h) {
        if (!cancelled) setLoading(false);
        return;
      }
      try {
        const [sugRes, indRes] = await Promise.all([
          fetch(`${apiBase()}/api/benchmarks/suggest/${periodId}`, { headers: h }),
          fetch(`${apiBase()}/api/benchmarks/available-industries`, { headers: h }),
        ]);
        const sug = sugRes.ok
          ? ((await sugRes.json()) as { suggested_caen: string | null; suggested_label: string | null; confidence: number })
          : { suggested_caen: null, suggested_label: null, confidence: 0 };
        const inds = indRes.ok ? ((await indRes.json()) as Industry[]) : [];
        if (cancelled) return;
        setSuggestion({ caen: sug.suggested_caen, label: sug.suggested_label, confidence: sug.confidence });
        setIndustries(inds);
        // Reclassification mode: pre-select the CURRENT caen so the user
        // sees what's set and the save button stays disabled until they
        // pick something different. First-time mode: fall back to the
        // auto-suggestion when confidence is decent.
        if (currentCaen) {
          setSelected(currentCaen);
        } else if (sug.suggested_caen && sug.confidence >= 0.5) {
          setSelected(sug.suggested_caen);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, periodId, currentCaen]);

  const handleConfirm = async () => {
    if (!selected) return;
    setSaving(true);
    const h = await authHeaders();
    if (!h) {
      setSaving(false);
      toast({ title: "Not signed in", variant: "destructive" });
      return;
    }
    try {
      const r = await fetch(`${apiBase()}/api/benchmarks/set-caen`, {
        method: "POST",
        headers: { ...h, "Content-Type": "application/json" },
        body: JSON.stringify({ caen_code: selected }),
      });
      if (!r.ok) {
        toast({ title: "Couldn't save industry classification", variant: "destructive" });
        return;
      }
      toast({ title: "Industry confirmed" });
      onConfirmed();
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <div
        data-testid="industry-modal-backdrop"
        onClick={onClose}
        aria-hidden
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
      />
      <aside
        data-testid="industry-confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="industry-modal-title"
        style={{
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
        className="
          fixed right-0 top-0 bottom-0 z-50
          w-[100vw] sm:w-[92vw] sm:max-w-[480px]
          bg-surface border-l border-rule shadow-2xl
          flex flex-col
          motion-safe:animate-in motion-safe:slide-in-from-right
          motion-safe:duration-200 motion-safe:ease-out
        "
      >
        <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-rule">
          <div className="min-w-0">
            <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">
              Industry classification
            </div>
            <h2 id="industry-modal-title" className="font-serif text-[22px] text-ink leading-tight mt-1">
              {currentCaen ? "Change industry" : "Confirm your CAEN code"}
            </h2>
            <p className="text-[12px] text-ink-mute mt-1">
              {currentCaen
                ? "Select a different industry to recalculate the benchmarks."
                : "We use this to compare your numbers against industry-typical values."}
            </p>
            {currentCaen && (
              <div
                data-testid="industry-modal-current-banner"
                className="mt-2.5 inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50/60 dark:bg-blue-500/[0.08] px-2.5 py-1 text-[12px] text-blue-800 dark:text-blue-200"
              >
                Current industry:&nbsp;<strong className="font-semibold">CAEN {currentCaen}</strong>
              </div>
            )}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="text-ink-mute hover:text-ink p-1 rounded-md hover:bg-bg-2 transition-colors shrink-0"
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {loading && (
            <div className="text-center py-8 text-[13px] text-ink-mute">
              <Loader2 size={16} className="inline animate-spin mr-1.5" />
              Loading suggestions…
            </div>
          )}

          {!loading && suggestion?.caen && (
            <section
              data-testid="industry-suggestion"
              className="rounded-xl border border-emerald-300/40 bg-emerald-50/30 dark:bg-emerald-500/[0.06] p-4"
            >
              <div className="text-[10.5px] uppercase tracking-[0.1em] text-emerald-700 dark:text-emerald-400 font-medium">
                Auto-suggestion · {Math.round(suggestion.confidence * 100)}% confidence
              </div>
              <div className="mt-1.5 font-medium text-ink">
                {suggestion.caen} — {suggestion.label}
              </div>
              <p className="text-[12px] text-ink-soft mt-1.5">
                Based on the P&L cost structure of this period. Confirm below, or
                pick a different CAEN if our guess is off.
              </p>
            </section>
          )}

          {!loading && !suggestion?.caen && (
            <section className="rounded-xl border border-amber-300/50 bg-amber-50/40 dark:bg-amber-500/[0.06] p-4">
              <div className="text-[10.5px] uppercase tracking-[0.1em] text-amber-700 dark:text-amber-400 font-medium">
                No auto-suggestion
              </div>
              <p className="text-[12.5px] text-ink-soft mt-1.5">
                Your P&L shape doesn't strongly match any of the seeded
                industries. Pick the closest CAEN from the list below.
              </p>
            </section>
          )}

          <section data-testid="industry-dropdown-section">
            <label className="block text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-1.5">
              Select CAEN code
            </label>
            <select
              data-testid="industry-select"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="w-full h-10 rounded-md border border-rule bg-surface px-3 text-[13px] text-ink"
            >
              <option value="">— Choose an industry —</option>
              {industries.map((i) => (
                <option key={i.caen_code} value={i.caen_code}>
                  {i.caen_code} — {i.caen_label}
                </option>
              ))}
            </select>
            <p className="text-[11.5px] text-ink-mute mt-2 leading-relaxed">
              Your industry not on the list? Coverage is expanding —{" "}
              <a href={SITE.supportMailto} className="text-ink-soft hover:text-ink underline-offset-2 hover:underline">
                contact us
              </a>{" "}
              and we'll add it.
            </p>
          </section>
        </div>

        <footer className="border-t border-rule px-5 py-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-3 rounded-md border border-rule bg-surface text-[13px] text-ink hover:bg-bg-2 transition-colors"
          >
            {currentCaen ? "Cancel" : "Later"}
          </button>
          <button
            type="button"
            data-testid="industry-confirm-btn"
            disabled={!selected || saving || (currentCaen ? selected === currentCaen : false)}
            onClick={handleConfirm}
            className="h-9 px-4 rounded-md bg-ink text-paper text-[13px] font-medium hover:bg-ink/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : null}
            {currentCaen ? "Save change" : "Confirm industry"}
          </button>
        </footer>
      </aside>
    </>
  );
}
