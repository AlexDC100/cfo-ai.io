// Peer Comparison Report — Transavia-style side-by-side memo.
//
// Reference: "PnL Comparison Upload vs Transavia vs Industry" — the
// institutional output where every cost line is compared between the
// uploaded company, a named peer (Transavia for poultry, NEPI for CRE,
// Bitdefender for IT), and the industry P50. Each gap shows pp, the
// financial impact in RON (`gap_pp × revenue / 100`), severity, root
// cause, and a recommendation.
//
// This page consumes the SAME /api/benchmarks/report/{period_id}
// endpoint the BenchmarkReport page uses — no new backend work. The
// difference is the rendering: BenchmarkReport is the interactive
// exploration surface; PeerComparisonReport is the printable memo
// you email to the bank.
//
// PDF export: browser print → "Save as PDF" (same pattern as the
// /report page). CSS @media print rules strip app chrome.

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useActivePeriodFallback } from "@/hooks/useActivePeriodFallback";
import { Download, Printer, Loader2, AlertTriangle, TrendingUp, TrendingDown } from "lucide-react";
// Instrument pass (2026-08): panels/chips from the kit, figures mono via
// the Amount family, semantic color only on severity/favorability.
import { Chip, PageHeader as InstrumentPageHeader, Panel, type ChipTone } from "@/components/instrument/Panel";
import { PercentLevel, PpDelta } from "@/components/comparison/MoneyAmount";
import { IndustryBadge } from "@/components/cfo/industry";
import { getSupabase } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";
import { useCurrency } from "@/stores/currency";
import { formatMoneyFrom } from "@/lib/money";
import type { Currency } from "@/lib/rates";

/**
 * CUR-FIX — currency-aware compact formatter for peer-comparison impact
 * values. The impact column shows EBITDA drag in money ("+2.5 M RON"
 * → "+€480k" on EUR toggle). Same conversion pipeline as the other
 * reports — single source of truth via <CurrencyProvider>.
 */
function usePeerImpactFmt(sourceCurrency: string) {
  const { display, rates } = useCurrency();
  const src = (sourceCurrency as Currency) || "RON";
  return useMemo(() => {
    return {
      displayCurrency: display,
      fmtImpact(absRons: number, signed: boolean, sign: "+" | "−" = "+"): string {
        const compact = formatMoneyFrom(absRons, src, display, rates.rates, { compact: true });
        return signed ? `${sign}${compact}` : compact;
      },
    };
  }, [src, display, rates]);
}

const apiBase = (): string =>
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

// ─── Types — mirror the /api/benchmarks/report response shape ──────────────
//
// Keep the typing narrow but tolerant: the response is fully serialized
// JSON and we only consume a subset. `Record<string, number>` for the
// raw metrics map is the cleanest contract.

interface BenchmarkComparison {
  metric_name: string;
  display: { ro?: string; en?: string; fmt?: string };
  company_value: number | null;
  benchmark: {
    p25: number | null;
    p50: number | null;
    p75: number | null;
    unit: string | null;
    source: string | null;
    source_year?: number | null;
    confidence?: string | null;
    notes?: string | null;
  };
  verdict: string;
  gap_pp: number | null;
  lower_is_better: boolean;
}

interface DeepPayload {
  leader_company: string | null;
  leader_year: number | null;
  leader_revenue_mlei: number | null;
  leader_net_margin_pct: number | null;
  leader_specialization: string | null;
  leader_reasons: Array<{
    rank: number;
    title: string;
    description: string;
    margin_impact_pp: number | null;
    evidence_source: string | null;
  }>;
  leader_total_impact_pp: number;
  peers: Array<{
    company_name: string;
    fiscal_year: number | null;
    revenue_mlei: number | null;
    net_margin_pct: number | null;
    ebitda_margin_pct: number | null;
    equity_ratio_pct: number | null;
    debt_to_equity: number | null;
    specialization: string | null;
    tier: "leader" | "strong" | "median" | "thin_margin" | "distressed" | "self" | string;
    source: string | null;
  }>;
  target_tiers: {
    aspirational?: { net_margin_pct: number; ebitda_margin_pct: number; label: string; comment: string };
    realistic?:    { net_margin_pct: number; ebitda_margin_pct: number; label: string; comment: string };
    minimum_viable?: { net_margin_pct: number; ebitda_margin_pct: number; label: string; comment: string };
  } | null;
  success_patterns: string[];
  failure_modes: string[];
  market_context: string | null;
}

