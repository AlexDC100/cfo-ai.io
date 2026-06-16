// SKU Detail Drawer — right-side slide-out triggered by clicking a row in the
// Products table. Renders the engine-classified per-SKU economics (real margin
// breakdown, KPI grid, rationale) and lets the operator either approve the
// eliminate signal or override it as a strategic keeper. The override is
// persisted to `sku_aggregates.user_override` via PATCH so the classification
// chip can reflect the human-in-the-loop decision on reload.
//
// Layout mirrors `DatasetsPanel.tsx`: fixed-position aside + backdrop +
// slide-in-from-right animation, so the page chrome (top header, sidebar)
// stays interactive while the drawer is open.

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Loader2, X } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getSupabase } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";
import { Money } from "@/components/ui/Money";
import { useCurrency } from "@/stores/currency";
import { formatMoneyFrom } from "@/lib/money";
import type { Currency } from "@/lib/rates";
// F5.0 Phase 8 — Products / SKU learning. The drawer's per-metric
// labels become learnable: clicking a label opens its concept popover
// (real_margin, allocated_sga, capital_cost_on_inventory, etc.). The
// numeric values stay rendered exactly as before — the popover is
// triggered by label clicks, never by clicks on the underlying numbers,
// so the override / approve buttons keep their full hit-area.
import { LearnableRowLabel } from "@/components/learning/LearnableRowLabel";

type Classification =
  | "anchor" | "anchor_alert" | "keep" | "watch"
  | "eliminate" | "wind_down" | "scale";

export interface SkuDetail {
  id: string;
  product_name: string;
  brand: string | null;
  category: string | null;
  volume_tons: number | null;
  niv_krn: number | null;
  gm_krn: number | null;
  gm_pct: number | null;
  real_margin_krn: number | null;
  real_margin_pct: number | null;
  days_inventory_on_hand: number | null;
  inventory_value_krn: number | null;
  classification: Classification;
  classification_reason: string | null;
  channels_present: string[] | null;
  clients_present: string[] | null;
  line_row_count: number | null;
  user_override: string | null;
}

interface Props {
  sku: SkuDetail | null;
  onClose: () => void;
  /** Total category NIV — used to compute "Category share". Optional;
   *  when omitted the share row is hidden rather than guessing 0. */
  categoryNivTotal?: number | null;
  /** Active dataset id — invalidate the SKUs query after a decision. */
  datasetId: string | null;
  /** CUR-FIX-D — source currency for kRON-style money values. The drawer
   *  inherits its parent's source currency (Products page → useActivePeriod)
   *  so the real-margin card, breakdown rows, and KPI tiles all convert
   *  live when TopHeader's currency toggle flips. Defaults to RON. */
  currency?: Currency;
}

const STATUS_META: Record<Classification, { label: string; tone: string; dot: string }> = {
  eliminate:    { label: "ELIMINATE",     tone: "bg-alert-tint text-[hsl(var(--alert))] border-[hsl(var(--alert)/0.3)]",                                       dot: "bg-[hsl(var(--alert))]" },
  wind_down:    { label: "WIND DOWN",     tone: "bg-[hsl(var(--warning-2-tint))] text-[hsl(var(--warning-2))] border-[hsl(var(--warning-2)/0.3)]",             dot: "bg-[hsl(var(--warning-2))]" },
  watch:        { label: "WATCH",         tone: "bg-[hsl(var(--warning-2-tint))]/70 text-[hsl(var(--warning-2))] border-[hsl(var(--warning-2)/0.25)]",        dot: "bg-[hsl(var(--warning-2))]" },
  keep:         { label: "KEEP",          tone: "bg-bg-2 text-ink-soft border-rule",                                                                            dot: "bg-ink-mute" },
  anchor_alert: { label: "ANCHOR — ALERT", tone: "bg-[hsl(var(--warning-2-tint))] text-[hsl(var(--warning-2))] border-[hsl(var(--warning-2)/0.3)]",            dot: "bg-[hsl(var(--warning-2))]" },
  scale:        { label: "SCALE",         tone: "bg-info-tint text-[hsl(var(--info))] border-[hsl(var(--info)/0.3)]",                                          dot: "bg-[hsl(var(--info))]" },
  anchor:       { label: "ANCHOR",        tone: "bg-success-tint text-[hsl(var(--success))] border-[hsl(var(--success)/0.3)]",                                 dot: "bg-[hsl(var(--success))]" },
};

