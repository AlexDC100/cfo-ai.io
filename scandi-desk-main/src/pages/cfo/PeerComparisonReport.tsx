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

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, Printer, Loader2, AlertTriangle, TrendingUp, TrendingDown } from "lucide-react";
import { AppShell } from "@/components/cfo/AppShell";
import { IndustryBadge } from "@/components/cfo/industry";
import { getSupabase } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";

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
  const [params] = useSearchParams();
  const periodId = params.get("period");
  const { toast } = useToast();
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [companyName, setCompanyName] = useState<string>("Your company");
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
          if (!cancelled) setCompanyName(pbody?.statements?.companyName ?? "Your company");
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
    return <AppShell><div className="flex items-center justify-center py-32 text-ink-mute"><Loader2 size={20} className="animate-spin mr-2" />Loading peer comparison…</div></AppShell>;
  }
  if (!report) {
    return (
      <AppShell>
        <div className="max-w-[640px] mx-auto py-24 text-center">
          <h1 className="font-serif text-[28px] text-ink">No peer data available</h1>
          <p className="mt-2 text-[14px] text-ink-soft">
            Open a financial period first, then return to this page.
          </p>
        </div>
      </AppShell>
    );
  }

  const deep = report.deep;
  const revenue = report.company_metrics_raw?.revenue ?? 0;

  return (
    <AppShell>
      <div className="max-w-[1100px] mx-auto" data-testid="peer-comparison-report">
        {/* Navy gradient header — matches the Transavia memo + /report page */}
        <header className="rounded-2xl px-6 py-6 mb-6 text-white"
                style={{ background: "linear-gradient(135deg, #003366 0%, #1a5490 100%)" }}>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="text-[10.5px] uppercase tracking-[0.14em] opacity-80">
                Peer comparison memo
              </div>
              <h1 className="mt-1 font-serif text-[32px] leading-tight">
                {companyName} <span className="opacity-70 text-[24px]">vs</span> {deep?.leader_company ?? "Industry"} <span className="opacity-70 text-[24px]">vs</span> {report.caen_label}
              </h1>
              <p className="mt-1.5 text-[13px] opacity-85 inline-flex items-center gap-2 flex-wrap">
                <span>CAEN {report.caen_code} · {periodLabel}</span>
                {/* Phase E — surface the per-period industry assignment
                    alongside the legacy CAEN. Wrapped in a light pill so
                    the badge's tone palette stays legible on the navy
                    gradient header. */}
                {periodId && (
                  <span className="inline-flex items-center bg-surface rounded-md px-1.5 py-0.5">
                    <IndustryBadge periodId={periodId} variant="compact" />
                  </span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2 print:hidden">
              <button
                onClick={exportPdf}
                disabled={pdfBusy}
                data-testid="peer-export-pdf"
                className="inline-flex items-center gap-1.5 rounded-md bg-rule-soft/60 hover:bg-rule-soft disabled:opacity-50 px-3 py-1.5 text-[12.5px] font-medium transition-colors"
              >
                {pdfBusy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                Export PDF
              </button>
              <button
                onClick={() => window.print()}
                className="inline-flex items-center gap-1.5 rounded-md bg-rule-soft/60 hover:bg-rule-soft px-3 py-1.5 text-[12.5px] font-medium transition-colors"
              >
                <Printer size={13} />
                Print
              </button>
            </div>
          </div>
        </header>

        <article className="space-y-10">
          {/* ── HEADLINE VERDICT ─────────────────────────────────────── */}
          <HeadlineVerdict report={report} revenue={revenue} companyName={companyName} />

          {/* ── 1. SIDE-BY-SIDE P&L (cost-structure gap table) ───────── */}
          <PnlGapTable report={report} revenue={revenue} companyName={companyName} />

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
    </AppShell>
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

function HeadlineVerdict({ report, revenue, companyName }: {
  report: ReportResponse;
  revenue: number;
  companyName: string;
}) {
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
    return rons >= 1_000_000 ? `${(rons/1_000_000).toFixed(1)} M RON` : `${(rons/1_000).toFixed(0)} K RON`;
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
    <section data-testid="peer-headline" className="rounded-2xl border-2 border-ink/30 bg-surface p-5">
      <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium mb-2">
        Headline verdict
      </div>
      <p className="font-serif text-[20px] text-ink leading-tight">
        {verdictText}
      </p>
      <div className="mt-4 grid sm:grid-cols-2 lg:grid-cols-4 gap-3 text-[12.5px]">
        <KpiBox
          label="EBITDA margin vs P50"
          value={ebitdaGap?.gap_pp != null ? `${ebitdaGap.gap_pp >= 0 ? "+" : ""}${ebitdaGap.gap_pp.toFixed(1)} pp` : "—"}
          sub={`Yours ${ebitdaGap?.company_value?.toFixed(1) ?? "—"}% · P50 ${ebitdaGap?.benchmark.p50?.toFixed(1) ?? "—"}%`}
          favorable={ebitdaGap?.gap_pp != null && ebitdaGap.gap_pp >= 0}
        />
        <KpiBox
          label="Net margin vs P50"
          value={netGap?.gap_pp != null ? `${netGap.gap_pp >= 0 ? "+" : ""}${netGap.gap_pp.toFixed(1)} pp` : "—"}
          sub={`Yours ${netGap?.company_value?.toFixed(1) ?? "—"}% · P50 ${netGap?.benchmark.p50?.toFixed(1) ?? "—"}%`}
          favorable={netGap?.gap_pp != null && netGap.gap_pp >= 0}
        />
        {worstCost[0] && (
          <KpiBox
            label={`${worstCost[0].display.en ?? worstCost[0].metric_name} — overspend`}
            value={`+${(worstCost[0].gap_pp ?? 0).toFixed(1)} pp`}
            sub={`Drag ~${formatImpact(worstCost[0].gap_pp)} on EBITDA`}
            favorable={false}
          />
        )}
        {worstCost[1] && (
          <KpiBox
            label={`${worstCost[1].display.en ?? worstCost[1].metric_name} — overspend`}
            value={`+${(worstCost[1].gap_pp ?? 0).toFixed(1)} pp`}
            sub={`Drag ~${formatImpact(worstCost[1].gap_pp)} on EBITDA`}
            favorable={false}
          />
        )}
      </div>
    </section>
  );
}

function KpiBox({ label, value, sub, favorable }: { label: string; value: string; sub: string; favorable: boolean }) {
  const valueColor = favorable ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400";
  const borderColor = favorable ? "border-emerald-300/50" : "border-amber-300/50";
  return (
    <div className={`rounded-xl border ${borderColor} bg-bg-2/40 px-3 py-3`}>
      <div className="text-[10px] uppercase tracking-[0.1em] text-ink-mute font-medium">{label}</div>
      <div className={`mt-1 font-serif text-[20px] leading-none tabular-nums ${valueColor}`}>{value}</div>
      <div className="mt-1 text-[11px] text-ink-mute">{sub}</div>
    </div>
  );
}

// ─── P&L gap table — the Transavia-style row-by-row comparison ──────────────

function PnlGapTable({ report, revenue, companyName }: {
  report: ReportResponse;
  revenue: number;
  companyName: string;
}) {
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

  const sevStyle: Record<string, string> = {
    critical: "bg-red-50/60 dark:bg-red-500/[0.08] border-red-300/50",
    high:     "bg-orange-50/60 dark:bg-orange-500/[0.08] border-orange-300/50",
    medium:   "bg-amber-50/40 dark:bg-amber-500/[0.06] border-amber-300/50",
    strong:   "bg-emerald-50/40 dark:bg-emerald-500/[0.06] border-emerald-300/50",
  };
  const sevText: Record<string, string> = {
    critical: "text-red-800 dark:text-red-300",
    high:     "text-orange-800 dark:text-orange-300",
    medium:   "text-amber-800 dark:text-amber-300",
    strong:   "text-emerald-800 dark:text-emerald-300",
  };

  function fmtPct(v: number | null): string {
    return v == null ? "—" : `${v.toFixed(1)}%`;
  }
  function fmtGap(gap: number | null): string {
    if (gap == null) return "—";
    const sign = gap >= 0 ? "+" : "";
    return `${sign}${gap.toFixed(1)} pp`;
  }
  function fmtImpact(gap: number | null, lowerIsBetter: boolean): string {
    if (gap == null || revenue <= 0) return "—";
    // For lower-is-better, positive gap = overspending = unfavorable.
    // Magnitude × revenue = the EBITDA drag. For higher-is-better,
    // negative gap = under-earning = magnitude × revenue = lost EBITDA.
    const drag = Math.abs(gap) * revenue / 100;
    const sign = (lowerIsBetter && gap > 0) || (!lowerIsBetter && gap < 0) ? "−" : "+";
    return drag >= 1_000_000 ? `${sign}${(drag/1_000_000).toFixed(1)} M RON` : `${sign}${(drag/1_000).toFixed(0)} K RON`;
  }

  return (
    <section data-testid="peer-pnl-gap">
      <h2 className="font-serif text-[22px] text-ink mb-3 pb-2 border-b-2 border-ink/20">
        §1. Side-by-side P&L — {companyName} vs Industry P50
      </h2>
      <p className="text-[12.5px] text-ink-soft mb-4 max-w-[800px]">
        Each line compares the company's cost or margin against the industry-median
        (P50) range. The financial-impact column shows what closing the gap is worth
        on annual EBITDA: <code className="font-mono text-[11px]">|gap pp| × revenue / 100</code>.
      </p>
      <div className="rounded-2xl border border-rule bg-surface overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead className="bg-bg-2/40 text-[10.5px] uppercase tracking-[0.08em] text-ink-mute">
            <tr>
              <th className="text-left px-4 py-2.5">Line</th>
              <th className="text-right px-3 py-2.5">{companyName}</th>
              <th className="text-right px-3 py-2.5">P25</th>
              <th className="text-right px-3 py-2.5">P50 (industry)</th>
              <th className="text-right px-3 py-2.5">P75</th>
              <th className="text-right px-3 py-2.5">Gap vs P50</th>
              <th className="text-right px-3 py-2.5">Financial impact</th>
              <th className="text-left px-3 py-2.5">Severity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const sev = severity(row);
              return (
                <tr key={row.metric_name} className={`border-t border-rule/40 ${sevStyle[sev]}`}>
                  <td className="px-4 py-2 text-ink font-medium">{row.display.en ?? row.metric_name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtPct(row.company_value)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink-mute">{fmtPct(row.benchmark.p25)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">{fmtPct(row.benchmark.p50)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink-mute">{fmtPct(row.benchmark.p75)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums font-semibold ${sevText[sev]}`}>{fmtGap(row.gap_pp)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${sevText[sev]}`}>{fmtImpact(row.gap_pp, row.lower_is_better)}</td>
                  <td className={`px-3 py-2 text-[10.5px] uppercase tracking-[0.08em] font-semibold ${sevText[sev]}`}>
                    {sev}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Peer landscape — table of named peers with tier badge ──────────────────

function PeerLandscape({ deep, companyName }: { deep: DeepPayload; companyName: string }) {
  const tierStyle: Record<string, string> = {
    leader:     "bg-emerald-100/80 text-emerald-900 border-emerald-300",
    strong:     "bg-emerald-50/80 text-emerald-800 border-emerald-200",
    median:     "bg-blue-50/80 text-blue-800 border-blue-200",
    thin_margin:"bg-amber-50/80 text-amber-800 border-amber-200",
    distressed: "bg-red-50/80 text-red-800 border-red-200",
    self:       "bg-ink/10 text-ink border-ink/30",
  };
  return (
    <section data-testid="peer-landscape">
      <h2 className="font-serif text-[22px] text-ink mb-3 pb-2 border-b-2 border-ink/20">
        §2. Peer landscape — named Romanian comparables
      </h2>
      <div className="rounded-2xl border border-rule bg-surface overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead className="bg-bg-2/40 text-[10.5px] uppercase tracking-[0.08em] text-ink-mute">
            <tr>
              <th className="text-left px-4 py-2.5">Company</th>
              <th className="text-left px-3 py-2.5">Specialization</th>
              <th className="text-right px-3 py-2.5">FY</th>
              <th className="text-right px-3 py-2.5">Revenue (M RON)</th>
              <th className="text-right px-3 py-2.5">Net margin</th>
              <th className="text-right px-3 py-2.5">EBITDA margin</th>
              <th className="text-right px-3 py-2.5">Equity ratio</th>
              <th className="text-left px-3 py-2.5">Tier</th>
            </tr>
          </thead>
          <tbody>
            {deep.peers.map((p) => {
              const isSelf = p.tier === "self";
              return (
                <tr key={`${p.company_name}-${p.fiscal_year}`}
                    className={`border-t border-rule/40 ${isSelf ? "bg-ink/[0.04] font-semibold" : ""}`}>
                  <td className="px-4 py-2 text-ink">{isSelf ? companyName : p.company_name}</td>
                  <td className="px-3 py-2 text-ink-soft">{p.specialization ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink-mute">{p.fiscal_year ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{p.revenue_mlei != null ? p.revenue_mlei.toFixed(1) : "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{p.net_margin_pct != null ? `${p.net_margin_pct.toFixed(1)}%` : "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{p.ebitda_margin_pct != null ? `${p.ebitda_margin_pct.toFixed(1)}%` : "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{p.equity_ratio_pct != null ? `${p.equity_ratio_pct.toFixed(1)}%` : "—"}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center text-[10px] uppercase tracking-[0.08em] font-medium px-2 py-0.5 rounded-md border ${tierStyle[p.tier] ?? tierStyle.median}`}>
                      {p.tier}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Leader reasons — the structural-why bullets ───────────────────────────

function LeaderReasons({ deep }: { deep: DeepPayload }) {
  return (
    <section data-testid="peer-leader-reasons">
      <h2 className="font-serif text-[22px] text-ink mb-3 pb-2 border-b-2 border-ink/20">
        §3. Why {deep.leader_company} leads — {deep.leader_reasons.length} structural reasons
      </h2>
      <p className="text-[12.5px] text-ink-soft mb-4">
        Cumulative margin impact: <strong className="text-ink">+{deep.leader_total_impact_pp.toFixed(1)} pp</strong> above industry median.
        These are the deliberate moves the leader made — not luck, not scale alone.
      </p>
      <ol className="space-y-2.5">
        {deep.leader_reasons.map((r) => (
          <li key={r.rank}
              data-testid="peer-leader-reason"
              className="rounded-xl border-l-[3px] border-emerald-400 bg-surface border border-rule px-4 py-3">
            <div className="flex items-start justify-between gap-3 mb-1">
              <div className="flex items-center gap-2 min-w-0">
                <TrendingUp size={14} strokeWidth={2} className="text-emerald-600 shrink-0" />
                <span className="font-medium text-ink">{r.rank}. {r.title}</span>
              </div>
              {r.margin_impact_pp != null && (
                <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400 shrink-0 tabular-nums">
                  +{r.margin_impact_pp.toFixed(1)} pp
                </span>
              )}
            </div>
            <p className="text-[12.5px] text-ink-soft leading-relaxed">{r.description}</p>
            {r.evidence_source && (
              <p className="text-[11px] text-ink-mute mt-1 italic">Source: {r.evidence_source}</p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ─── Target tiers — what aspirational / realistic / minimum-viable look like

function TargetTiers({ tiers }: { tiers: NonNullable<DeepPayload["target_tiers"]> }) {
  const order: Array<keyof NonNullable<DeepPayload["target_tiers"]>> = ["aspirational", "realistic", "minimum_viable"];
  const labelMap: Record<string, { color: string; description: string }> = {
    aspirational:   { color: "border-emerald-400 bg-emerald-50/30",  description: "Where leaders run today" },
    realistic:      { color: "border-blue-400 bg-blue-50/30",        description: "Achievable in 18-24 months" },
    minimum_viable: { color: "border-amber-400 bg-amber-50/30",      description: "Floor before refinancing risk" },
  };
  return (
    <section data-testid="peer-target-tiers">
      <h2 className="font-serif text-[22px] text-ink mb-3 pb-2 border-b-2 border-ink/20">
        §4. Margin targets — three tiers
      </h2>
      <div className="grid md:grid-cols-3 gap-3">
        {order.map((k) => {
          const t = tiers[k];
          if (!t) return null;
          return (
            <div key={k} className={`rounded-xl border-l-[4px] ${labelMap[k].color} border border-rule p-4`}>
              <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">
                {labelMap[k].description}
              </div>
              <div className="mt-1 font-serif text-[15px] text-ink">{t.label}</div>
              <div className="mt-2 flex items-baseline gap-3">
                <span className="font-serif text-[28px] text-ink tabular-nums">{t.ebitda_margin_pct.toFixed(1)}%</span>
                <span className="text-[11px] text-ink-mute">EBITDA</span>
              </div>
              <div className="text-[12px] text-ink-soft">Net margin: <strong>{t.net_margin_pct.toFixed(1)}%</strong></div>
              <p className="mt-2 text-[12px] text-ink-soft leading-relaxed">{t.comment}</p>
            </div>
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
      <h2 className="font-serif text-[22px] text-ink mb-3 pb-2 border-b-2 border-ink/20">
        §5. Industry dynamics
      </h2>
      {deep.market_context && (
        <div className="rounded-xl border-l-[3px] border-blue-400 bg-blue-50/30 dark:bg-blue-500/[0.06] px-4 py-3 mb-4">
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-1">
            Market context
          </div>
          <p className="text-[13px] text-ink-soft leading-relaxed">{deep.market_context}</p>
        </div>
      )}
      <div className="grid md:grid-cols-2 gap-4">
        {deep.success_patterns.length > 0 && (
          <div className="rounded-xl border border-rule bg-surface p-4">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp size={14} className="text-emerald-600" />
              <h3 className="font-medium text-ink text-[14px]">Success patterns</h3>
            </div>
            <ul className="space-y-1.5 text-[12.5px] text-ink-soft">
              {deep.success_patterns.map((p, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-emerald-600 mt-0.5">+</span>
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {deep.failure_modes.length > 0 && (
          <div className="rounded-xl border border-rule bg-surface p-4">
            <div className="flex items-center gap-2 mb-2">
              <TrendingDown size={14} className="text-red-600" />
              <h3 className="font-medium text-ink text-[14px]">Failure modes</h3>
            </div>
            <ul className="space-y-1.5 text-[12.5px] text-ink-soft">
              {deep.failure_modes.map((f, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-red-600 mt-0.5">−</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {(!deep.success_patterns.length && !deep.failure_modes.length && !deep.market_context) && (
        <div className="rounded-xl border border-rule bg-bg-2/40 px-4 py-4 text-[13px] text-ink-soft">
          <AlertTriangle size={14} className="inline mr-1 text-amber-600" />
          No qualitative industry data seeded for this CAEN yet. Coverage expands —
          the percentile + named-peer comparisons above are the primary read.
        </div>
      )}
    </section>
  );
}