interface ReportResponse {
  caen_code: string;
  caen_label: string;
  industry_category: string;
  disclosure: string;
  sections: {
    profitability?: { comparisons: BenchmarkComparison[] };
    cost_structure?: { comparisons: BenchmarkComparison[] };
    capital_structure?: { comparisons: BenchmarkComparison[] };
  };
  deep: DeepPayload | null;
  company_metrics_raw?: Record<string, number>;
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function PeerComparisonReport() {
  // 2026-05-24 — auto-resolve active period when URL lacks ?period= so
  // sidebar navigation doesn't show an empty state when the user has docs.
  // See src/hooks/useActivePeriodFallback.ts for the shared pattern.
  const { periodId } = useActivePeriodFallback();
  const { toast } = useToast();
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [companyName, setCompanyName] = useState<string>("Your company");
  // CUR-FIX — capture the period's source currency so peer-comparison impact
  // figures convert through the same FX pipeline as Dashboard / Report /
  // Products. Defaults to RON until /api/period responds.
  const [periodCurrency, setPeriodCurrency] = useState<string>("RON");
  const [loading, setLoading] = useState(true);
  const [pdfBusy, setPdfBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!periodId) { setLoading(false); return; }
    void (async () => {
      setLoading(true);
      const sb = getSupabase();
      const { data } = sb ? await sb.auth.getSession() : { data: { session: null } };
      const token = data?.session?.access_token;
      try {
        // Fire the two requests we need in parallel — the benchmark
        // report is the heavyweight payload; /api/period gives us the
        // company name so the title reads "{Co} vs Transavia vs Industry"
        // instead of "Your company vs Transavia vs Industry".
        const [benchRes, periodRes] = await Promise.all([
          fetch(`${apiBase()}/api/benchmarks/report/${periodId}`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          }),
          fetch(`${apiBase()}/api/period/${periodId}`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          }),
        ]);
        if (!benchRes.ok) throw new Error(`benchmarks HTTP ${benchRes.status}`);
        const body = (await benchRes.json()) as ReportResponse;
        if (!cancelled) setReport(body);
        if (periodRes.ok) {
          const pbody = await periodRes.json();
          if (!cancelled) {
            setCompanyName(pbody?.statements?.companyName ?? "Your company");
            setPeriodCurrency(pbody?.period?.currency ?? "RON");
          }
        }
      } catch (e: unknown) {
        if (!cancelled) toast({
          title: "Couldn't load peer comparison",
          description: e instanceof Error ? e.message : "Network error",
          variant: "destructive",
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [periodId, toast]);

  function exportPdf() {
    setPdfBusy(true);
    toast({ title: "Opening print dialog", description: "Choose 'Save as PDF' in the destination dropdown." });
    window.setTimeout(() => { window.print(); setPdfBusy(false); }, 250);
  }

  // ── Hook discipline ────────────────────────────────────────────────────
  // `useMemoPeriodLabel` MUST be called unconditionally on every render,
  // BEFORE any early return — React enforces a stable hook-call order
  // across renders. Previously this hook was called below the
  // `if (loading) return` and `if (!report) return` guards, so the first
  // render (loading=true) counted N hooks and the second render
  // (loading=false, report present) counted N+1, producing
  //   "Rendered more hooks than during the previous render."
  // The hook handles `report === null` internally by returning a safe
  // default label; the conditional logic lives inside its useMemo
  // callback (not gating the hook call itself).
  const periodLabel = useMemoPeriodLabel(report);

  if (loading) {
    return <><div className="flex items-center justify-center py-32 text-ink-mute"><Loader2 size={20} className="animate-spin mr-2" />Loading peer comparison…</div></>;
  }
  if (!report) {
    return (
      <>
        <div className="max-w-[640px] mx-auto py-24 text-center">
          <h1 className="text-[22px] font-semibold tracking-[-0.005em] text-ink">No peer data available</h1>
          <p className="mt-2 text-[14px] text-ink-soft">
            Open a financial period first, then return to this page.
          </p>
        </div>
      </>
    );
  }

  const deep = report.deep;
  const revenue = report.company_metrics_raw?.revenue ?? 0;

  return (
    <>
      <div className="max-w-[1100px]" data-testid="peer-comparison-report">
        {/* A3 hero eviction — the gradient banner becomes the compact
            instrument header; the memo identity survives in the eyebrow. */}
        <div className="mb-6 pb-4 border-b border-rule">
          <InstrumentPageHeader
            eyebrow="Peer comparison memo"
            title={
              <>
                {companyName} <span className="text-ink-mute">vs</span>{" "}
                {deep?.leader_company ?? "Industry"} <span className="text-ink-mute">vs</span>{" "}
                {report.caen_label}
              </>
            }
            context={
              <>
                <span>CAEN {report.caen_code} · {periodLabel}</span>
                {/* Phase E — surface the per-period industry assignment
                    alongside the legacy CAEN. */}
                {periodId && <IndustryBadge periodId={periodId} variant="compact" />}
              </>
            }
            actions={
              <div className="flex items-center gap-2 flex-wrap print:hidden">
                <button
                  onClick={exportPdf}
                  disabled={pdfBusy}
                  data-testid="peer-export-pdf"
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-ink text-paper disabled:opacity-50 text-[12.5px] font-medium hover:bg-ink/90 transition-colors duration-micro"
                >
                  {pdfBusy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                  Export PDF
                </button>
                <button
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-rule bg-surface text-ink text-[12.5px] font-medium hover:bg-bg-2 transition-colors duration-micro"
                >
                  <Printer size={13} />
                  Print
                </button>
              </div>
            }
          />
        </div>

        <article className="space-y-10">
          {/* ── HEADLINE VERDICT ─────────────────────────────────────── */}
          <HeadlineVerdict report={report} revenue={revenue} companyName={companyName} currency={periodCurrency} />

          {/* ── 1. SIDE-BY-SIDE P&L (cost-structure gap table) ───────── */}
          <PnlGapTable report={report} revenue={revenue} companyName={companyName} currency={periodCurrency} />

          {/* ── 2. PEER LANDSCAPE ────────────────────────────────────── */}
          {deep && deep.peers.length > 0 && <PeerLandscape deep={deep} companyName={companyName} />}

          {/* ── 3. WHY THE LEADER WINS (structural reasons) ──────────── */}
          {deep && deep.leader_reasons.length > 0 && <LeaderReasons deep={deep} />}

          {/* ── 4. TARGET TIERS ──────────────────────────────────────── */}
          {deep?.target_tiers && <TargetTiers tiers={deep.target_tiers} />}

          {/* ── 5. INDUSTRY DYNAMICS + market context ────────────────── */}
          {(deep?.market_context || (deep?.success_patterns && deep.success_patterns.length > 0)) && (
            <IndustryDynamics deep={deep!} />
          )}

          {/* ── DISCLOSURE ───────────────────────────────────────────── */}
          <footer className="pt-6 mt-8 border-t border-rule">
            <p className="text-[10.5px] text-ink-mute leading-relaxed">
              <strong>Methodology note.</strong> {report.disclosure}
            </p>
          </footer>
        </article>
      </div>
    </>
  );
}

function useMemoPeriodLabel(r: ReportResponse | null): string {
  // Accepts null so the hook can be called unconditionally before the
  // parent's loading/empty-state guards. Returns a safe default until
  // `r` arrives; the conditional lives INSIDE the memo callback (not
  // around the hook call) so React's hook count stays constant.
  return useMemo(() => {
    if (!r) return "Current period";
    const cy = r.company_metrics_raw?.fiscal_year;
    return cy ? `FY${cy}` : "Current period";
  }, [r]);
}

// ─── Headline verdict — 3-bullet executive read ────────────────────────────

function HeadlineVerdict({ report, revenue, companyName, currency }: {
  report: ReportResponse;
  revenue: number;
  companyName: string;
  currency: string;
}) {
  // CUR-FIX — Impact figures convert through the same FX pipeline as the
  // rest of the report so toggling EUR/USD updates them live.
  const impactFmt = usePeerImpactFmt(currency);
  // Pick the two biggest unfavorable gaps from cost_structure + the
  // EBITDA / net margin gap. This block is the read-it-in-30-seconds
  // summary; everything below is the supporting math.
  const cost = report.sections.cost_structure?.comparisons ?? [];
  const prof = report.sections.profitability?.comparisons ?? [];
  const ebitdaGap = prof.find((c) => c.metric_name === "ebitda_margin");
  const netGap = prof.find((c) => c.metric_name === "net_margin");

  // Worst cost-structure gaps (positive gap_pp on a lower-is-better
  // metric = bad). Take top 2.
  const worstCost = [...cost]
    .filter((c) => c.gap_pp != null && c.lower_is_better && c.gap_pp > 0)
    .sort((a, b) => (b.gap_pp ?? 0) - (a.gap_pp ?? 0))
    .slice(0, 2);

  const formatImpact = (gapPp: number | null) => {
    if (gapPp == null || revenue <= 0) return "—";
    const rons = Math.abs(gapPp) * revenue / 100;
    return impactFmt.fmtImpact(rons, false);
  };

  const overallVerdict = (() => {
    if (!ebitdaGap || ebitdaGap.gap_pp == null) return "neutral";
    if (ebitdaGap.gap_pp >= 2) return "ahead";
    if (ebitdaGap.gap_pp <= -2) return "behind";
    return "near_median";
  })();
  const verdictText = {
    ahead:        `${companyName} runs AHEAD of industry median on profitability.`,
    near_median:  `${companyName} runs NEAR industry median on profitability.`,
    behind:       `${companyName} runs BEHIND industry median on profitability.`,
    neutral:      `${companyName} — profitability comparison pending.`,
  }[overallVerdict];

  return (
    <Panel data-testid="peer-headline" className="p-5">
      <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium mb-2">
        Headline verdict
      </div>
      <p className="text-[16px] font-semibold text-ink leading-tight tracking-tight">
        {verdictText}
      </p>
      <div className="mt-4 grid sm:grid-cols-2 lg:grid-cols-4 gap-3 text-[12.5px]">
        <KpiBox
          label="EBITDA margin vs P50"
          value={<PpDelta value={(ebitdaGap?.gap_pp ?? null) != null ? (ebitdaGap!.gap_pp as number) / 100 : null} />}
          sub={<>Yours <PercentLevel value={ebitdaGap?.company_value ?? null} /> · P50 <PercentLevel value={ebitdaGap?.benchmark.p50 ?? null} /></>}
          favorable={ebitdaGap?.gap_pp != null && ebitdaGap.gap_pp >= 0}
        />
        <KpiBox
          label="Net margin vs P50"
          value={<PpDelta value={(netGap?.gap_pp ?? null) != null ? (netGap!.gap_pp as number) / 100 : null} />}
          sub={<>Yours <PercentLevel value={netGap?.company_value ?? null} /> · P50 <PercentLevel value={netGap?.benchmark.p50 ?? null} /></>}
          favorable={netGap?.gap_pp != null && netGap.gap_pp >= 0}
        />
        {worstCost[0] && (
          <KpiBox
            label={`${worstCost[0].display.en ?? worstCost[0].metric_name} — overspend`}
            value={<PpDelta value={(worstCost[0].gap_pp ?? 0) / 100} />}
            sub={`Drag ~${formatImpact(worstCost[0].gap_pp)} on EBITDA`}
            favorable={false}
          />
        )}
        {worstCost[1] && (
          <KpiBox
            label={`${worstCost[1].display.en ?? worstCost[1].metric_name} — overspend`}
            value={<PpDelta value={(worstCost[1].gap_pp ?? 0) / 100} />}
            sub={`Drag ~${formatImpact(worstCost[1].gap_pp)} on EBITDA`}
            favorable={false}
          />
        )}
      </div>
    </Panel>
  );
}

function KpiBox({ label, value, sub, favorable }: {
  label: string;
  value: ReactNode;
  sub: ReactNode;
  favorable: boolean;
}) {
  // Favorable / unfavorable vs P50 is the semantic verdict of these
  // tiles — the pre-instrument version painted BOTH states the same teal,
  // which said nothing. Success green / alert red now carry the meaning.
  const valueColor = favorable ? "text-success" : "text-alert";
  return (
    <Panel inset className="px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.1em] text-ink-mute font-medium">{label}</div>
      <div className={`mt-1 text-[18px] font-semibold leading-none ${valueColor}`}>{value}</div>
      <div className="mt-1 text-[11px] text-ink-mute">{sub}</div>
    </Panel>
  );
}

// ─── P&L gap table — the Transavia-style row-by-row comparison ──────────────

function PnlGapTable({ report, revenue, companyName, currency }: {
  report: ReportResponse;
  revenue: number;
  companyName: string;
  currency: string;
}) {
  // CUR-FIX — drives the Financial-impact column conversion.
  const impactFmt = usePeerImpactFmt(currency);
  // Combine all comparison rows from profitability + cost_structure +
  // capital_structure sections into one table. Order matters: profit
  // headlines first, then cost-structure lines, then capital structure.
  const prof = report.sections.profitability?.comparisons ?? [];
  const cost = report.sections.cost_structure?.comparisons ?? [];
  const cap  = report.sections.capital_structure?.comparisons ?? [];
  const rows = [...prof, ...cost, ...cap];

  // Compute the row-level severity + financial impact at render time.
  // Severity rules (LOWER-IS-BETTER metrics like cost ratios):
  //   gap_pp > +5pp  → critical (red)
  //   gap_pp > +2pp  → high   (orange)
  //   gap_pp > 0pp   → medium (amber)
  //   else            → strong (green)
  // For HIGHER-IS-BETTER metrics (margins, equity ratio) the sign flips.
  function severity(row: BenchmarkComparison): "critical" | "high" | "medium" | "strong" {
    if (row.gap_pp == null) return "medium";
    const sign = row.lower_is_better ? 1 : -1;
    const g = row.gap_pp * sign; // > 0 = worse than P50
    if (g > 5) return "critical";
    if (g > 2) return "high";
    if (g > 0) return "medium";
    return "strong";
  }

  // Severity is the ONLY colored dimension in this table: red for a
  // critical gap, amber for high/medium overspend, green for a line run
  // better than the median. Row backgrounds tint only the critical rows.
  const sevRow: Record<string, string> = {
    critical: "bg-alert-tint/60",
    high:     "",
    medium:   "",
    strong:   "",
  };
  const sevText: Record<string, string> = {
    critical: "text-alert",
    high:     "text-caution",
    medium:   "text-caution",
    strong:   "text-success",
  };
  const sevTone: Record<string, ChipTone> = {
    critical: "alert",
    high:     "caution",
    medium:   "caution",
    strong:   "success",
  };

  function fmtImpact(gap: number | null, lowerIsBetter: boolean): string {
    if (gap == null || revenue <= 0) return "—";
    // For lower-is-better, positive gap = overspending = unfavorable.
    // Magnitude × revenue = the EBITDA drag. For higher-is-better,
    // negative gap = under-earning = magnitude × revenue = lost EBITDA.
    const drag = Math.abs(gap) * revenue / 100;
    const sign: "+" | "−" = (lowerIsBetter && gap > 0) || (!lowerIsBetter && gap < 0) ? "−" : "+";
    return impactFmt.fmtImpact(drag, true, sign);
  }

  return (
    <section data-testid="peer-pnl-gap">
      <h2 className="text-[13px] font-medium uppercase tracking-[0.08em] text-ink-soft mb-2 pb-2 border-b border-rule">
        §1. Side-by-side P&L — {companyName} vs Industry P50
      </h2>
      <p className="text-[12.5px] text-ink-soft mb-4 max-w-[800px]">
        Each line compares the company's cost or margin against the industry-median
        (P50) range. The financial-impact column shows what closing the gap is worth
        on annual EBITDA: <code className="font-mono text-[11px]">|gap pp| × revenue / 100</code>.
      </p>
      <Panel className="overflow-x-auto lg:overflow-x-visible">
        <table className="w-full text-[12.5px] min-w-[640px] sm:min-w-0">
          <thead className="lg:sticky lg:top-14 z-10 bg-surface text-[10.5px] uppercase tracking-[0.08em] text-ink-mute">
            <tr className="border-b border-rule">
              <th className="text-left px-4 h-8 font-medium">Line</th>
              <th className="text-right px-3 h-8 font-medium">{companyName}</th>
              <th className="text-right px-3 h-8 font-medium">P25</th>
              <th className="text-right px-3 h-8 font-medium">P50 (industry)</th>
              <th className="text-right px-3 h-8 font-medium">P75</th>
              <th className="text-right px-3 h-8 font-medium">Gap vs P50</th>
              <th className="text-right px-3 h-8 font-medium">Financial impact</th>
              <th className="text-left px-3 h-8 font-medium">Severity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const sev = severity(row);
              return (
                <tr key={row.metric_name} className={`border-t border-rule-soft first:border-t-0 h-8 ${sevRow[sev]}`}>
                  <td className="px-4 py-1 text-ink font-medium">{row.display.en ?? row.metric_name}</td>
                  <td className="px-3 py-1 text-right"><PercentLevel value={row.company_value} /></td>
                  <td className="px-3 py-1 text-right text-ink-mute"><PercentLevel value={row.benchmark.p25} /></td>
                  <td className="px-3 py-1 text-right font-semibold"><PercentLevel value={row.benchmark.p50} /></td>
                  <td className="px-3 py-1 text-right text-ink-mute"><PercentLevel value={row.benchmark.p75} /></td>
                  <td className={`px-3 py-1 text-right font-semibold ${sevText[sev]}`}>
                    <PpDelta value={row.gap_pp != null ? row.gap_pp / 100 : null} />
                  </td>
                  <td className={`px-3 py-1 text-right font-mono tabular-nums ${sevText[sev]}`}>{fmtImpact(row.gap_pp, row.lower_is_better)}</td>
                  <td className="px-3 py-1">
                    <Chip tone={sevTone[sev]} className="uppercase tracking-[0.06em]">{sev}</Chip>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>
    </section>
  );
}

// ─── Peer landscape — table of named peers with tier badge ──────────────────

function PeerLandscape({ deep, companyName }: { deep: DeepPayload; companyName: string }) {
  // Same tier→tone ladder as the Benchmark peers table: LEADER=accent,
  // STRONG/MEDIAN=neutral, THIN MARGIN=caution, DISTRESSED=alert (the one
  // allowed red — reported losses/distress), self=info.
  const tierTone: Record<string, ChipTone> = {
    leader:      "accent",
    strong:      "neutral",
    median:      "neutral",
    thin_margin: "caution",
    distressed:  "alert",
    self:        "info",
  };
  return (
    <section data-testid="peer-landscape">
      <h2 className="text-[13px] font-medium uppercase tracking-[0.08em] text-ink-soft mb-2 pb-2 border-b border-rule">
        §2. Peer landscape — named Romanian comparables
      </h2>
      <Panel className="overflow-x-auto lg:overflow-x-visible">
        <table className="w-full text-[12.5px] min-w-[640px] sm:min-w-0">
          <thead className="lg:sticky lg:top-14 z-10 bg-surface text-[10.5px] uppercase tracking-[0.08em] text-ink-mute">
            <tr className="border-b border-rule">
              <th className="text-left px-4 h-8 font-medium">Company</th>
              <th className="text-left px-3 h-8 font-medium">Specialization</th>
              <th className="text-right px-3 h-8 font-medium">FY</th>
              <th className="text-right px-3 h-8 font-medium">Revenue (M, source curr.)</th>
              <th className="text-right px-3 h-8 font-medium">Net margin</th>
              <th className="text-right px-3 h-8 font-medium">EBITDA margin</th>
              <th className="text-right px-3 h-8 font-medium">Equity ratio</th>
              <th className="text-left px-3 h-8 font-medium">Tier</th>
            </tr>
          </thead>
          <tbody>
            {deep.peers.map((p) => {
              const isSelf = p.tier === "self";
              return (
                <tr key={`${p.company_name}-${p.fiscal_year}`}
                    className={`border-t border-rule-soft first:border-t-0 h-8 ${isSelf ? "bg-bg-2/60 font-semibold" : ""}`}>
                  <td className="px-4 py-1 text-ink">{isSelf ? companyName : p.company_name}</td>
                  <td className="px-3 py-1 text-ink-soft">{p.specialization ?? "—"}</td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums text-ink-mute">{p.fiscal_year ?? "—"}</td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">{p.revenue_mlei != null ? p.revenue_mlei.toFixed(1) : "—"}</td>
                  <td className="px-3 py-1 text-right"><PercentLevel value={p.net_margin_pct} /></td>
                  <td className="px-3 py-1 text-right"><PercentLevel value={p.ebitda_margin_pct} /></td>
                  <td className="px-3 py-1 text-right"><PercentLevel value={p.equity_ratio_pct} /></td>
                  <td className="px-3 py-1">
                    <Chip tone={tierTone[p.tier] ?? "neutral"} className="uppercase tracking-[0.06em]">
                      {p.tier}
                    </Chip>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>
    </section>
  );
}

// ─── Leader reasons — the structural-why bullets ───────────────────────────

function LeaderReasons({ deep }: { deep: DeepPayload }) {
  return (
    <section data-testid="peer-leader-reasons">
      <h2 className="text-[13px] font-medium uppercase tracking-[0.08em] text-ink-soft mb-2 pb-2 border-b border-rule">
        §3. Why {deep.leader_company} leads — {deep.leader_reasons.length} structural reasons
      </h2>
      <p className="text-[12.5px] text-ink-soft mb-4">
        Cumulative margin impact:{" "}
        <strong className="text-ink"><PpDelta value={deep.leader_total_impact_pp / 100} /></strong>{" "}
        above industry median. These are the deliberate moves the leader made — not luck, not scale alone.
      </p>
      <ol className="space-y-2.5">
        {deep.leader_reasons.map((r) => (
          <li key={r.rank} data-testid="peer-leader-reason">
            <Panel className="px-4 py-3">
            <div className="flex items-start justify-between gap-3 mb-1">
              <div className="flex items-center gap-2 min-w-0">
                <TrendingUp size={14} strokeWidth={2} className="text-brand-dark dark:text-brand-light shrink-0" />
                <span className="font-medium text-ink">{r.rank}. {r.title}</span>
              </div>
              {r.margin_impact_pp != null && (
                <span className="text-[11px] font-medium text-ink-soft shrink-0">
                  <PpDelta value={r.margin_impact_pp / 100} />
                </span>
              )}
            </div>
            <p className="text-[12.5px] text-ink-soft leading-relaxed">{r.description}</p>
            {r.evidence_source && (
              <p className="text-[11px] text-ink-mute mt-1 italic">Source: {r.evidence_source}</p>
            )}
            </Panel>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ─── Target tiers — what aspirational / realistic / minimum-viable look like

function TargetTiers({ tiers }: { tiers: NonNullable<DeepPayload["target_tiers"]> }) {
  const order: Array<keyof NonNullable<DeepPayload["target_tiers"]>> = ["aspirational", "realistic", "minimum_viable"];
  // Ambition ladder on the left rule: accent = stretch target, plain
  // hairline = realistic, caution = the floor before refinancing risk.
  const labelMap: Record<string, { rule: string; description: string }> = {
    aspirational:   { rule: "border-l-brand",   description: "Where leaders run today" },
    realistic:      { rule: "border-l-rule",    description: "Achievable in 18-24 months" },
    minimum_viable: { rule: "border-l-caution", description: "Floor before refinancing risk" },
  };
  return (
    <section data-testid="peer-target-tiers">
      <h2 className="text-[13px] font-medium uppercase tracking-[0.08em] text-ink-soft mb-2 pb-2 border-b border-rule">
        §4. Margin targets — three tiers
      </h2>
      <div className="grid md:grid-cols-3 gap-3">
        {order.map((k) => {
          const t = tiers[k];
          if (!t) return null;
          return (
            <Panel key={k} className={`border-l-[3px] ${labelMap[k].rule} p-4`}>
              <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">
                {labelMap[k].description}
              </div>
              <div className="mt-1 text-[13.5px] font-semibold text-ink">{t.label}</div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-[22px] font-semibold text-ink"><PercentLevel value={t.ebitda_margin_pct} /></span>
                <span className="text-[11px] text-ink-mute">EBITDA</span>
              </div>
              <div className="text-[12px] text-ink-soft">
                Net margin: <strong><PercentLevel value={t.net_margin_pct} /></strong>
              </div>
              <p className="mt-2 text-[12px] text-ink-soft leading-relaxed">{t.comment}</p>
            </Panel>
          );
        })}
      </div>
    </section>
  );
}

// ─── Industry dynamics + success patterns + failure modes ───────────────────

function IndustryDynamics({ deep }: { deep: DeepPayload }) {
  return (
    <section data-testid="peer-industry-dynamics">
      <h2 className="text-[13px] font-medium uppercase tracking-[0.08em] text-ink-soft mb-2 pb-2 border-b border-rule">
        §5. Industry dynamics
      </h2>
      {deep.market_context && (
        <Panel inset className="border-l-[3px] border-l-info px-4 py-3 mb-4">
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-1">
            Market context
          </div>
          <p className="text-[13px] text-ink-soft leading-relaxed">{deep.market_context}</p>
        </Panel>
      )}
      <div className="grid md:grid-cols-2 gap-4">
        {deep.success_patterns.length > 0 && (
          <Panel className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp size={14} className="text-success" />
              <h3 className="font-medium text-ink text-[14px]">Success patterns</h3>
            </div>
            <ul className="space-y-1.5 text-[12.5px] text-ink-soft">
              {deep.success_patterns.map((p, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-success mt-0.5 font-mono">+</span>
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </Panel>
        )}
        {deep.failure_modes.length > 0 && (
          <Panel className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <TrendingDown size={14} className="text-alert" />
              <h3 className="font-medium text-ink text-[14px]">Failure modes</h3>
            </div>
            <ul className="space-y-1.5 text-[12.5px] text-ink-soft">
              {deep.failure_modes.map((f, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-alert mt-0.5 font-mono">−</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
      {(!deep.success_patterns.length && !deep.failure_modes.length && !deep.market_context) && (
        <Panel inset className="px-4 py-4 text-[13px] text-ink-soft">
          <AlertTriangle size={14} className="inline mr-1 text-ink-mute" />
          No qualitative industry data seeded for this CAEN yet. Coverage expands —
          the percentile + named-peer comparisons above are the primary read.
        </Panel>
      )}
    </section>
  );
}
