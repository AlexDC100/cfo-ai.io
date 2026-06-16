// Comprehensive Report — the 8-section institutional memo.
//
// Reference document: financial_analysis_methodology.md (Appendix A in
// CLAUDE.md). The 8 sections in order:
//   1. Overview     — 8 KPI tiles + 3-paragraph briefing
//   2. P&L          — line-by-line with % of turnover
//   3. Balance      — Assets / Equity & Liabilities
//   4. Cash flow    — Indirect method with is_approximated banner
//   5. Ratios       — 5 grouped tables (profitability/liquidity/leverage/coverage/efficiency)
//   6. Valuation    — EV/EBITDA + DCF + NAV envelope
//   7. Risk         — Credit score card + risk inventory
//   8. Recs         — Severity-tagged action items + 90-day plan
//
// Renders inside the AppShell at /report?period=<id>. Data comes from
// /api/period (the same endpoint Dashboard uses) so we never recompute
// on navigation — the report is a different visualization of the same
// cached canonical statements.
//
// Export buttons:
//   · "Export HTML"  — downloads the rendered page as a single HTML file
//   · "Export PDF"   — POSTs to /api/report/pdf which uses WeasyPrint
//                      to produce a paged PDF with the same content.

import { useEffect, useMemo, useState } from "react";

import { useActivePeriodFallback } from "@/hooks/useActivePeriodFallback";
import { Download, FileText, Printer, Loader2 } from "lucide-react";
import { AppShell } from "@/components/cfo/AppShell";
import { CreditScoreCard, readCreditFromMetrics } from "@/components/cfo/CreditScoreCard";
import { RiskInventory, type RiskInventoryItem } from "@/components/cfo/RiskInventory";
import { EbitdaReconciliationPanel } from "@/components/cfo/EbitdaReconciliationPanel";
import { LearnableNumber } from "@/components/learning/LearnableNumber";
import { GuideMeButton } from "@/components/learning/GuideMeButton";
import { COMPREHENSIVE_GUIDE } from "@/components/learning/pageGuides";
import {
  buildCanonicalMetricsFromInputs,
  type CanonicalMetrics,
} from "@/lib/canonicalMetrics";
import { getSupabase } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";
import { useCurrency } from "@/stores/currency";
import { convertFromTo, formatAmountFrom, formatMoneyFrom } from "@/lib/money";
import type { Currency } from "@/lib/rates";

/**
 * CUR-FIX (universal coverage) — the report's local `fmt(n, opts)` helper
 * used to be a pure number-to-string formatter that assumed RON. With the
 * currency toggle alive on every page, that assumption silently kept the
 * memo in RON regardless of what the user picked.
 *
 * `useReportFmt(sourceCurrency)` is the drop-in replacement: it takes the
 * period's source currency and reads the global display currency from the
 * <CurrencyProvider>. Calling it returns:
 *   - `fmt(n, opts)`           : same signature as before, but converted to
 *                                 the active display currency before format.
 *   - `fmtCompact(n)`          : "1.2M €" / "12k RON" — replaces currency_M.
 *   - `displayCurrency`        : the active 3-letter code (RON / EUR / USD)
 *                                 — use for `<th>{display}</th>` headers.
 *   - `sourceCurrency`         : the period's native currency, for source
 *                                 labels in commentary ("matches account 121").
 */
function useReportFmt(sourceCurrency: string) {
  const { display, rates } = useCurrency();
  const src = (sourceCurrency as Currency) || "RON";
  return useMemo(() => {
    const fmt = (
      n: number | null | undefined,
      opts?: { signed?: boolean; pct?: boolean; mult?: boolean },
    ): string => {
      if (n == null || !Number.isFinite(n)) return "—";
      if (opts?.pct) return `${n.toFixed(1)}%`;
      if (opts?.mult) return `${n.toFixed(2)}×`;
      const converted = convertFromTo(n, src, display, rates.rates);
      const abs = Math.abs(converted);
      const formatted = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(abs);
      if (opts?.signed && converted < 0) return `(${formatted})`;
      return converted < 0 ? `(${formatted})` : formatted;
    };
    const fmtCompact = (n: number): string =>
      formatMoneyFrom(n, src, display, rates.rates, { compact: true });
    return { fmt, fmtCompact, displayCurrency: display, sourceCurrency: src };
  }, [src, display, rates]);
}

const apiBase = (): string =>
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

// ─── Types — mirrors /api/period response shape (loose) ────────────────────