const OVERRIDE_META: Record<string, { label: string; tone: string }> = {
  eliminate_approved: {
    label: "ELIMINATION APPROVED",
    tone: "bg-red-50 text-red-800 border-red-200",
  },
  strategic_override: {
    label: "MARKED STRATEGIC (override)",
    tone: "bg-emerald-50 text-emerald-800 border-emerald-200",
  },
};

// CUR-FIX-D — the legacy `fmtKron(n)` plain string helper has been
// replaced by the currency-aware `useKronFormatter` hook below + inline
// <Money> components. Kept this comment for the next reader: don't add
// a hard-coded RON formatter back here; reach for `useKronFormatter` or
// <Money fromCurrency={…} /> so the TopHeader currency toggle remains
// the single source of truth.

function fmtPct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function fmtVol(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value.toLocaleString("en-GB", { maximumFractionDigits: 1 })} t`;
}

// Allocated SG&A and capital cost aren't stored as their own columns — the
// engine subtracts them inside `compute_real_margin` and only persists the
// real_margin total. We reconstruct each component here so the drawer can
// show the operator WHY real_margin < gross_margin without round-tripping
// the engine. Numbers will round-trip with ±0.5 kRON because the persisted
// values are themselves rounded.
function deriveBreakdown(s: SkuDetail): {
  gross_margin: number | null;
  capital_cost: number | null;
  capital_tied_up: number | null;
  allocated_sga: number | null;
} {
  const gross = s.gm_krn;
  const real = s.real_margin_krn;
  // 2026-05-25 DIO audit — was: `?? 0`. Coercing null → 0 caused two
  // separate visible bugs in the drawer breakdown card:
  //   1) `capital_tied_up = inv * 0.25` (a "25% turnover" assumption)
  //      fabricated a number from thin air when DIO was missing — shown
  //      as "on X tied up" beside the capital-cost row.
  //   2) `allocated_sga = gross − real − 0` absorbed the unknown capital
  //      cost portion, inflating SG&A and misattributing where the
  //      engine's real-margin compression actually came from.
  // Both violate the no-fabrication rule (CLAUDE.md). Now: when DIO is
  // missing we return all derived components as null so the call sites
  // render an em-dash. Honest "unknown" beats fabricated numbers.
  const dio = s.days_inventory_on_hand;
  const inv = s.inventory_value_krn;
  const hasDio = dio != null && Number.isFinite(dio) && dio > 0;
  const hasInv = inv != null && Number.isFinite(inv);

  let capital_cost: number | null = null;
  let capital_tied_up: number | null = null;
  if (hasDio && hasInv) {
    // Capital cost: 6.5% annualized on inventory tied up for DIO days.
    capital_cost = inv * 0.065 * (dio / 365);
    capital_tied_up = inv * (dio / 365);
  }

  // Allocated SG&A is the residual the engine subtracted on top of
  // capital cost to land at real_margin. We can only decompose when
  // capital_cost is known — otherwise the residual conflates SG&A and
  // capital cost into a single "combined overhead" we'd be lying about
  // by labeling it SG&A.
  let allocated_sga: number | null = null;
  if (gross !== null && real !== null && capital_cost !== null) {
    allocated_sga = gross - real - capital_cost;
  }

  return {
    gross_margin: gross,
    capital_cost,
    capital_tied_up,
    allocated_sga,
  };
}

async function authHeader(): Promise<Record<string, string> | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : null;
}

const apiBase = (): string =>
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

async function patchDecision(skuId: string, decision: string | null): Promise<boolean> {
  const h = await authHeader();
  if (!h) return false;
  const r = await fetch(`${apiBase()}/api/sku-aggregates/${skuId}/decision`, {
    method: "PATCH",
    headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify({ user_override: decision }),
  });
  return r.ok;
}

export function SkuDetailDrawer({
  sku,
  onClose,
  categoryNivTotal,
  datasetId,
  currency = "RON",
}: Props) {
  const open = !!sku;
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const qc = useQueryClient();
  const { toast } = useToast();
  // CUR-FIX-D — string-returning kRON formatter for sub-labels (the BreakdownRow
  // `sub` slot is a plain string and used inside template literals). Display
  // tiles use <Money> directly for live FX.
  const fmtKronCur = useKronFormatter(currency);

  // ESC closes; focus close button on open for a11y.
  useEffect(() => {
    if (!open) return;
    closeBtnRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const decisionMutation = useMutation({
    mutationFn: async (decision: string | null) => {
      if (!sku) return false;
      return patchDecision(sku.id, decision);
    },
    onSuccess: (ok, decision) => {
      if (!ok) {
        toast({ title: "Couldn't save decision", variant: "destructive" });
        return;
      }
      toast({
        title: decision === "eliminate_approved"
          ? "Elimination approved"
          : decision === "strategic_override"
            ? "Marked as strategic"
            : "Decision cleared",
      });
      void qc.invalidateQueries({ queryKey: ["sales-dataset", datasetId] });
      onClose();
    },
    onError: () => {
      toast({ title: "Couldn't save decision", variant: "destructive" });
    },
  });

  if (!open || !sku) return null;

  const status = STATUS_META[sku.classification];
  const override = sku.user_override ? OVERRIDE_META[sku.user_override] : null;
  const breakdown = deriveBreakdown(sku);
  const categoryShare =
    categoryNivTotal && categoryNivTotal > 0 && sku.niv_krn !== null
      ? sku.niv_krn / categoryNivTotal
      : null;

  const isEliminateBucket = sku.classification === "eliminate" || sku.classification === "wind_down";
  const saving = decisionMutation.isPending;

  return (
    <>
      <div
        data-testid="sku-drawer-backdrop"
        onClick={onClose}
        aria-hidden
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
      />
      <aside
        data-testid="sku-detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sku-drawer-title"
        style={{
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
        className="
          fixed right-0 top-0 bottom-0 z-50
          w-[100vw] sm:w-[92vw] sm:max-w-[520px]
          bg-surface border-l border-rule shadow-2xl
          flex flex-col
          motion-safe:animate-in motion-safe:slide-in-from-right
          motion-safe:duration-200 motion-safe:ease-out
        "
      >
        <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-rule">
          <div className="min-w-0">
            <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">
              SKU detail
            </div>
            <h2
              id="sku-drawer-title"
              className="font-serif text-[22px] text-ink leading-tight mt-1 break-words"
            >
              {sku.product_name}
            </h2>
            <p className="text-[12px] text-ink-mute mt-1">
              {[sku.brand, sku.category].filter(Boolean).join(" · ") || "No brand or category"}
            </p>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="text-ink-mute hover:text-ink p-1 rounded-md hover:bg-bg-2 transition-colors shrink-0"
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-5 space-y-5">
          {/* Status / override badges — Phase 8: SKU classification badge
              becomes a learnable trigger, opening the sku_classification
              concept (engine bucket logic + override mechanics). Wrapping
              the inner content as a button keeps the visual identical. */}
          <div className="flex items-center gap-2 flex-wrap">
            <span
              data-testid="sku-drawer-status-badge"
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10.5px] uppercase tracking-[0.08em] font-semibold ${status.tone}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
              <LearnableRowLabel
                conceptKey="sku_classification"
                value={0}
                data-testid="sku-drawer-status-learn"
              >
                {status.label}
              </LearnableRowLabel>
            </span>
            {override && (
              <span
                data-testid="sku-drawer-override-badge"
                className={`inline-flex items-center px-2.5 py-1 rounded-full border text-[10.5px] uppercase tracking-[0.08em] font-semibold ${override.tone}`}
              >
                {override.label}
              </span>
            )}
          </div>

          {/* Real margin breakdown card */}
          <section
            data-testid="sku-drawer-margin-card"
            className="rounded-2xl border border-rule bg-bg-2/40 p-5"
          >
            <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">
              <LearnableRowLabel
                conceptKey="real_margin"
                value={sku.real_margin_krn ?? 0}
                data-testid="sku-drawer-real-margin-label"
              >
                Real margin
              </LearnableRowLabel>
            </div>
            <div
              className={`mt-2 font-serif num-hero-fluid-lg leading-none tabular-nums break-words ${
                (sku.real_margin_krn ?? 0) < 0 ? "text-red-700" : "text-ink"
              }`}
            >
              {sku.real_margin_krn !== null && sku.real_margin_krn !== undefined ? (
                <Money
                  value={sku.real_margin_krn * 1000}
                  fromCurrency={currency}
                  compact
                />
              ) : (
                "—"
              )}
            </div>
            <div className="text-[12px] text-ink-mute mt-1">
              {fmtPct(sku.real_margin_pct)} of revenue (after SG&A and cost of capital)
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 text-[12.5px]">
              <BreakdownRow
                conceptKey="gross_margin"
                label="Gross margin"
                value={
                  breakdown.gross_margin !== null
                    ? <Money value={breakdown.gross_margin * 1000} fromCurrency={currency} compact />
                    : "—"
                }
                sub={fmtPct(sku.gm_pct)}
              />
              {/* 2026-05-25 DIO audit — when DIO is missing the engine
                  computes real_margin without a capital-cost term, so
                  SG&A = gross − real conflates SG&A + capital cost. We
                  refuse to mislabel that as SG&A and show em-dash + a
                  "data missing" sub-note instead. */}
              <BreakdownRow
                conceptKey="allocated_sga"
                label="Allocated SG&A"
                value={
                  breakdown.allocated_sga !== null
                    ? <Money value={breakdown.allocated_sga * 1000} fromCurrency={currency} compact />
                    : "—"
                }
                sub={
                  breakdown.allocated_sga !== null
                    ? "proportional to revenue"
                    : "needs DIO to decompose"
                }
              />
              <BreakdownRow
                conceptKey="dio_days"
                label="DIO"
                value={sku.days_inventory_on_hand !== null
                  ? `${sku.days_inventory_on_hand.toLocaleString("en-GB", { maximumFractionDigits: 0 })} days`
                  : "—"}
                sub="days inventory on hand"
              />
              <BreakdownRow
                conceptKey="capital_cost_on_inventory"
                label="Capital cost (6.5% / yr)"
                value={
                  breakdown.capital_cost !== null
                    ? <Money value={breakdown.capital_cost * 1000} fromCurrency={currency} compact />
                    : "—"
                }
                sub={
                  breakdown.capital_tied_up !== null
                    ? `on ${fmtKronCur(breakdown.capital_tied_up)} tied up`
                    : "inventory turnover unknown"
                }
              />
            </dl>
          </section>

          {/* KPI grid — Phase 8 wired to per-KPI concepts. Volume has no
              dedicated concept (it's a raw physical input); the other
              three KPIs route to niv_revenue, absolute_profit_sku, and
              category_share. */}
          <section className="grid grid-cols-2 gap-3">
            <KpiTile label="Volume" value={fmtVol(sku.volume_tons)} />
            <KpiTile
              conceptKey="niv_revenue"
              label="NIV revenue"
              value={<Money value={(sku.niv_krn ?? 0) * 1000} fromCurrency={currency} compact />}
            />
            <KpiTile
              conceptKey="absolute_profit_sku"
              label="Absolute profit"
              value={<Money value={(sku.gm_krn ?? 0) * 1000} fromCurrency={currency} compact signed />}
              tone={(sku.gm_krn ?? 0) < 0 ? "negative" : undefined}
            />
            <KpiTile
              conceptKey="category_share"
              label="Category share"
              value={categoryShare !== null ? fmtPct(categoryShare) : "—"}
            />
          </section>

          {/* Rationale */}
          {sku.classification_reason && (
            <section
              data-testid="sku-drawer-rationale"
              className="rounded-2xl border border-rule bg-surface p-5"
            >
              <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">
                Why this decision
              </div>
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink-soft">
                {sku.classification_reason}
              </p>
            </section>
          )}

          {/* Channel / client presence */}
          {(sku.channels_present?.length || sku.clients_present?.length) ? (
            <section className="grid grid-cols-2 gap-3 text-[12px]">
              <PresenceList label="Channels" items={sku.channels_present} />
              <PresenceList label="Clients" items={sku.clients_present} />
            </section>
          ) : null}
        </div>

        {/* Footer actions — only meaningful for the eliminate/wind_down
            buckets where a binary "approve cut vs strategic keep" decision
            makes sense. For other buckets we still let the operator clear an
            existing override. */}
        <footer className="border-t border-rule px-5 py-4 space-y-2">
          {isEliminateBucket ? (
            <>
              <button
                type="button"
                data-testid="sku-drawer-approve-eliminate"
                disabled={saving || sku.user_override === "eliminate_approved"}
                onClick={() => decisionMutation.mutate("eliminate_approved")}
                className="w-full h-10 rounded-lg bg-red-700 text-white text-[13px] font-medium hover:bg-red-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : null}
                {sku.user_override === "eliminate_approved" ? "Elimination approved" : "Approve elimination"}
              </button>
              <button
                type="button"
                data-testid="sku-drawer-strategic-override"
                disabled={saving || sku.user_override === "strategic_override"}
                onClick={() => decisionMutation.mutate("strategic_override")}
                className="w-full h-10 rounded-lg border border-rule bg-surface text-[13px] font-medium text-ink hover:bg-bg-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : null}
                {sku.user_override === "strategic_override"
                  ? "Marked as strategic"
                  : "Override · mark as strategic"}
              </button>
            </>
          ) : (
            <p className="text-[12px] text-ink-mute text-center py-2">
              No decision needed — the “{status.label.toLowerCase()}” bucket doesn't require action.
            </p>
          )}
          {sku.user_override && (
            <button
              type="button"
              data-testid="sku-drawer-clear-override"
              disabled={saving}
              onClick={() => decisionMutation.mutate(null)}
              className="w-full h-8 text-[11.5px] text-ink-mute hover:text-ink transition-colors"
            >
              Clear decision
            </button>
          )}
        </footer>
      </aside>
    </>
  );
}

// F5.0 Phase 8 — the `conceptKey` prop makes the dt LABEL clickable: it
// opens the concept popover for that row. Defensive default: if no
// conceptKey is passed, the label renders as a plain <dt> exactly like
// the pre-Phase-8 layout (no regression for rows where no concept exists
// yet). The dd value cell stays untouched — clicking a number doesn't
// open the popover, only clicking the label does, matching the BS-row
// pattern from Wave 3.
function BreakdownRow({
  label,
  value,
  sub,
  conceptKey,
  "data-testid": testId,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  conceptKey?: string;
  "data-testid"?: string;
}) {
  const labelEl = conceptKey ? (
    <LearnableRowLabel
      conceptKey={conceptKey}
      value={0}
      data-testid={testId ?? `sku-drawer-row-label-${conceptKey}`}
    >
      {label}
    </LearnableRowLabel>
  ) : (
    label
  );
  return (
    <div>
      <dt className="text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium">
        {labelEl}
      </dt>
      <dd className="mt-0.5 text-ink tabular-nums">{value}</dd>
      {sub && <dd className="text-[10.5px] text-ink-mute mt-0.5">{sub}</dd>}
    </div>
  );
}

function KpiTile({
  label,
  value,
  tone,
  conceptKey,
  "data-testid": testId,
}: {
  label: string;
  value: ReactNode;
  tone?: "negative";
  conceptKey?: string;
  "data-testid"?: string;
}) {
  const labelEl = conceptKey ? (
    <LearnableRowLabel
      conceptKey={conceptKey}
      value={0}
      data-testid={testId ?? `sku-drawer-kpi-label-${conceptKey}`}
    >
      {label}
    </LearnableRowLabel>
  ) : (
    label
  );
  // FIT-1 (2026-06-08) — `min-w-0 overflow-hidden` + fluid hero font
  // keep long NIV / Absolute Profit money strings inside the 2-col KPI
  // grid even on a 390 px mobile drawer.
  return (
    <div className="rounded-xl border border-rule bg-surface p-3.5 min-w-0 overflow-hidden">
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium truncate">
        {labelEl}
      </div>
      <div
        className={`mt-1.5 font-serif num-hero-fluid-sm tabular-nums leading-none break-words ${
          tone === "negative" ? "text-red-700" : "text-ink"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * CUR-FIX-D — same shape as the helper in Products.tsx: SKU values are
 * persisted as thousands of the source currency (kRON/kEUR/kUSD); this
 * formatter scales ×1000 then runs the result through `formatMoneyFrom`
 * so a single TopHeader toggle flips every drawer surface live. Returns
 * a string for callers that need it inside template literals (sub-labels).
 */
function useKronFormatter(fromCurrency: Currency | string) {
  const { display, rates } = useCurrency();
  return useMemo(() => {
    const src = (fromCurrency as Currency) || "RON";
    return (krn: number): string =>
      formatMoneyFrom(krn * 1000, src, display, rates.rates, { compact: true });
  }, [fromCurrency, display, rates]);
}

function PresenceList({ label, items }: { label: string; items: string[] | null }) {
  return (
    <div className="rounded-xl border border-rule bg-surface p-3.5">
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-1.5">{label}</div>
      {items && items.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {items.map((i) => (
            <span key={i} className="inline-flex items-center px-1.5 py-0.5 rounded bg-bg-2 border border-rule text-[10.5px] text-ink-soft">
              {i}
            </span>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-ink-mute">—</div>
      )}
    </div>
  );
}