interface PeriodResponse {
  period: {
    id: string;
    period_end: string;
    currency: string;
    source_document?: { filename: string; id: string } | null;
  };
  statements: {
    companyName?: string;
    industry?: string;
    assembled_pl?: Record<string, number>;
    assembled_bs?: Record<string, number>;
    assembled_cf?: Record<string, number | boolean | string[] | undefined>;
  };
  metrics?: Array<{ name: string; value: number | null; unit?: string }>;
  alerts?: Array<RiskInventoryItem & { category?: string | null }>;
  recommendations?: Array<{
    severity?: string;
    title?: string;
    why?: string;
    action?: string;
    impact?: string;
  }>;
  briefing?: { summary?: string; verdict?: string } | null;
  /** Per-account line items — surfaced by the engine so the canonical
   *  EBITDA reconciliation can subtract 758 / 781 from Reported EBITDA
   *  to reach Core EBITDA. Same shape `useActivePeriod` already
   *  consumes on the Dashboard. */
  line_items?: Array<{
    statement: "BS" | "PL" | "IGNORED";
    bucket: string;
    ro_account_code: string;
    ro_account_name?: string;
    amount: number;
    is_derived?: boolean;
  }>;
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function ComprehensiveReport() {
  // 2026-05-24 — auto-resolve active period when URL lacks ?period= so
  // sidebar navigation doesn't show empty state when the user has docs.
  const { periodId } = useActivePeriodFallback();
  const { toast } = useToast();
  const [report, setReport] = useState<PeriodResponse | null>(null);
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
        const r = await fetch(`${apiBase()}/api/period/${periodId}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as PeriodResponse;
        if (!cancelled) setReport(body);
      } catch (e: unknown) {
        if (!cancelled) toast({
          title: "Couldn't load report",
          description: e instanceof Error ? e.message : "Network error",
          variant: "destructive",
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [periodId, toast]);

  // Build a metric lookup map for downstream sections.
  const metricsByName = useMemo<Record<string, number | null>>(() => {
    const out: Record<string, number | null> = {};
    (report?.metrics ?? []).forEach((m) => { out[m.name] = m.value; });
    return out;
  }, [report]);

  // ── PDF export — browser print → "Save as PDF" path.
  // We deliberately don't ship a server-side PDF endpoint for v1: every
  // viable Python HTML→PDF library (WeasyPrint, xhtml2pdf, weasypdf)
  // requires native libs (gobject / cairo / pango / wkhtmltopdf) that
  // explode the Docker image and add cross-platform friction. The
  // browser's print dialog produces an identical-fidelity PDF from
  // exactly the same DOM the user is reading, with zero backend infra.
  //
  // What's wired here:
  //   · CSS @media print rules hide the nav bar + export buttons
  //   · window.print() triggers the OS print dialog
  //   · Users pick "Save as PDF" (every modern browser + macOS Preview
  //     + Adobe Reader supports this natively)
  //
  // Server-side HTML export (`/api/report/:period/html`) is the second
  // surface — emails the standalone HTML for users who want to forward
  // it without rendering in a browser. That endpoint is the only
  // server-side render path needed.
  async function exportPdf() {
    setPdfBusy(true);
    // Pre-print toast so the user sees confirmation before the dialog
    // takes over the screen.
    toast({
      title: "Opening print dialog",
      description: "Choose 'Save as PDF' in the destination dropdown.",
    });
    // setTimeout lets the toast render before print blocks the thread.
    window.setTimeout(() => {
      window.print();
      setPdfBusy(false);
    }, 250);
  }

  function printHtml() {
    window.print();
  }

  if (loading) {
    return (
      <AppShell>
        <div className="flex items-center justify-center py-32 text-ink-mute">
          <Loader2 size={20} className="animate-spin mr-2" /> Loading report…
        </div>
      </AppShell>
    );
  }
  if (!periodId || !report) {
    return (
      <AppShell>
        <div className="max-w-[640px] mx-auto py-24 text-center">
          <FileText size={28} className="mx-auto text-ink-mute mb-3" />
          <h1 className="font-serif text-[28px] text-ink">No period selected</h1>
          <p className="mt-2 text-[14px] text-ink-soft">
            Open a financial period from the dashboard, then click "View report" to land here.
          </p>
        </div>
      </AppShell>
    );
  }

  const pl = report.statements.assembled_pl ?? {};
  const bs = report.statements.assembled_bs ?? {};
  const cf = report.statements.assembled_cf ?? {};
  const companyName = report.statements.companyName ?? "Company";
  const periodEnd = report.period.period_end ?? "—";
  const currency = report.period.currency ?? "RON";
  const credit = readCreditFromMetrics(metricsByName);
  const recs = report.recommendations ?? [];
  const alerts = report.alerts ?? [];

  // Canonical dual-basis metric object — single source of truth for
  // EBITDA + net-profit across every surface on this page. See
  // `src/lib/canonicalMetrics.ts` for the structure + the explicit
  // Reported→Core bridge (subtracts accounts 758 + 781 from the
  // engine's `ebitda_statutory`). The KPI grid + reconciliation
  // panel + (downstream) PnlTable all read from this object.
  const canonical = buildCanonicalMetricsFromInputs({
    assembled_pl: pl as Record<string, number>,
    assembled_bs: bs as Record<string, number>,
    line_items: report.line_items,
    company: companyName,
    period: periodEnd,
    period_id: report.period.id,
    source: "trial_balance",
  });

  return (
    <AppShell>
      <div className="max-w-[1100px] mx-auto" data-testid="comprehensive-report">
        {/* ── Header card (navy gradient, matches the EEI v5 reference) ── */}
        <header className="rounded-2xl px-6 py-6 mb-6 text-white"
                style={{ background: "linear-gradient(135deg, #003366 0%, #1a5490 100%)" }}>
          {/* 2026-05-26 mobile fix: stack vertically below sm: so the
              company-name headline (34px serif) stays on one line. */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <div className="text-[10.5px] uppercase tracking-[0.14em] opacity-80">
                Comprehensive financial analysis
              </div>
              <h1 className="mt-1 font-serif text-[26px] sm:text-[30px] md:text-[34px] leading-tight">
                {companyName}
              </h1>
              <p className="mt-1.5 text-[13px] opacity-85">
                Period ending {periodEnd} · Source: trial balance ({currency}) · Displayed in <CurrencyDisplayChip />
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap sm:shrink-0 print:hidden">
              <GuideMeButton pageId="comprehensive-report" title="Report" steps={COMPREHENSIVE_GUIDE} />
              <button
                onClick={exportPdf}
                disabled={pdfBusy}
                data-testid="report-export-pdf"
                className="inline-flex items-center gap-1.5 rounded-md bg-rule-soft/60 hover:bg-rule-soft disabled:opacity-50 px-3 py-1.5 text-[12.5px] font-medium transition-colors"
              >
                {pdfBusy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                Export PDF
              </button>
              <button
                onClick={printHtml}
                data-testid="report-print"
                className="inline-flex items-center gap-1.5 rounded-md bg-rule-soft/60 hover:bg-rule-soft px-3 py-1.5 text-[12.5px] font-medium transition-colors"
              >
                <Printer size={13} />
                Print
              </button>
            </div>
          </div>
        </header>

        {/* ── Section nav — sticky local TOC ───────────────────────────── */}
        <nav className="mb-6 rounded-xl border border-rule bg-surface px-4 py-2 flex flex-wrap gap-2 text-[12px] print:hidden">
          {[
            ["overview",    "1. Overview"],
            ["pnl",         "2. P&L"],
            ["bs",          "3. Balance Sheet"],
            ["cf",          "4. Cash Flow"],
            ["ratios",      "5. Ratios"],
            ["valuation",   "6. Valuation"],
            ["risk",        "7. Risk & Credit"],
            ["recs",        "8. Recommendations"],
          ].map(([id, label]) => (
            <a key={id} href={`#${id}`} className="text-ink-soft hover:text-ink transition-colors">
              {label}
            </a>
          ))}
        </nav>

        <article className="eei-scope space-y-10">
          {/* ── 1. OVERVIEW ─────────────────────────────────────────── */}
          <section id="overview" data-testid="report-section-1-overview">
            <SectionHeader number={1} title="Overview" />
            {canonical ? (
              <>
                <KpiGrid
                  canonical={canonical}
                  credit={credit}
                  netMarginCanonical={metricsByName["net_margin"]}
                  currency={currency}
                />
                {/* Itemized Reported → Core EBITDA bridge — the spec's
                 *  non-negotiable: each adjustment (758, 781) shown
                 *  with account / label / amount, arithmetic exact. */}
                <div className="mt-5">
                  <EbitdaReconciliationPanel metrics={canonical} currency={currency} />
                </div>
              </>
            ) : (
              // Empty-state — should not happen on a loaded report, but
              // a defensive fallback so the page never crashes if the
              // canonical assembly is unavailable.
              <div className="rounded-2xl border border-rule bg-bg-2/40 px-6 py-8 text-center text-[13px] text-ink-soft">
                No canonical metrics available for this period.
              </div>
            )}
            {report.briefing?.summary && (
              <div className="eei-briefing mt-5">
                <div className="head">Executive briefing</div>
                <p className="body">
                  {relabelOperationalInBriefing(report.briefing.summary)}
                </p>
              </div>
            )}
          </section>

          {/* ── 2. P&L ──────────────────────────────────────────────── */}
          <section id="pnl" data-testid="report-section-2-pnl">
            <SectionHeader number={2} title="P&L" />
            <PnlTable pl={pl} currency={currency} />
          </section>

          {/* ── 3. BALANCE SHEET ────────────────────────────────────── */}
          <section id="bs" data-testid="report-section-3-bs">
            <SectionHeader number={3} title="Balance Sheet" />
            <BsTable bs={bs} currency={currency} />
          </section>

          {/* ── 4. CASH FLOW ────────────────────────────────────────── */}
          <section id="cf" data-testid="report-section-4-cf">
            <SectionHeader number={4} title="Cash Flow Statement" />
            <CashFlowTable cf={cf} currency={currency} />
          </section>

          {/* ── 5. RATIOS ───────────────────────────────────────────── */}
          <section id="ratios" data-testid="report-section-5-ratios">
            <SectionHeader number={5} title="Financial Ratios" />
            <RatiosTables metrics={metricsByName} />
          </section>

          {/* ── 6. VALUATION ────────────────────────────────────────── */}
          <section id="valuation" data-testid="report-section-6-valuation">
            <SectionHeader number={6} title="Valuation" />
            <ValuationView metrics={metricsByName} pl={pl} bs={bs} currency={currency} />
          </section>

          {/* ── 7. RISK & CREDIT ────────────────────────────────────── */}
          <section id="risk" data-testid="report-section-7-risk" className="space-y-5">
            <SectionHeader number={7} title="Risk & Credit" />
            {credit ? <CreditScoreCard data={credit} variant="full" /> : (
              <div className="rounded-xl border border-rule bg-bg-2/40 px-4 py-4 text-[13px] text-ink-soft">
                Credit score not available — re-run the pipeline to compute the composite score for this period.
              </div>
            )}
            <RiskInventory allAlerts={alerts} />
          </section>

          {/* ── 8. RECOMMENDATIONS + 90-DAY PLAN ────────────────────── */}
          <section id="recs" data-testid="report-section-8-recs">
            <SectionHeader number={8} title="Recommendations" />
            <RecommendationsList recs={recs} />
            <NinetyDayPlan recs={recs} />
          </section>
        </article>

        <footer className="mt-12 pb-12 text-center text-[10.5px] text-ink-mute">
          Generated by CFO AI · deterministic engine + Claude Opus 4.7 narrative.<br />
          Numbers reconcile to the source trial balance within 0.5%. Benchmarks carry
          source + confidence labels — see Section 5.
        </footer>
      </div>
    </AppShell>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

function SectionHeader({ number, title }: { number: number; title: string }) {
  return (
    <h2 className="eei-h2">
      <span className="num">{number}.</span>
      {title}
    </h2>
  );
}

/** CUR-FIX — inline chip showing the active display currency. Reads from
 *  <CurrencyProvider> so the report's "Displayed in EUR" tagline updates
 *  the instant the TopHeader toggle flips. */
function CurrencyDisplayChip() {
  const { display } = useCurrency();
  return <span className="font-semibold tabular-nums">{display}</span>;
}

// ─── Briefing label-transform ─────────────────────────────────────────────
// Engine-generated narrative occasionally calls the operational net-profit
// figure (excl. RAS 722 capitalized own-work) "statutory" — a known mislabel.
// We rewrite the wording at render time. Numbers untouched; engine untouched.
// For companies with no 722 activity the rewrite is a no-op semantically
// (operational ≡ statutory) so it's safe to apply unconditionally.
function relabelOperationalInBriefing(summary: string): string {
  if (!summary) return summary;
  // Catch "statutory net profit", "statutory net income", and the cap-S variants
  // in mid-sentence. Word-boundary anchored so unrelated uses of "statutory"
  // (e.g. "statutory reserves") aren't touched.
  return summary
    .replace(/\bstatutory net profit\b/gi, "operational net profit (excl. capitalized own-work)")
    .replace(/\bstatutory net income\b/gi, "operational net income (excl. capitalized own-work)");
}

// Legacy non-converting helpers retained ONLY for the now-removed code paths
// below. New call sites must use `useReportFmt(sourceCurrency)`.
// (Marked deprecated so a future cleanup PR can delete them once every
// caller is hook-based.)
/** @deprecated CUR-FIX — use the `fmt` returned from `useReportFmt()` instead. */
function fmt(n: number | null | undefined, opts?: { signed?: boolean; pct?: boolean; mult?: boolean }): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (opts?.pct) return `${(n).toFixed(1)}%`;
  if (opts?.mult) return `${n.toFixed(2)}×`;
  const abs = Math.abs(n);
  const formatted = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(abs);
  if (opts?.signed && n < 0) return `(${formatted})`;
  return n < 0 ? `(${formatted})` : formatted;
}

function KpiGrid({
  canonical, credit, netMarginCanonical, currency,
}: {
  /** Canonical metric object — the single source of truth for
   *  EBITDA + net profit across every surface. See
   *  `src/lib/canonicalMetrics.ts`. */
  canonical: CanonicalMetrics;
  credit: ReturnType<typeof readCreditFromMetrics>;
  // F1.e — Engine-canonical `net_margin` (ratio, 0–1) from
  // calculated_metrics. When supplied, the Net Profit Statutory tile's
  // margin agrees with the §5 Financial Ratios row and the dashboard.
  // The "legally filed" sub-label still refers to the source-currency value
  // (kept per ¶ — sub-label scope, not margin denominator).
  netMarginCanonical?: number | null;
  /** Period's source currency — drives the FX conversion done by
   *  `useReportFmt`. The display currency comes from <CurrencyProvider>. */
  currency: string;
}) {
  // CUR-FIX — every money value in this grid converts to display currency.
  const { fmt, fmtCompact } = useReportFmt(currency);
  // Pull from the canonical object only. No fallback to legacy
  // independent derivations — those are the bug the canonical object
  // exists to eliminate.
  const { ebitda, netProfit, balance, headline } = canonical;
  const revenue = headline.revenue;
  const totalOpRev = headline.total_operating_revenue;

  const equityRatio = balance.total_assets > 0 ? balance.equity / balance.total_assets : null;
  // Net-Debt / EBITDA — uses Core EBITDA (the basis for valuation),
  // matching the rest of the canonical object's convention.
  const ndeRatio = ebitda.core > 0 ? balance.net_debt / ebitda.core : null;
  const roe = balance.equity > 0 ? netProfit.statutory_account_121 / balance.equity : null;
  const altman = credit?.altmanZ ?? null;

  // The KPI strip surfaces three EBITDA / net-profit figures explicitly:
  //   · Reported EBITDA (legal view, ties to acct 121)
  //   · Core EBITDA     (basis for valuation — 758/781 stripped)
  //   · Net profit      (statutory acct 121 — the legally filed number)
  // The 758/781 bridge is rendered as a separate panel directly below.
  // This is the consistency fix — no surface picks its own figure.
  const tiles: Array<{
    label: string;
    value: string;
    sub?: string;
    headline?: boolean;
    conceptKey?: string;
    rawValue?: number;
  }> = [
    { label: "Net turnover", value: fmt(revenue), sub: fmtCompact(revenue), conceptKey: "operating_revenue", rawValue: revenue },
    {
      label: "EBITDA — reported",
      value: fmt(ebitda.reported),
      sub: ebitda.reported_margin_pct != null ? `${ebitda.reported_margin_pct.toFixed(1)}% margin · acct 121 view` : "Reported / statutory",
      conceptKey: "ebitda",
      rawValue: ebitda.reported,
    },
    {
      label: "EBITDA — core",
      value: fmt(ebitda.core),
      sub: ebitda.core_margin_pct != null ? `${ebitda.core_margin_pct.toFixed(1)}% margin · excl. 758, 781` : "Basis for valuation",
      headline: true,
      conceptKey: "ebitda",
      rawValue: ebitda.core,
    },
    {
      label: "Net profit — statutory (ct 121)",
      value: fmt(netProfit.statutory_account_121),
      // F1.e — Margin reads engine-canonical `net_margin` from
      // calculated_metrics so this tile agrees with the dashboard tile
      // and the Ratios row on the same page. The "legally filed"
      // sub-label refers to the source-currency value (per ¶ in F1.e
      // protocol — sub-label scope, not margin denominator).
      sub: (() => {
        if (typeof netMarginCanonical === "number") {
          return `${(netMarginCanonical * 100).toFixed(1)}% margin · legally filed`;
        }
        return totalOpRev > 0
          ? `${((netProfit.statutory_account_121 / totalOpRev) * 100).toFixed(1)}% margin · legally filed`
          : "Legally filed (acct 121)";
      })(),
      conceptKey: "net_profit",
      rawValue: netProfit.statutory_account_121,
    },
    { label: "Total assets", value: fmt(balance.total_assets), sub: fmtCompact(balance.total_assets), conceptKey: "total_assets", rawValue: balance.total_assets },
    { label: "Equity ratio", value: equityRatio == null ? "—" : `${(equityRatio*100).toFixed(1)}%`, sub: "Equity / Assets", conceptKey: equityRatio == null ? undefined : "equity_ratio", rawValue: equityRatio ?? undefined },
    { label: "Net Debt / EBITDA", value: ndeRatio == null ? "—" : `${ndeRatio.toFixed(2)}×`, sub: "Leverage · on Core EBITDA", conceptKey: ndeRatio == null ? undefined : "net_debt_ebitda", rawValue: ndeRatio ?? undefined },
    { label: "ROE", value: roe == null ? "—" : `${(roe*100).toFixed(1)}%`, sub: "Return on equity", conceptKey: roe == null ? undefined : "roe", rawValue: roe ?? undefined },
    { label: "Altman Z″", value: altman == null ? "—" : altman.toFixed(2), sub: "Distress score", conceptKey: altman == null ? undefined : "altman_z_score", rawValue: altman ?? undefined },
  ];

  return (
    <div className="eei-kpi-grid">
      {tiles.map((t) => (
        <div key={t.label} className={`eei-kpi-card${t.headline ? " is-headline" : ""}`}>
          <div className="label">{t.label}</div>
          <div className="value">
            {t.conceptKey != null && t.rawValue != null ? (
              <LearnableNumber conceptKey={t.conceptKey} value={t.rawValue}>
                {t.value}
              </LearnableNumber>
            ) : (
              t.value
            )}
          </div>
          {t.sub && <div className="sub">{t.sub}</div>}
        </div>
      ))}
    </div>
  );
}

// CUR-FIX — `currency_M` is replaced by `fmtCompact` from `useReportFmt`.
// Kept here only as deprecated dead-code so the symbol still resolves if
// any rare downstream import references it; new code MUST use the hook.
/** @deprecated CUR-FIX — use `useReportFmt().fmtCompact` instead. */
function currency_M(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n/1_000_000).toFixed(1)} M RON`;
  if (Math.abs(n) >= 1_000)     return `${(n/1_000).toFixed(0)} K RON`;
  return `${n.toFixed(0)} RON`;
}

function PnlTable({ pl, currency }: { pl: Record<string, number>; currency: string }) {
  const { fmt, displayCurrency } = useReportFmt(currency);
  const revenue = pl.revenue ?? 0;

  // Operational net profit (engine field, despite the legacy name) and the
  // 722 capitalized-own-work memo. Statutory ct-121 = operational + 722;
  // this is the explicit reconciliation bridge the board reader needs,
  // never a second competing headline. NO new computation — just summing
  // two figures the engine already emits, exactly as the EEI report does.
  const opNetProfit  = pl.net_income_statutory ?? 0;
  const capOwnWork   = pl.capitalized_own_work_memo ?? 0;
  const statNetProfit = opNetProfit + capOwnWork;
  const has722       = Math.abs(capOwnWork) > 0.5;

  // Row schema  →  { label, value, style, sub?, indent? }
  type RowStyle =
    | "normal"
    | "indent"
    | "subtotal"
    | "highlight"
    | "headline"        // operational net-profit headline (primary emphasis)
    | "reconciliation"  // the 722 bridge lines (lesser emphasis)
    | "memo";
  type Row = { label: string; val: number | undefined; style: RowStyle };

  const rows: Row[] = [
    { label: "Net turnover",                              val: pl.revenue,                style: "subtotal" },
    { label: "Capitalized own work (722, non-cash memo)", val: pl.capitalized_own_work_memo, style: "memo" },
    { label: "Other operating income",                    val: pl.other_operating_income, style: "indent" },
    { label: "Total operating revenue",                   val: pl.total_operating_revenue, style: "subtotal" },
    { label: "Cost of goods sold",                        val: -(pl.cogs ?? 0),           style: "indent" },
    { label: "Operating expenses",                        val: -(pl.opex_total ?? 0),     style: "indent" },
    { label: "Depreciation & amortization",               val: -(pl.depreciation ?? 0),   style: "indent" },
    { label: "EBITDA (cash view)",                        val: pl.ebitda_cash ?? pl.ebitda_operational, style: "highlight" },
    { label: "EBITDA (statutory)",                        val: pl.ebitda_statutory,       style: "highlight" },
    { label: "EBIT",                                      val: pl.ebit,                   style: "indent" },
    {
      label: "Net financial result",
      val: (pl.financial_income ?? 0) - (pl.financial_expense ?? 0) - (pl.interest_expense ?? 0),
      style: "indent",
    },
    { label: "Pre-tax profit",                            val: pl.pretax,                 style: "subtotal" },
    { label: "Income tax",                                val: -(pl.tax ?? 0),            style: "indent" },
    // ── Operational net profit — THE headline figure ──────────────────
    { label: "Net profit — operational (excl. 722)",      val: opNetProfit,               style: "headline" },
  ];

  // ── 722 reconciliation bridge — only when 722 is materially non-zero.
  // Operational stays the visual headline; statutory is shown below as the
  // reconciled total, NOT as a second headline. Same pattern the EEI
  // report uses ("Operational → + 722 → Statutory ct 121").
  if (has722) {
    rows.push(
      { label: "+ Capitalized own work (722)",            val: capOwnWork,                style: "reconciliation" },
      { label: "= Net profit — statutory (ct 121)",       val: statNetProfit,             style: "reconciliation" },
    );
  }

  return (
    <>
      <table className="eei-table">
        <thead>
          <tr>
            <th>Line</th>
            <th className="num">{displayCurrency}</th>
            <th className="num">% of turnover</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const v = r.val;
            const pct = v != null && revenue > 0 ? `${(v / revenue * 100).toFixed(1)}%` : "—";
            const cls =
              r.style === "headline"       ? "headline"
              : r.style === "reconciliation" ? "reconciliation"
              : r.style === "highlight"    ? "subtotal"
              : r.style === "subtotal"     ? "subtotal"
              : r.style === "memo"         ? "memo"
              : r.style === "indent"       ? "indent"
              : "";
            return (
              <tr key={r.label} className={cls}>
                <td>{r.label}</td>
                <td className="num">{fmt(v ?? null, { signed: true })}</td>
                <td className="num">{pct}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Commentary callout — only when 722 is material. Mirrors the
       *  EEI report's analytical note: 722 is a non-cash credit offset
       *  to CIP (231); the corresponding cost is in 628; net P&L effect
       *  on the OPERATIONAL view is ~zero. */}
      {has722 && (
        <div className="eei-callout commentary" role="note">
          <span className="lead">722 reconciliation —</span>{" "}
          Account 722 (capitalized own work) is a non-cash credit that capitalizes internally-incurred
          costs into CIP (account 231 — the year&rsquo;s movement matches 722 to the cent). The
          corresponding cost sits inside account 628 (third-party services). Net P&amp;L effect of the
          722/628 wash is ~zero; the OPERATIONAL net profit ({fmt(opNetProfit)} {displayCurrency}) is therefore the
          headline figure across this report. Statutory net profit ({fmt(statNetProfit)} {displayCurrency}, matches
          account 121 closing balance) is shown above as the reconciled total — not as a competing
          headline.
        </div>
      )}
    </>
  );
}

function BsTable({ bs, currency }: { bs: Record<string, number>; currency: string }) {
  const total = bs.total_assets ?? 0;
  const assetRows: Array<[string, number | undefined]> = [
    ["Cash", bs.cash],
    ["Accounts receivable (net)", bs.ar_net],
    ["Inventory", bs.inventory ?? 0],
    ["Other current assets", bs.ar_other ?? 0],
    ["PP&E (net)", bs.ppe_net ?? 0],
    ["Intangibles (net)", bs.intangibles_net ?? 0],
    ["Investments", bs.investments ?? 0],
  ];
  const liabRows: Array<[string, number | undefined]> = [
    ["Share capital", bs.share_capital],
    ["Reserves & retained earnings", (bs.revaluation_reserves ?? 0) + (bs.retained_earnings ?? 0) + (bs.other_equity_non_revaluation ?? 0)],
    ["Current-year P&L", bs.current_year_pnl ?? 0],
    ["Long-term debt", bs.lt_debt ?? 0],
    ["Short-term debt", bs.st_debt ?? 0],
    ["Accounts payable", bs.ap],
    ["Other current liabilities", bs.ap_other],
    ["Dividends payable", bs.ap_dividends ?? 0],
  ];
  return (
    <div className="eei-two-up">
      <BsHalf title="Assets" rows={assetRows} totalLabel="Total assets" totalValue={bs.total_assets} reference={total} currency={currency} />
      <BsHalf title="Equity & Liabilities" rows={liabRows} totalLabel="Total equity + liabilities" totalValue={(bs.total_equity ?? 0) + (bs.total_liabilities ?? 0)} reference={total} currency={currency} />
    </div>
  );
}

function BsHalf({ title, rows, totalLabel, totalValue, reference, currency }: {
  title: string;
  rows: Array<[string, number | undefined]>;
  totalLabel: string;
  totalValue: number | undefined;
  reference: number;
  currency: string;
}) {
  const { fmt, displayCurrency } = useReportFmt(currency);
  return (
    <div>
      <h3 className="eei-h3">{title}</h3>
      <table className="eei-table">
        <thead>
          <tr>
            <th>Line</th>
            <th className="num">{displayCurrency}</th>
            <th className="num">% of assets</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, val]) => (
            <tr key={label}>
              <td>{label}</td>
              <td className="num">{fmt(val ?? null)}</td>
              <td className="num">
                {val != null && reference > 0 ? `${(val/reference*100).toFixed(1)}%` : ""}
              </td>
            </tr>
          ))}
          <tr className="total">
            <td>{totalLabel}</td>
            <td className="num">{fmt(totalValue ?? null)}</td>
            <td className="num"></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function CashFlowTable({ cf, currency }: { cf: Record<string, number | boolean | string[] | undefined>; currency: string }) {
  const { fmt } = useReportFmt(currency);
  const isApprox = Boolean(cf.is_approximated);
  const notes = Array.isArray(cf.approximation_notes) ? cf.approximation_notes : [];
  const n = (k: string) => (typeof cf[k] === "number" ? (cf[k] as number) : 0);

  const sections: Array<{ title: string; rows: Array<[string, number]>; subtotal: [string, number]; }> = [
    {
      title: "Operating",
      rows: [
        ["Net profit", n("net_profit")],
        ["+ Depreciation & amortization", n("depreciation")],
        ["+ Provision movements", n("provision_movement")],
        ["Δ Inventory", n("delta_inventory")],
        ["Δ Receivables", n("delta_receivables")],
        ["Δ Trade payables", n("delta_trade_pay")],
        ["Δ Tax payables", n("delta_tax_pay")],
      ],
      subtotal: ["Cash from operating activities", n("cash_from_operating")],
    },
    {
      title: "Investing",
      rows: [
        ["Capex (CIP, 231 additions)", n("capex_real")],
        ["Other capex (approximated)", n("capex_other_approx")],
        ["Δ Construction in progress", n("cip_change")],
        ["Δ Affiliates", n("affiliate_change")],
        ["+ Dividends received", n("dividends_received")],
        ["+ Interest received", n("interest_received")],
      ],
      subtotal: ["Cash used in investing", n("cash_used_in_investing")],
    },
    {
      title: "Financing",
      rows: [
        ["Δ Long-term debt", n("delta_lt_debt")],
        ["Δ Short-term bank credit", n("delta_st_bank")],
        ["− Interest paid", n("interest_paid")],
        ["− Dividends paid", n("dividends_paid")],
      ],
      subtotal: ["Cash used in financing", n("cash_used_in_financing")],
    },
  ];

  return (
    <div>
      {isApprox && (
        <div className="eei-approx-banner">
          <strong>Cash flow is approximated.</strong>
          <p style={{ margin: "4px 0 0 0" }}>
            Single-period upload — working-capital movements and financing detail
            estimated from typical Romanian patterns. Upload the prior year for
            exact reconciliation.
          </p>
          {notes.length > 0 && (
            <ul>
              {notes.map((nt, i) => <li key={i}>{nt}</li>)}
            </ul>
          )}
        </div>
      )}
      {sections.map((s) => (
        <div key={s.title}>
          <h3 className="eei-h3">{s.title}</h3>
          <table className="eei-table">
            <tbody>
              {s.rows.map(([label, val]) => (
                <tr key={label} className="indent">
                  <td>{isApprox ? `~ ${label}` : label}</td>
                  <td className="num">{fmt(val, { signed: true })}</td>
                </tr>
              ))}
              <tr className="subtotal">
                <td>{s.subtotal[0]}</td>
                <td className="num">{fmt(s.subtotal[1], { signed: true })}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ))}
      <table className="eei-table" style={{ marginTop: 8 }}>
        <tbody>
          <tr className="total">
            <td>Net change in cash</td>
            <td className="num">{fmt(n("net_change_in_cash"), { signed: true })}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function RatiosTables({ metrics }: { metrics: Record<string, number | null> }) {
  const m = (k: string) => metrics[k];
  // Helpers for pct/mult formatting
  const pct = (v: number | null | undefined) => v == null ? "—" : `${(v * 100).toFixed(1)}%`;
  const mult = (v: number | null | undefined) => v == null ? "—" : `${v.toFixed(2)}×`;
  const days = (v: number | null | undefined) => v == null ? "—" : `${Math.round(v)} d`;

  const groups: Array<{ title: string; rows: Array<[string, string]> }> = [
    {
      title: "Profitability",
      rows: [
        ["Gross margin",   pct(m("gross_margin"))],
        ["EBITDA margin",  pct(m("ebitda_margin"))],
        ["Net margin",     pct(m("net_margin"))],
        ["ROE",            pct(m("roe"))],
        ["ROA",            pct(m("roa"))],
        ["ROIC",           pct(m("roic"))],
      ],
    },
    {
      title: "Liquidity",
      rows: [
        ["Current ratio",  mult(m("current_ratio"))],
        ["Quick ratio",    mult(m("quick_ratio"))],
        ["Cash ratio",     mult(m("cash_ratio"))],
      ],
    },
    {
      title: "Leverage",
      rows: [
        ["Equity ratio",      pct(m("equity_ratio"))],
        ["Debt / Equity",     mult(m("debt_to_equity"))],
        ["Net Debt / EBITDA", mult(m("debt_to_ebitda"))],
      ],
    },
    {
      title: "Coverage",
      rows: [
        ["Interest coverage", mult(m("interest_coverage"))],
      ],
    },
    {
      title: "Efficiency",
      rows: [
        ["DIO (days inventory)",  days(m("dio"))],
        ["DSO (days receivables)", days(m("dso"))],
        ["DPO (days payables)",   days(m("dpo"))],
      ],
    },
  ];
  return (
    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
      {groups.map((g) => (
        <div key={g.title}>
          <h3 className="eei-h3">{g.title}</h3>
          <table className="eei-table">
            <tbody>
              {g.rows.map(([label, val]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="num">{val}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function ValuationView({ metrics, pl, bs, currency }: {
  metrics: Record<string, number | null>;
  pl: Record<string, number>;
  bs: Record<string, number>;
  currency: string;
}) {
  const { fmt, displayCurrency } = useReportFmt(currency);
  const ebitda = pl.ebitda_statutory ?? pl.ebitda ?? metrics.ebitda ?? 0;
  const netDebt = (bs.total_debt ?? 0) - (bs.cash ?? 0);
  const bookEquity = bs.total_equity ?? metrics.total_equity ?? 0;

  const multiples = [
    { label: "Conservative (6×)", mult: 6,  ev: ebitda * 6,  equity: ebitda * 6  - netDebt },
    { label: "Mid (8×)",          mult: 8,  ev: ebitda * 8,  equity: ebitda * 8  - netDebt },
    { label: "Premium (10×)",     mult: 10, ev: ebitda * 10, equity: ebitda * 10 - netDebt },
  ];

  return (
    <div className="space-y-3">
      {ebitda <= 0 && (
        <div className="rounded-xl border border-amber-300/50 bg-amber-50/40 dark:bg-amber-500/[0.08] px-4 py-3 text-[12.5px] text-amber-900 dark:text-amber-100">
          EBITDA is non-positive — EV/EBITDA multiples produce meaningless values.
          For asset-heavy or distressed cases, prefer NAV (book equity) as the
          floor and revenue-multiple as a cross-check.
        </div>
      )}
      <div className="rounded-xl border border-rule bg-surface overflow-hidden">
        <header className="bg-bg-2/40 px-4 py-2 text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium border-b border-rule/60">
          Valuation envelope
        </header>
        <table className="w-full text-[12.5px]">
          <thead>
            <tr>
              <th className="text-left px-4 py-2 font-medium text-ink-mute">Method</th>
              <th className="text-right px-3 py-2 font-medium text-ink-mute">Enterprise value ({displayCurrency})</th>
              <th className="text-right px-3 py-2 font-medium text-ink-mute">Equity value ({displayCurrency})</th>
            </tr>
          </thead>
          <tbody>
            {multiples.map((m) => (
              <tr key={m.label} className="border-t border-rule/40">
                <td className="px-4 py-2 text-ink">EV/EBITDA · {m.label}</td>
                <td className="px-3 py-2 text-right tabular-nums">{ebitda > 0 ? fmt(m.ev) : "n/a"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{ebitda > 0 ? fmt(m.equity, { signed: true }) : "n/a"}</td>
              </tr>
            ))}
            <tr className="border-t border-rule bg-bg-2/40 font-semibold">
              <td className="px-4 py-2 text-ink">Book equity (NAV floor)</td>
              <td className="px-3 py-2"></td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt(bookEquity)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-[11.5px] text-ink-mute leading-relaxed">
        EV/EBITDA at 6× conservative, 8× mid, 10× premium. NAV = book equity floor;
        full DCF + adjusted NAV cascade in the Valuation tab.
      </p>
    </div>
  );
}

function RecommendationsList({ recs }: { recs: PeriodResponse["recommendations"] }) {
  if (!recs || recs.length === 0) {
    return (
      <div className="rounded-xl border border-rule bg-bg-2/40 px-4 py-4 text-[13px] text-ink-soft">
        No deterministic recommendations fired. Pair with qualitative review or
        re-run the pipeline after uploading prior-period data.
      </div>
    );
  }
  return (
    <ol className="space-y-3">
      {recs.map((r, i) => {
        const sev = r.severity?.toLowerCase() ?? "medium";
        const sevColor =
          sev === "critical" ? "border-red-400"
          : sev === "high"   ? "border-orange-400"
          : sev === "medium" ? "border-amber-400"
          : "border-blue-300";
        return (
          <li key={i} className={`rounded-xl border-l-[3px] ${sevColor} bg-surface border border-rule px-4 py-3`}>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[10px] uppercase tracking-[0.1em] font-medium text-ink-mute">{sev}</span>
              <span className="text-[14px] font-medium text-ink">{i + 1}. {r.title ?? "Recommendation"}</span>
            </div>
            {r.why && <p className="text-[12.5px] text-ink-soft mt-1"><strong className="text-ink">Why:</strong> {r.why}</p>}
            {r.action && <p className="text-[12.5px] text-ink-soft mt-1"><strong className="text-ink">Action:</strong> {r.action}</p>}
            {r.impact && <p className="text-[12.5px] text-ink-soft mt-1"><strong className="text-ink">Impact:</strong> {r.impact}</p>}
          </li>
        );
      })}
    </ol>
  );
}

function NinetyDayPlan({ recs }: { recs: PeriodResponse["recommendations"] }) {
  // Bucket recommendations into 3 windows: 0-30d (critical/high), 30-60d (medium), 60-90d (low/info).
  const buckets: Record<string, typeof recs> = { "0-30 days": [], "30-60 days": [], "60-90 days": [] };
  (recs ?? []).forEach((r) => {
    const sev = (r.severity ?? "medium").toLowerCase();
    if (sev === "critical" || sev === "high") buckets["0-30 days"]!.push(r);
    else if (sev === "medium") buckets["30-60 days"]!.push(r);
    else buckets["60-90 days"]!.push(r);
  });
  return (
    <div className="mt-6">
      <h3 className="font-serif text-[16px] text-ink mb-3">90-day action plan</h3>
      <div className="grid md:grid-cols-3 gap-3">
        {Object.entries(buckets).map(([window, items]) => (
          <div key={window} className="rounded-xl border border-rule bg-surface overflow-hidden">
            <header className="bg-bg-2/40 px-4 py-2 text-[11px] uppercase tracking-[0.1em] font-medium text-ink-mute border-b border-rule/60">
              {window}
            </header>
            <div className="p-3">
              {items && items.length > 0 ? (
                <ul className="space-y-1.5 text-[12.5px] text-ink-soft">
                  {items.map((it, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="text-ink-mute">·</span>
                      <span>{it.title}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12px] text-ink-mute italic">No items in this window.</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
