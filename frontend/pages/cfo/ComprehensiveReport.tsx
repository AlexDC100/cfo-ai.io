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
// Instrument pass (2026-08): the board-grade CSS (ctrl-*) is fully evicted
// from this page — panels/chips/header from the kit, every figure mono
// via the Amount family, semantic color only on severity/sentiment.
import { Chip, PageHeader as InstrumentPageHeader, Panel, PanelHeader, type ChipTone } from "@/components/instrument/Panel";
import { Amount } from "@/components/instrument/Amount";
import { provenanceOf, type AmountProvenance } from "@/components/instrument/Provenance";
import {
  CappedMultiple,
  MoneyAmount,
  MoneyAmountGroup,
  PercentLevel,
} from "@/components/comparison/MoneyAmount";

// ── where a report figure comes from ──────────────────────────────────
//
// Every table on this page reads a field off the served envelope by
// name — `assembled_pl.revenue`, `assembled_bs.cash`,
// `assembled_cf.delta_inventory` — so the field path IS the origin, and
// a reader with the /api/period JSON can open it. The uploaded document
// rides in front when the period names one. A row that ADDS or NEGATES
// served fields says so in `method` and names the fields it combined;
// nothing here points a derived row at a field that does not contain it.
//
// The KPI tiles at the top sit inside `LearnableNumber` (a button) and
// stay plain — nesting the affordance in a control would put one
// interactive element inside another. Same known gap the balance sheet
// carries. The ratio tables render through PercentLevel / CappedMultiple,
// which carry no provenance prop, and the valuation envelope is client
// arithmetic over the reader's multiples; both stay plain and are
// recorded as such in the census.

interface ReportOrigin {
  /** `assembled_pl.<field>` → the card. */
  field: (path: string, note?: string) => AmountProvenance | null;
  /** A row this page computed from served fields. */
  derived: (formula: string) => AmountProvenance | null;
}

function reportOrigin(sourceDocument: string | null | undefined, periodEnd: string): ReportOrigin {
  const doc = sourceDocument && sourceDocument.length > 0 ? sourceDocument : null;
  return {
    field: (path, note) =>
      provenanceOf({
        source: [doc, path].filter(Boolean).join(" · "),
        method: note,
        period: periodEnd,
      }),
    derived: (formula) => provenanceOf({ method: `derived · ${formula}`, period: periodEnd }),
  };
}

// ── ABSENT ≠ ZERO ─────────────────────────────────────────────────────
//
// Every table below reads fields off `assembled_pl` / `assembled_bs` /
// `assembled_cf`, and a field the pack never emitted is ABSENT, not
// zero (PS1 — the HU pack really does serve `assembled_cf: {}`). Until
// 2026-09-04 twenty-three sites read `pl.cogs ?? 0` and handed the zero
// to a row whose origin named `assembled_pl.cogs`: measured with four
// fields absent, 27 of 51 affordances opened a Source over a "0" the
// source did not contain (critic finding #1, ea6df1f). An absent field
// now stays undefined, the cell paints its gap state ("—"), and the
// affordance — which refuses an absent figure — paints no card. A row
// this page DERIVES from served fields is absent when any addend is: a
// sum with a hole in it is not a figure.
function negated(v: number | null | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? -v : undefined;
}
function sumOf(...parts: Array<number | null | undefined>): number | undefined {
  let total = 0;
  for (const p of parts) {
    if (typeof p !== "number" || !Number.isFinite(p)) return undefined;
    total += p;
  }
  return total;
}
import { CreditScoreCard, readCreditFromMetrics } from "@/components/cfo/CreditScoreCard";
import { useTranslation } from "react-i18next";
import { ratioLabelForKey } from "@/lib/ratioTable";
import { readInventoryDaysSplit } from "@/lib/inventoryDays";
import { CF_ADD_BACK_LABEL_EN, addBackHoldsProvisionCharges } from "@/lib/buildCashFlowStatement";
import { InventoryDaysSplit } from "@/components/cfo/ratios/InventoryDaysSplit";
import { IndustryConfirmBanner } from "@/components/cfo/IndustryConfirmBanner";
import { blocksSectorContent, readIndustrySignal } from "@/lib/industrySignal";
import { RiskInventory, type RiskInventoryItem } from "@/components/cfo/RiskInventory";
import { EbitdaReconciliationPanel } from "@/components/cfo/EbitdaReconciliationPanel";
import { marginRefusalOf, type MarginBilingual } from "@/lib/marginMeaning";
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
import {
  componentShown, equityRefusalOf, netIncomeRefusalOf, netProvisionsEffectLabel, readRefusal,
  readServedOneEbitda, reconLine,
} from "@/lib/servedOneEbitda";
import { briefingVisibility } from "@/lib/briefingDefinition";
import { reportFooterLines } from "@/lib/reportFooter";
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
    /** The engine's verdict on whether a margin over turnover is meaningful
     *  (engine.ratios.margin_meaning), read through lib/marginMeaning. */
    margin_meaning?: unknown;
    /** The ONE inventory-days block (engine.ratios.inventory_days), read
     *  through lib/inventoryDays. */
    inventory_days?: unknown;
    assembled_pl?: Record<string, number>;
    assembled_bs?: Record<string, number>;
    assembled_cf?: Record<string, number | boolean | string[] | undefined>;
    /** canonical_bs v2 — the engine's balance-sheet authority, with its
     *  status and difference. The footer reads it through lib/reportFooter. */
    canonical_bs?: unknown;
  };
  /** What the ACCOUNT MIX says the company does, whether that agrees
   *  with `organizations.industry_key`, and — the field this page acts
   *  on — `block_sector_content`. Computed once in
   *  `src/engine/industry/structural_signal.py`; this page renders the
   *  verdict, it does not re-derive it. Absent on older period
   *  responses, in which case nothing is blocked (the behaviour before
   *  the check existed). */
  industry_signal?: unknown;
  /** F1.i canonical envelope — the SAME field `lib/activePeriod.ts` has
   *  read off this endpoint since F2.4 to score the Dashboard's Risks
   *  tab. It rode this page's own `/api/period/:id` response the whole
   *  time; this page just never declared it, so Section 7 minted its
   *  letter grade from a hardcoded frontend band ladder while every
   *  other surface read the engine's. See `CreditScoreCard`. */
  assembled_metrics?: {
    credit?: import("@/lib/financialValuation").CreditEnvelope | null;
  } | null;
  metrics?: Array<{ name: string; value: number | null; unit?: string }>;
  alerts?: Array<RiskInventoryItem & { category?: string | null }>;
  recommendations?: Array<{
    severity?: string;
    title?: string;
    why?: string;
    action?: string;
    impact?: string;
  }>;
  /** `GET /api/period` serves `body` (+ its EBITDA `definition`); `summary`
   *  is the older report shape, read when present. */
  briefing?: {
    summary?: string;
    verdict?: string;
    body?: string | null;
    definition?: unknown;
    unavailable?: boolean;
    stale?: unknown;
  } | null;
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
  const { t, i18n } = useTranslation();
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
      <>
        <div className="flex items-center justify-center py-32 text-ink-mute">
          <Loader2 size={20} className="animate-spin mr-2" /> Loading report…
        </div>
      </>
    );
  }
  if (!periodId || !report) {
    return (
      <>
        <div className="max-w-[640px] mx-auto py-24 text-center">
          <FileText size={28} className="mx-auto text-ink-mute mb-3" />
          <h1 className="text-[22px] font-semibold tracking-[-0.005em] text-ink">No period selected</h1>
          <p className="mt-2 text-[14px] text-ink-soft">
            Open a financial period from the dashboard, then click "View report" to land here.
          </p>
        </div>
      </>
    );
  }

  const pl = report.statements.assembled_pl ?? {};
  const bs = report.statements.assembled_bs ?? {};
  const cf = report.statements.assembled_cf ?? {};
  const companyName = report.statements.companyName ?? "Company";
  const periodEnd = report.period.period_end ?? "—";
  const currency = report.period.currency ?? "RON";
  const origin = reportOrigin(report.period.source_document?.filename, periodEnd);
  // ONE LETTER, ONE LADDER. The card is handed the engine's credit
  // envelope so Section 7's grade comes from `letter_grade` / the
  // engine's own `letter_grade_bands` — the same authority the Risks
  // tab, the hero card and the exported workbook read — instead of the
  // frontend band table that used to live in CreditScoreCard.tsx.
  const credit = readCreditFromMetrics(metricsByName, report.assembled_metrics?.credit ?? null);
  const recs = report.recommendations ?? [];
  const alerts = report.alerts ?? [];

  // ── THE INDUSTRY GATE ───────────────────────────────────────────────
  // `organizations.industry_key` is a USER SETTING; until this landed
  // nothing checked it against the book, and the Agras Dec-2025 report
  // went out headed "Real estate · residential rental" over 301 raw
  // materials, 341/345 own-produced stock and 70.5M of cost of sales,
  // with recommendations about vacancy, LTV and single-tenant risk.
  //
  // The reading, the comparison and the verdict are computed ONCE
  // engine-side (`src/engine/industry/structural_signal.py`) and served
  // on this response. When they disagree at FAMILY level the report
  // shows the confirm prompt and withholds everything calibrated by
  // sector — the AI narrative (§1), the profile-gated findings (§7) and
  // the recommendations built on them (§8). Everything sector-
  // INDEPENDENT — the statements, the cash walk, the ratios, the
  // valuation envelope, the credit score — renders unchanged: a
  // disputed industry must not blank a report that is mostly not about
  // the industry at all.
  const industrySignal = readIndustrySignal(report.industry_signal);
  const sectorBlocked = blocksSectorContent(industrySignal);
  const withheldNote = (what: string) => (
    <div
      data-testid="sector-content-withheld"
      className="rounded-md border border-rule bg-bg-2/40 px-4 py-4 text-[13px] text-ink-soft"
    >
      {what} is calibrated by sector and is withheld until the industry above
      is confirmed. Nothing was computed differently — it is not shown,
      because it would be read as a claim about a sector this book may not
      belong to.
    </div>
  );

  // Canonical dual-basis metric object — single source of truth for
  // EBITDA + net-profit across every surface on this page. See
  // `src/lib/canonicalMetrics.ts` for the structure + the explicit
  // Reported→Core bridge (subtracts accounts 758 + 781 from the
  // engine's `ebitda_statutory`). The KPI grid + reconciliation
  // panel + (downstream) PnlTable all read from this object.
  // The executive briefing, hidden with the engine's note when it was
  // written under an earlier EBITDA definition, and replaced by a one-line
  // note when the stored row is a failure text (lib/briefingDefinition) —
  // "[NARRATIVE_UNAVAILABLE]" was once printed here as the briefing.
  const briefingShown = briefingVisibility(
    report.briefing ? { ...report.briefing, body: report.briefing.body ?? report.briefing.summary } : null,
  );
  const footer = reportFooterLines({
    statements: report.statements,
    currency,
    briefingShown: !sectorBlocked && briefingShown.body !== null,
    // Section 6 (Valuation) on this page is computed in the browser.
    browserValuation: true,
    language: i18n.language,
  });
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
    <>
      <div className="max-w-[1100px]" data-testid="comprehensive-report">
        {/* ── A3 hero eviction — the navy-gradient banner becomes the
            compact instrument header; the memo identity survives in the
            eyebrow. ── */}
        <div className="mb-6 pb-4 border-b border-rule">
          <InstrumentPageHeader
            eyebrow="Comprehensive financial analysis"
            title={companyName}
            context={
              <span>
                Period ending <span className="font-mono tabular-nums">{periodEnd}</span>
                {" · "}trial balance ({currency}) · displayed in <CurrencyDisplayChip />
              </span>
            }
            actions={
              <div className="flex items-center gap-2 flex-wrap print:hidden">
                <GuideMeButton pageId="comprehensive-report" title="Report" steps={COMPREHENSIVE_GUIDE} />
                <button
                  onClick={exportPdf}
                  disabled={pdfBusy}
                  data-testid="report-export-pdf"
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-ink text-paper disabled:opacity-50 text-[12.5px] font-medium hover:bg-ink/90 transition-colors duration-micro"
                >
                  {pdfBusy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                  Export PDF
                </button>
                <button
                  onClick={printHtml}
                  data-testid="report-print"
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-rule bg-surface text-ink text-[12.5px] font-medium hover:bg-bg-2 transition-colors duration-micro"
                >
                  <Printer size={13} />
                  Print
                </button>
              </div>
            }
          />
        </div>

        {/* ── Industry gate — the confirm prompt, above everything it
            withholds, so a reader meets the disagreement before the
            report it changes. ── */}
        {sectorBlocked && industrySignal && <IndustryConfirmBanner signal={industrySignal} />}

        {/* ── Section nav — local TOC ──────────────────────────────────── */}
        <nav className="mb-6 rounded-md border border-rule bg-surface px-4 py-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] print:hidden">
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

        <article className="space-y-10">
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
                  marginRefusal={marginRefusalOf(report.statements)}
                />
                {/* The one EBITDA, explained by the engine's served
                 *  reconciliation: net turnover → … → account 121, the
                 *  one-line bridge, and the Core strip (758, 781) the
                 *  valuation multiple is applied to. */}
                <div className="mt-5">
                  <EbitdaReconciliationPanel
                    statements={report.statements}
                    currency={currency}
                    marginRefusal={marginRefusalOf(report.statements)}
                  />
                </div>
              </>
            ) : (
              // Empty-state — should not happen on a loaded report, but
              // a defensive fallback so the page never crashes if the
              // canonical assembly is unavailable.
              <div className="rounded-md border border-rule bg-bg-2/40 px-6 py-8 text-center text-[13px] text-ink-soft">
                No canonical metrics available for this period.
              </div>
            )}
            {/* The briefing is written by the engine WITH the workspace
                industry in its prompt — it is sector language by
                construction, so it is the first thing withheld. */}
            {sectorBlocked ? (
              <div className="mt-5">{withheldNote("The executive briefing")}</div>
            ) : briefingShown.hiddenNote ? (
              // Written under an earlier EBITDA definition: hidden, with the
              // engine's one-line note (design A9) — never stale numbers.
              <Panel inset className="mt-5 border-l-[3px] border-l-caution px-4 py-3" data-testid="report-briefing-hidden-definition">
                <p className="text-[12.5px] text-ink-soft leading-relaxed">{briefingShown.hiddenNote.en}</p>
              </Panel>
            ) : briefingShown.unavailable && briefingShown.unavailableNote ? (
              // The stored row holds no usable narration: the note, never
              // the failure text (ruling 2026-10-02).
              <Panel inset className="mt-5 border-l-[3px] border-l-caution px-4 py-3" data-testid="report-briefing-unavailable">
                <p className="text-[12.5px] text-ink-soft leading-relaxed">{briefingShown.unavailableNote.en}</p>
              </Panel>
            ) : briefingShown.body ? (
              <Panel inset className="mt-5 border-l-[3px] border-l-brand px-4 py-3">
                <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-1.5">
                  Executive briefing
                  {/* The last good briefing, kept after a later narration
                      failed (ruling 2026-10-02) — said, never silent. */}
                  {briefingShown.stale && (
                    <span data-testid="report-briefing-stale"> · previous version, kept after a later narration failed</span>
                  )}
                </div>
                <p className="text-[13px] text-ink-soft leading-relaxed whitespace-pre-line">
                  {briefingShown.body}
                </p>
              </Panel>
            ) : null}
          </section>

          {/* ── 2. P&L ──────────────────────────────────────────────── */}
          <section id="pnl" data-testid="report-section-2-pnl">
            <SectionHeader number={2} title="P&L" />
            <PnlTable pl={pl} currency={currency} origin={origin} />
          </section>

          {/* ── 3. BALANCE SHEET ────────────────────────────────────── */}
          <section id="bs" data-testid="report-section-3-bs">
            <SectionHeader number={3} title="Balance Sheet" />
            <BsTable bs={bs} pl={pl} currency={currency} origin={origin} />
          </section>

          {/* ── 4. CASH FLOW ────────────────────────────────────────── */}
          <section id="cf" data-testid="report-section-4-cf">
            <SectionHeader number={4} title="Cash Flow Statement" />
            <CashFlowTable cf={cf} plDepreciation={pl.depreciation} currency={currency} origin={origin} />
          </section>

          {/* ── 5. RATIOS ───────────────────────────────────────────── */}
          <section id="ratios" data-testid="report-section-5-ratios">
            <SectionHeader number={5} title="Financial Ratios" />
            <RatiosTables
              metrics={metricsByName}
              marginRefusal={marginRefusalOf(report.statements)}
              refusals={{
                netResult: netIncomeRefusalOf(report.statements)?.text.en ?? null,
                equity: equityRefusalOf(report.statements)?.text.en ?? null,
                ebitda: (() => {
                  const one = readServedOneEbitda(pl);
                  return one && one.ebitda === null ? one.refusal?.text.en ?? null : null;
                })(),
              }}
            />
            {/* INVENTORY DAYS — what the DIO row above is made of: the ONE
                served block's split (legs with their accounts, alte stocuri,
                the basis, the period-end figure, seasonality). */}
            {readInventoryDaysSplit(report.statements) ? (
              <Panel className="mt-4" data-testid="report-inventory-days">
                <PanelHeader title={t("inventoryDays.title")} />
                <div className="px-4 pb-4">
                  <InventoryDaysSplit statements={report.statements} variant="full" />
                </div>
              </Panel>
            ) : null}
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
              <div className="rounded-md border border-rule bg-bg-2/40 px-4 py-4 text-[13px] text-ink-soft">
                Credit score not available — re-run the pipeline to compute the composite score for this period.
              </div>
            )}
            {/* The credit score above is sector-independent (Altman Z″
                and the engine's own ladder) and stays. The risk
                inventory does not: its rules are gated on the industry
                profile and their thresholds come from it. */}
            {sectorBlocked
              ? withheldNote("The risk inventory")
              : <RiskInventory allAlerts={alerts} />}
          </section>

          {/* ── 8. RECOMMENDATIONS + 90-DAY PLAN ────────────────────── */}
          <section id="recs" data-testid="report-section-8-recs">
            <SectionHeader number={8} title="Recommendations" />
            {/* Every recommendation is written from the profile-gated
                findings and the industry-keyed thresholds, so the whole
                section — and the 90-day plan built out of it — is
                withheld together. Half a list is worse than none: it
                would read as the complete set. */}
            {sectorBlocked ? withheldNote("The recommendations and the 90-day plan") : (
              <>
                <RecommendationsList recs={recs} />
                <NinetyDayPlan recs={recs} />
              </>
            )}
          </section>
        </article>

        {/* ── Footer — only what is true for THIS report (lib/reportFooter):
            the engine's own balance verdict and the served difference, and
            the narrative credit only when a briefing is shown. The three
            hard-coded sentences that stood here ("…within 0.5%", "see
            Section 5", a model credited on every report) are gone. ── */}
        <footer
          data-testid="report-footer"
          data-balance-status={footer.machineStatus}
          className="mt-12 pb-12 text-center text-[10.5px] text-ink-mute"
        >
          <span data-testid="report-footer-generated">{footer.generated}</span><br />
          <span data-testid="report-footer-balance">{footer.balance}</span>{" "}
          <span data-testid="report-footer-difference">{footer.differenceLine}</span>
        </footer>
      </div>
    </>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

function SectionHeader({ number, title }: { number: number; title: string }) {
  return (
    <h2 className="text-[13px] font-medium uppercase tracking-[0.08em] text-ink-soft mb-3 pb-2 border-b border-rule">
      <span className="font-mono tabular-nums text-ink-mute mr-1.5">{number}.</span>
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

function KpiGrid({
  canonical, credit, netMarginCanonical, currency, marginRefusal = null,
}: {
  /** The ENGINE's refusal of every margin over turnover (engine.ratios.
   *  margin_meaning): each tile's margin line states it instead of a percent. */
  marginRefusal?: MarginBilingual | null;
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
  // CUR-FIX — exact converted figures still surface in the sub line.
  const { fmt, displayCurrency } = useReportFmt(currency);
  // Pull from the canonical object only. No fallback to legacy
  // independent derivations — those are the bug the canonical object
  // exists to eliminate.
  const { ebitda, netProfit, balance, headline } = canonical;
  // Net turnover (70x − 709) — every margin's denominator (owner ruling
  // 2026-09-26). The retired "total operating revenue" added 72x to it.
  const revenue = headline.revenue;

  // Total equity the engine REFUSED as the company's equity (it excludes a
  // refused year's result — critic round 2, 2026-09-27) forms no equity
  // ratio and no ROE: the tile prints the engine's reason, as §5 does.
  const equityRefusal = balance.equity_refusal;
  const equityRatio = balance.equity !== null && balance.total_assets > 0
    ? balance.equity / balance.total_assets : null;
  // Net-Debt / EBITDA — uses Core EBITDA (the basis for valuation),
  // matching the rest of the canonical object's convention.
  // A refused EBITDA forms no leverage multiple (null, never ÷ 0).
  const ndeRatio = ebitda.core !== null && ebitda.core > 0 ? balance.net_debt / ebitda.core : null;
  // A refused net result (no account 121, net 711 refused) forms no ROE.
  const roe = balance.equity !== null && balance.equity > 0 && netProfit.statutory_account_121 !== null
    ? netProfit.statutory_account_121 / balance.equity : null;
  const altman = credit?.altmanZ ?? null;

  const src = currency as Currency;
  // The KPI strip surfaces three EBITDA / net-profit figures explicitly:
  //   · Reported EBITDA (legal view, ties to acct 121)
  //   · Core EBITDA     (basis for valuation — 758/781 stripped)
  //   · Net profit      (statutory acct 121 — the legally filed number)
  // The 758/781 bridge is rendered as a separate panel directly below.
  // This is the consistency fix — no surface picks its own figure.
  // Money tiles share ONE magnitude via the surrounding AmountGroup; the
  // sub line carries the exact converted figure so nothing is lost to
  // compaction.
  // A margin printed beside a figure is the same concept as the ratio row
  // forty lines below it, so it goes through the SAME instrument. Until
  // 2026-09-06 the tiles built their own string with `toFixed(1)` while
  // §5 rendered <PercentLevel>, and the two rounding paths disagreed on
  // screen: agras' net margin printed 6.3% here and 6.4% there off one
  // identical ratio, and realestate printed "-493.7%" against "−493.7%".
  const marginSub = (ratio: number | null | undefined, tail: string, absent: string) =>
    marginRefusal ? (
      <span data-testid="report-kpi-margin-refused">{marginRefusal.en}</span>
    ) : ratio == null || !Number.isFinite(ratio) ? (
      absent
    ) : (
      <>
        <PercentLevel value={ratio * 100} /> {tail}
      </>
    );

  const tiles: Array<{
    label: string;
    value: React.ReactNode;
    sub?: React.ReactNode;
    headline?: boolean;
    conceptKey?: string;
    rawValue?: number;
  }> = [
    {
      label: "Net turnover",
      value: <MoneyAmount value={revenue} fromCurrency={src} />,
      sub: `${fmt(revenue)} ${displayCurrency}`,
      conceptKey: "operating_revenue",
      rawValue: revenue,
    },
    // THE ONE EBITDA (711 and 72x inside); a refused one prints the
    // engine's reason in place of a figure, and its margin refuses with it.
    {
      label: "EBITDA",
      value:
        ebitda.reported === null ? (
          <span className="text-[12.5px] text-ink-soft" data-testid="report-kpi-ebitda-refused">
            refused — {ebitda.refusal?.text.en ?? "the engine served no EBITDA for this period"}
          </span>
        ) : (
          <MoneyAmount value={ebitda.reported} fromCurrency={src} />
        ),
      sub: ebitda.reported === null ? undefined : marginSub(
        ebitda.reported_margin_pct != null ? ebitda.reported_margin_pct / 100 : null,
        "margin · over net turnover · 711 and 72x inside",
        "Over net turnover",
      ),
      conceptKey: "ebitda",
      rawValue: ebitda.reported ?? undefined,
    },
    {
      label: "EBITDA — core",
      value:
        ebitda.core === null ? (
          <span className="text-[12.5px] text-ink-soft">refused with EBITDA</span>
        ) : (
          <MoneyAmount value={ebitda.core} fromCurrency={src} />
        ),
      sub: ebitda.core === null ? undefined : marginSub(
        ebitda.core_margin_pct != null ? ebitda.core_margin_pct / 100 : null,
        "margin · excl. 758, 781",
        "Basis for valuation",
      ),
      headline: true,
      conceptKey: "ebitda",
      rawValue: ebitda.core ?? undefined,
    },
    {
      label: "Net profit — statutory (ct 121)",
      // Refused by the engine: its reason, never a figure (and never 0).
      value: netProfit.refusal
        ? <span data-testid="report-net-profit-refused">refused — {netProfit.refusal.text.en}</span>
        : <MoneyAmount value={netProfit.statutory_account_121} fromCurrency={src} />,
      // F1.e — Margin reads engine-canonical `net_margin` from
      // calculated_metrics so this tile agrees with the dashboard tile
      // and the Ratios row on the same page. The "legally filed"
      // sub-label refers to the source-currency value (per ¶ in F1.e
      // protocol — sub-label scope, not margin denominator).
      sub: marginSub(
        netProfit.statutory_account_121 === null
          ? null
          : typeof netMarginCanonical === "number"
            ? netMarginCanonical
            : revenue > 0
              ? netProfit.statutory_account_121 / revenue
              : null,
        "margin · legally filed",
        "Legally filed (acct 121)",
      ),
      conceptKey: "net_profit",
      rawValue: netProfit.statutory_account_121 ?? undefined,
    },
    {
      label: "Total assets",
      value: <MoneyAmount value={balance.total_assets} fromCurrency={src} />,
      sub: `${fmt(balance.total_assets)} ${displayCurrency}`,
      conceptKey: "total_assets",
      rawValue: balance.total_assets,
    },
    {
      label: "Equity ratio",
      value: equityRefusal ? (
        <span className="text-[12.5px] text-ink-soft" data-testid="report-kpi-equity-ratio-refused">
          refused — {equityRefusal.text.en}
        </span>
      ) : (
        <PercentLevel value={equityRatio != null ? equityRatio * 100 : null} />
      ),
      sub: "Equity / Assets",
      conceptKey: equityRatio == null ? undefined : "equity_ratio",
      rawValue: equityRatio ?? undefined,
    },
    { label: "Net Debt / EBITDA", value: <CappedMultiple value={ndeRatio} />, sub: "Leverage · on Core EBITDA", conceptKey: ndeRatio == null ? undefined : "net_debt_ebitda", rawValue: ndeRatio ?? undefined },
    { label: "ROE", value: <PercentLevel value={roe != null ? roe * 100 : null} />, sub: "Return on equity", conceptKey: roe == null ? undefined : "roe", rawValue: roe ?? undefined },
    { label: "Altman Z″", value: <Amount kind="count" value={altman} fractionDigits={2} />, sub: "Distress score", conceptKey: altman == null ? undefined : "altman_z_score", rawValue: altman ?? undefined },
  ];

  return (
    <MoneyAmountGroup
      values={[revenue, ebitda.reported, ebitda.core, netProfit.statutory_account_121, balance.total_assets]}
      fromCurrency={src}
    >
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {tiles.map((t) => (
          <Panel
            key={t.label}
            className={`p-4 ${t.headline ? "border-l-[3px] border-l-brand" : ""}`}
          >
            <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-1">{t.label}</div>
            <div className="text-[19px] text-ink leading-tight">
              {t.conceptKey != null && t.rawValue != null ? (
                <LearnableNumber conceptKey={t.conceptKey} value={t.rawValue}>
                  {t.value}
                </LearnableNumber>
              ) : (
                t.value
              )}
            </div>
            {t.sub && <div className="mt-1 text-[11px] text-ink-mute">{t.sub}</div>}
          </Panel>
        ))}
      </div>
    </MoneyAmountGroup>
  );
}

function PnlTable({ pl, currency, origin }: { pl: Record<string, number>; currency: string; origin: ReportOrigin }) {
  const { fmt, displayCurrency } = useReportFmt(currency);
  // The % column's denominator — net turnover, the base of every margin
  // (owner ruling 2026-09-26). Absent → no percentages, never a division
  // guarded by a fabricated zero.
  const revenue: number | undefined = pl.revenue;
  const f = (path: string) => origin.field(`assembled_pl.${path}`);
  const neg = (path: string) => origin.field(`assembled_pl.${path}`, "presented negative");

  // ── The build-up, as a column a reader can add up ─────────────────
  //
  // Every row below is either a STEP in one running total or a SUBTOTAL
  // stating it, and the table says which (`data-pl-role`). Each subtotal is
  // the engine's SERVED figure; each step is the served line the engine
  // formed it from — so the column foots on every book with no client
  // arithmetic reconciling anything.
  //
  // THE ONE EBITDA (owner ruling 2026-09-26). The stock variation (711,
  // "Variația stocurilor de produse") sits beside cost of sales, signed as
  // its effect on the result; own work capitalised (72x) is an operating
  // line outside net turnover; both are inside EBITDA. 767 is financial.
  // PROVISIONS SYMMETRIC (owner ruling R2, 2026-09-28): the ruled charges
  // (6812, 6814) and reversals (7812, 7814) are OUTSIDE EBITDA; their net is
  // its own step between D&A and EBIT, under the engine's name, signed as
  // its effect on the result — so EBITDA − D&A − net provisions = EBIT foots.
  // The retired rows went with the old definitions: the "+ Capitalized own
  // work (722)" step after net profit (72x is above EBITDA now), the
  // "EBITDA (statutory, incl. 722)" memo (there is one EBITDA) and the
  // "Total operating revenue" memo (no margin divides by it).
  //
  // THE TAIL ends on account 121, the filed figure. Where the result built
  // from the accounts IS account 121 — every bridge book, where the 711 line
  // is derived from 121, and every book whose lines explain it — the chain
  // closes; where they differ (a closed book with no 711 postings and a 121
  // remainder), the remainder is its own LABELLED step, never folded into
  // 711.
  const served = readServedOneEbitda(pl);
  const recon = served?.reconciliation ?? null;
  const iv = served?.inventoryVariation ?? null;
  const cap = served?.capitalizedOwnWork ?? null;
  const built = reconLine(recon, "net_result");
  const acc121 = reconLine(recon, "account_121");
  const gap = reconLine(recon, "not_explained");
  const filedNetProfit: number | undefined =
    typeof pl.net_income_statutory === "number" ? pl.net_income_statutory : undefined;
  // The net result REFUSED by the engine (no account 121, net 711
  // refused): the last row prints its reason, never a build-up.
  const netResultRefusal = readRefusal((pl as Record<string, unknown>).net_income_refusal);
  const unexplained = gap?.value ?? null;
  const hasUnexplained = unexplained !== null && Math.abs(unexplained) >= 0.005;
  const has711 = componentShown(iv);
  const has72x = componentShown(cap);
  const num = (v: number | null | undefined): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;

  // Row schema  →  { label, value, style, sub?, indent? }
  type RowStyle =
    | "normal"
    | "indent"
    | "subtotal"
    | "highlight"
    | "headline"        // the filed net-profit headline (primary emphasis)
    | "reconciliation"; // the step from the build to account 121
  /** `step` rows accumulate into the running total; `subtotal` rows state
   *  it. */
  type Row = {
    label: string;
    val: number | undefined;
    style: RowStyle;
    origin: AmountProvenance | null;
    role: "step" | "subtotal";
    /** The engine's reason, printed under a refused figure. */
    note?: string | null;
    /** A stable handle for the laws (`data-pl-row`). */
    key?: string;
  };

  const ivLabel = iv ? `${iv.nameRo ?? "Variația stocurilor de produse"} (711)${iv.glossEn ? ` — ${iv.glossEn}` : ""}` : "";
  const capLabel = cap ? `${cap.nameRo ?? "Own work capitalised"} (72x)${cap.glossEn ? ` — ${cap.glossEn}` : ""}` : "";
  const refusalEn = served?.refusal?.text.en ?? null;

  const rows: Row[] = [
    { label: "Net turnover", val: pl.revenue, style: "subtotal", origin: f("revenue"), role: "step" },
    { label: "Other operating income", val: pl.other_operating_income, style: "indent", origin: f("other_operating_income"), role: "step" },
  ];
  if (has72x) {
    rows.push({ label: capLabel, val: num(cap?.value), style: "indent", origin: f("capitalized_own_work.value"), role: "step" });
  }
  rows.push({ label: "Cost of goods sold", val: negated(pl.cogs), style: "indent", origin: neg("cogs"), role: "step" });
  if (has711) {
    rows.push({
      label: ivLabel,
      val: num(iv?.value),
      style: "indent",
      origin: f("inventory_variation.value"),
      role: "step",
      note: iv?.value === null ? iv?.refusal?.text.en ?? refusalEn : iv?.provenanceLabel?.en ?? null,
    });
  }
  rows.push(
    { label: "Operating expenses", val: negated(pl.opex_total), style: "indent", origin: neg("opex_total"), role: "step" },
    { label: "EBITDA", val: num(served?.ebitda), style: "highlight", origin: f("ebitda"), role: "subtotal", note: served?.ebitda == null ? refusalEn : null },
    { label: "Depreciation & amortization", val: negated(pl.depreciation), style: "indent", origin: neg("depreciation"), role: "step" },
  );
  const np = served?.netProvisions ?? null;
  if (np && (Math.abs(np.charges) >= 0.005 || Math.abs(np.reversals) >= 0.005)) {
    // Printed as its EFFECT on the result, like every step of this column
    // (D&A above it is negated too) — so the label states the effect's
    // arithmetic, "7812 + 7814 − 6812 − 6814", never the engine's charge
    // arithmetic over the opposite figure (review 2026-10-02: agras read
    // "… (6812 + 6814 − 7812 − 7814) −131,395"). The printed report and the
    // workbook compose the same label (`netProvisionsEffectLabel`).
    rows.push({
      label: netProvisionsEffectLabel(np, "en"),
      val: 0 - np.value,
      style: "indent",
      origin: neg("net_provisions.value"),
      role: "step",
      key: "net_provisions",
    });
  }
  rows.push(
    { label: "EBIT", val: num(served?.ebit), style: "highlight", origin: f("ebit"), role: "subtotal", note: served?.ebit == null ? refusalEn : null },
    { label: "Net financial result", val: pl.net_financial_result, style: "indent", origin: f("net_financial_result"), role: "step" },
    { label: "Pre-tax profit", val: num(served?.pretax), style: "subtotal", origin: f("pretax"), role: "subtotal", note: served?.pretax == null ? refusalEn : null },
    { label: "Income tax", val: negated(pl.tax), style: "indent", origin: neg("tax"), role: "step" },
    {
      label: "Net profit — built from the accounts",
      val: num(built?.value),
      style: "subtotal",
      origin: f("ebitda_reconciliation.lines.net_result"),
      role: "subtotal",
      note: built && built.value === null ? built.refusal?.text.en ?? refusalEn : null,
    },
  );
  if (hasUnexplained) {
    rows.push({
      label: "± Not explained by the revenue and expense accounts",
      val: unexplained ?? undefined,
      style: "reconciliation",
      origin: f("net_income_unexplained_vs_121"),
      role: "step",
    });
  }
  rows.push({
    label: acc121?.status === "not_anchored"
      ? "= Net profit — built from the accounts (no account 121 in the trial balance)"
      : "= Net profit — account 121 (closing balance)",
    val: filedNetProfit,
    style: "headline",
    origin: f("net_income_statutory"),
    role: "subtotal",
    note: netResultRefusal ? netResultRefusal.text.en : null,
  });

  // Instrument row styling — semantic emphasis through tokens only.
  const rowCls: Record<RowStyle, string> = {
    normal: "",
    indent: "",
    subtotal: "bg-bg-2/60 font-semibold text-ink",
    highlight: "bg-brand-tint/30 font-semibold text-ink",
    headline: "bg-brand-tint/50 font-semibold text-ink",
    reconciliation: "text-ink-mute",
  };
  const labelCls: Record<RowStyle, string> = {
    normal: "",
    indent: "pl-8 text-ink-soft",
    subtotal: "",
    highlight: "",
    headline: "",
    reconciliation: "pl-8 italic",
  };

  return (
    <>
      <Panel className="overflow-x-auto">
        <table className="w-full text-[12.5px] min-w-[480px]">
          <thead className="bg-surface text-[10.5px] uppercase tracking-[0.08em] text-ink-mute">
            <tr className="border-b border-rule">
              <th className="text-left px-4 h-8 font-medium">Line</th>
              <th className="text-right px-3 h-8 font-medium">{displayCurrency}</th>
              <th className="text-right px-3 h-8 font-medium">% of turnover</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const v = r.val;
              return (
                <tr
                  key={r.label}
                  data-pl-role={r.role}
                  data-pl-row={r.key}
                  data-pl-exact={v == null ? undefined : String(v)}
                  className={`h-8 ${r.style === "headline" ? "border-t border-t-rule-strong" : r.style === "reconciliation" ? "border-t border-dashed border-rule-strong" : "border-t border-rule-soft"} first:border-t-0 ${rowCls[r.style]}`}
                >
                  <td className={`px-4 py-1 ${labelCls[r.style]}`}>
                    {r.label}
                    {r.note && (
                      <span className="block text-[11px] font-normal not-italic text-ink-mute" data-pl-note="">
                        {r.note}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1 text-right">
                    <MoneyAmount value={v} fromCurrency={currency as Currency} unit={false} provenance={r.origin} />
                  </td>
                  <td className="px-3 py-1 text-right text-ink-soft">
                    <PercentLevel value={v != null && revenue != null && revenue > 0 ? (v / revenue) * 100 : null} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      {/* Commentary — what the foot of the column IS. */}
      {(has711 || has72x || hasUnexplained) && (
        <Panel inset className="mt-4 border-l-[3px] border-l-brand px-4 py-3 text-[12.5px] text-ink-soft leading-relaxed" role="note">
          <span className="font-semibold text-brand-d dark:text-brand-l">
            From net turnover to account 121 —
          </span>{" "}
          The column above builds the P&amp;L from the trial balance&rsquo;s class 6 and class 7
          movements, with the stock variation (711) and own work capitalised (72x) inside EBITDA —
          one definition on every page. It ends on account 121&rsquo;s closing balance
          ({fmt(filedNetProfit)} {displayCurrency}) — the figure every KPI tile and ratio on
          this page states.
          {recon?.identityNote && <> {recon.identityNote.en}</>}
          {recon?.splitAssumption && <> {recon.splitAssumption.en}</>}
          {hasUnexplained && (
            <>
              {" "}
              The remaining {fmt(unexplained)} {displayCurrency} is <strong>not explained</strong> by
              any line on this statement: the class-6/7 movements this trial balance carries do not
              sum to what account 121 closed at. It is shown with its amount rather than folded into
              the stock variation or a plug, because a build-up that foots on an invented component
              is worse than one that names its gap.
            </>
          )}
        </Panel>
      )}
    </>
  );
}

type BsRow = [
  label: string,
  value: number | undefined,
  origin: AmountProvenance | null,
  /** The engine's reason, printed in place of the amount (never a 0). */
  refusal?: string | null,
];

function BsTable({ bs, pl, currency, origin }: {
  bs: Record<string, number>;
  pl: Record<string, number>;
  currency: string;
  origin: ReportOrigin;
}) {
  // A REFUSED net result (no account 121, net 711 refused — fixer round 2,
  // 2026-09-27) has no current-year row: this printed the class-6/7
  // build-up (-30,391,418 on the developer, -36.4 % of assets) beside a P&L
  // whose foot said the net result is refused. The engine's reason, from
  // the balance sheet's own refusal or — on a period stored before it —
  // the P&L's.
  const cyRefusal =
    readRefusal((bs as Record<string, unknown>).current_year_pnl_refusal)
    ?? readRefusal((pl as Record<string, unknown>).net_income_refusal);
  // The "% of assets" denominator. Absent → no percentages.
  const total: number | undefined = bs.total_assets;
  const f = (path: string) => origin.field(`assembled_bs.${path}`);
  const assetRows: BsRow[] = [
    ["Cash", bs.cash, f("cash")],
    ["Accounts receivable (net)", bs.ar_net, f("ar_net")],
    ["Inventory", bs.inventory, f("inventory")],
    ["Other current assets", bs.ar_other, f("ar_other")],
    ["PP&E (net)", bs.ppe_net, f("ppe_net")],
    ["Intangibles (net)", bs.intangibles_net, f("intangibles_net")],
    ["Investments", bs.investments, f("investments")],
  ];
  const liabRows: BsRow[] = [
    ["Share capital", bs.share_capital, f("share_capital")],
    [
      "Reserves & retained earnings",
      sumOf(bs.revaluation_reserves, bs.retained_earnings, bs.other_equity_non_revaluation),
      origin.derived("assembled_bs.revaluation_reserves + retained_earnings + other_equity_non_revaluation"),
    ],
    cyRefusal
      ? ["Current-year P&L", undefined, null, `refused — ${cyRefusal.text.en}`]
      : ["Current-year P&L", bs.current_year_pnl, f("current_year_pnl")],
    ["Long-term debt", bs.lt_debt, f("lt_debt")],
    ["Short-term debt", bs.st_debt, f("st_debt")],
    ["Accounts payable", bs.ap, f("ap")],
    ["Other current liabilities", bs.ap_other, f("ap_other")],
    ["Dividends payable", bs.ap_dividends, f("ap_dividends")],
  ];
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <BsHalf title="Assets" rows={assetRows} totalLabel="Total assets" totalValue={bs.total_assets} totalOrigin={f("total_assets")} reference={total} currency={currency} />
      <BsHalf title="Equity & Liabilities" rows={liabRows} totalLabel="Total equity + liabilities" totalValue={sumOf(bs.total_equity, bs.total_liabilities)} totalOrigin={origin.derived("assembled_bs.total_equity + total_liabilities")} reference={total} currency={currency} />
    </div>
  );
}

function BsHalf({ title, rows, totalLabel, totalValue, totalOrigin, reference, currency }: {
  title: string;
  rows: BsRow[];
  totalLabel: string;
  totalValue: number | undefined;
  totalOrigin: AmountProvenance | null;
  reference: number | undefined;
  currency: string;
}) {
  const { displayCurrency } = useReportFmt(currency);
  return (
    <Panel className="overflow-x-auto">
      <PanelHeader title={title} />
      <table className="w-full text-[12.5px]">
        <thead className="bg-surface text-[10.5px] uppercase tracking-[0.08em] text-ink-mute">
          <tr className="border-b border-rule">
            <th className="text-left px-4 h-8 font-medium">Line</th>
            <th className="text-right px-3 h-8 font-medium">{displayCurrency}</th>
            <th className="text-right px-3 h-8 font-medium">% of assets</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, val, rowOrigin, refusal]) => (
            <tr key={label} className="border-t border-rule-soft first:border-t-0 h-8">
              <td className="px-4 py-1">{label}</td>
              <td className="px-3 py-1 text-right">
                {refusal ? (
                  <span className="text-ink-soft" data-testid="report-bs-row-refused">{refusal}</span>
                ) : (
                  <MoneyAmount value={val} fromCurrency={currency as Currency} unit={false} provenance={rowOrigin} />
                )}
              </td>
              <td className="px-3 py-1 text-right text-ink-soft">
                {val != null && reference != null && reference > 0 ? <PercentLevel value={(val / reference) * 100} /> : null}
              </td>
            </tr>
          ))}
          <tr className="border-t border-t-rule-strong h-8 bg-bg-2/60 font-semibold text-ink">
            <td className="px-4 py-1">{totalLabel}</td>
            <td className="px-3 py-1 text-right">
              <MoneyAmount value={totalValue} fromCurrency={currency as Currency} unit={false} provenance={totalOrigin} />
            </td>
            <td className="px-3 py-1"></td>
          </tr>
        </tbody>
      </table>
    </Panel>
  );
}

function CashFlowTable({ cf, plDepreciation, currency, origin }: {
  cf: Record<string, number | boolean | string[] | undefined>;
  /** The P&L's D&A (`assembled_pl.depreciation`) — only to name the
   *  add-back row for what it sums (owner ruling R2, 2026-09-28). */
  plDepreciation: unknown;
  currency: string;
  origin: ReportOrigin;
}) {
  const { displayCurrency } = useReportFmt(currency);
  const isApprox = Boolean(cf.is_approximated);
  const notes = Array.isArray(cf.approximation_notes) ? cf.approximation_notes : [];
  // A field the envelope does not carry is ABSENT (the HU pack serves
  // `assembled_cf: {}`): the row paints "—" and no card, never a zero
  // wearing `assembled_cf.<k>` as its source.
  const n = (k: string): number | undefined =>
    typeof cf[k] === "number" && Number.isFinite(cf[k] as number) ? (cf[k] as number) : undefined;
  // The served envelope says whether this statement is approximated
  // (`is_approximated`); the figure says the same thing in its method
  // so the ~ in the label and the card can never disagree.
  const f = (k: string) =>
    origin.field(`assembled_cf.${k}`, isApprox ? "indirect method · approximated" : undefined);
  // The NET RESULT refused (no account 121, net 711 refused): every row the
  // engine could not walk from it is absent, and says why — never a bare
  // dash under "Net profit", "Cash from operating activities" or "Net
  // change in cash" (critic round 3, 2026-09-28).
  const cfRefusal = readRefusal((cf as Record<string, unknown>).net_income_refusal);
  const cell = (key: string, value: number | undefined, prov: AmountProvenance | null) =>
    value === undefined && cfRefusal ? (
      <span data-testid={`report-cf-${key}-refused`} className="text-ink-soft font-normal">
        refused — {cfRefusal.text.en}
      </span>
    ) : (
      <MoneyAmount value={value} fromCurrency={currency as Currency} unit={false} provenance={prov} />
    );

  type CfRow = [label: string, value: number | undefined, origin: AmountProvenance | null, key?: string];
  const sections: Array<{ title: string; rows: CfRow[]; subtotal: CfRow; }> = [
    {
      title: "Operating",
      rows: [
        ["Net profit", n("net_profit"), f("net_profit"), "net_profit"],
        // The walk adds back all of 68x; since R2 the P&L's D&A leaves out
        // the 6812 / 6814 charges — the row is named for what it sums.
        [addBackHoldsProvisionCharges(n("depreciation"), plDepreciation)
          ? CF_ADD_BACK_LABEL_EN.withProvisionCharges
          : CF_ADD_BACK_LABEL_EN.depreciation, n("depreciation"), f("depreciation")],
        ["+ Provision movements", n("provision_movement"), f("provision_movement")],
        ["Δ Inventory", n("delta_inventory"), f("delta_inventory")],
        ["Δ Receivables", n("delta_receivables"), f("delta_receivables")],
        ["Δ Trade payables", n("delta_trade_pay"), f("delta_trade_pay")],
        ["Δ Tax payables", n("delta_tax_pay"), f("delta_tax_pay")],
      ],
      subtotal: ["Cash from operating activities", n("cash_from_operating"), f("cash_from_operating"), "cash_from_operating"],
    },
    {
      title: "Investing",
      rows: [
        ["Capex (CIP, 231 additions)", n("capex_real"), f("capex_real")],
        ["Other capex (approximated)", n("capex_other_approx"), f("capex_other_approx")],
        ["Δ Construction in progress", n("cip_change"), f("cip_change")],
        ["Δ Affiliates", n("affiliate_change"), f("affiliate_change")],
        ["+ Dividends received", n("dividends_received"), f("dividends_received")],
        ["+ Interest received", n("interest_received"), f("interest_received")],
      ],
      subtotal: ["Cash used in investing", n("cash_used_in_investing"), f("cash_used_in_investing")],
    },
    {
      title: "Financing",
      rows: [
        ["Δ Long-term debt", n("delta_lt_debt"), f("delta_lt_debt")],
        ["Δ Short-term bank credit", n("delta_st_bank"), f("delta_st_bank")],
        ["− Interest paid", n("interest_paid"), f("interest_paid")],
        ["− Dividends paid", n("dividends_paid"), f("dividends_paid"), "dividends_paid"],
      ],
      subtotal: ["Cash used in financing", n("cash_used_in_financing"), f("cash_used_in_financing"), "cash_used_in_financing"],
    },
  ];

  return (
    <div className="space-y-4">
      {isApprox && (
        <Panel inset className="border-l-[3px] border-l-caution px-4 py-3 text-[12.5px] text-ink-soft">
          <strong className="font-semibold text-caution">Cash flow is approximated.</strong>
          <p className="mt-1">
            Single-period upload — working-capital movements and financing detail
            estimated from typical Romanian patterns. Upload the prior year for
            exact reconciliation.
          </p>
          {notes.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-[11.5px] text-ink-mute list-disc pl-4">
              {notes.map((nt, i) => <li key={i}>{nt}</li>)}
            </ul>
          )}
        </Panel>
      )}
      {sections.map((s) => (
        <Panel key={s.title} className="overflow-x-auto">
          <PanelHeader
            title={s.title}
            actions={<span className="text-[11px] text-ink-mute">figures in <span className="font-mono">{displayCurrency}</span></span>}
          />
          <table className="w-full text-[12.5px]">
            <tbody>
              {s.rows.map(([label, val, rowOrigin, key]) => (
                <tr key={label} className="border-t border-rule-soft first:border-t-0 h-8">
                  <td className="px-4 py-1 pl-8 text-ink-soft">{isApprox ? `~ ${label}` : label}</td>
                  <td className="px-3 py-1 text-right">
                    {key ? cell(key, val, rowOrigin) : (
                      <MoneyAmount value={val} fromCurrency={currency as Currency} unit={false} provenance={rowOrigin} />
                    )}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-t-rule-strong h-8 bg-bg-2/60 font-semibold text-ink">
                <td className="px-4 py-1">{s.subtotal[0]}</td>
                <td className="px-3 py-1 text-right">
                  {s.subtotal[3] ? cell(s.subtotal[3], s.subtotal[1], s.subtotal[2]) : (
                    <MoneyAmount value={s.subtotal[1]} fromCurrency={currency as Currency} unit={false} provenance={s.subtotal[2]} />
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </Panel>
      ))}
      <Panel className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <tbody>
            <tr className="h-8 bg-bg-2/60 font-semibold text-ink">
              <td className="px-4 py-1">Net change in cash</td>
              <td className="px-3 py-1 text-right">
                {cell("net_change_in_cash", n("net_change_in_cash"), f("net_change_in_cash"))}
              </td>
            </tr>
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

function RatiosTables({
  metrics,
  marginRefusal = null,
  refusals = {},
}: {
  metrics: Record<string, number | null>;
  /** The ENGINE's refusal of every margin over turnover (engine.ratios.
   *  margin_meaning): the three margin rows state it instead of a percent. */
  marginRefusal?: MarginBilingual | null;
  /** The engine's refusals a ratio row with no figure is refused BY (its
   *  own sentence, English: this is the English board document) — the net
   *  result (ROE, ROA, net margin), total equity short by it (the equity
   *  ratio, debt / equity) and EBITDA (the multiples and coverage on it).
   *  A refused row prints the reason, never a bare dash (design A7;
   *  critic round 3, 2026-09-28: "ROE | —", "Equity ratio | —"). */
  refusals?: { netResult?: string | null; equity?: string | null; ebitda?: string | null };
}) {
  const m = (k: string) => metrics[k];
  const refusedCell = (key: string, reason: string | null | undefined, node: React.ReactNode) =>
    m(key) == null && reason ? (
      <span data-testid={`report-ratio-${key}-refused`} className="text-ink-soft">refused — {reason}</span>
    ) : node;
  // Every ratio figure flows through the instrument, by unit.
  const pct = (v: number | null | undefined) => (
    <PercentLevel value={v != null ? v * 100 : null} />
  );
  const margin = (k: string) =>
    marginRefusal ? (
      <span data-testid="report-ratio-margin-refused" className="text-ink-soft">{marginRefusal.en}</span>
    ) : (
      refusedCell(k, k === "net_margin" ? refusals.netResult : refusals.ebitda, pct(m(k)))
    );
  const mult = (v: number | null | undefined) => <CappedMultiple value={v} />;
  const days = (v: number | null | undefined) =>
    v == null ? (
      <Amount kind="count" value={null} />
    ) : (
      <span className="font-mono tabular-nums"><Amount kind="count" value={Math.round(v)} /> d</span>
    );

  const groups: Array<{ title: string; rows: Array<[string, React.ReactNode]> }> = [
    {
      title: "Profitability",
      rows: [
        ["Gross margin",   margin("gross_margin")],
        ["EBITDA margin",  margin("ebitda_margin")],
        ["Net margin",     margin("net_margin")],
        ["ROE",            refusedCell("roe", refusals.netResult ?? refusals.equity, pct(m("roe")))],
        ["ROA",            refusedCell("roa", refusals.netResult, pct(m("roa")))],
        ["ROIC",           refusedCell("roic", refusals.ebitda ?? refusals.equity, pct(m("roic")))],
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
        ["Equity ratio",      refusedCell("equity_ratio", refusals.equity, pct(m("equity_ratio")))],
        ["Debt / Equity",     refusedCell("debt_to_equity", refusals.equity, mult(m("debt_to_equity")))],
        ["Net Debt / EBITDA", refusedCell("debt_to_ebitda", refusals.ebitda, mult(m("debt_to_ebitda")))],
      ],
    },
    {
      title: "Coverage",
      rows: [
        // The name comes from the ONE label authority (ratioTable.ts), so
        // the basis — EBIT / interest — prints here as it does on the tab,
        // the exports and the workbook. A bare "Interest coverage" beside
        // a figure whose definition was revised states no basis at all.
        [ratioLabelForKey("interest_coverage") ?? "Interest coverage (EBIT / interest)",
          refusedCell("interest_coverage", refusals.ebitda, mult(m("interest_coverage")))],
      ],
    },
    {
      title: "Efficiency",
      rows: [
        // The ONE name (ratioTable's label authority): the served metric is
        // the inventory-days block's total (engine.ratios.inventory_days).
        [ratioLabelForKey("dio") ?? "Inventory days (DIO)", days(m("dio"))],
        ["DSO (days receivables)", days(m("dso"))],
        ["DPO (days payables)",   days(m("dpo"))],
      ],
    },
  ];
  return (
    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
      {groups.map((g) => (
        <Panel key={g.title}>
          <PanelHeader title={g.title} />
          <table className="w-full text-[12.5px]">
            <tbody>
              {g.rows.map(([label, val]) => (
                <tr key={label} className="border-t border-rule-soft first:border-t-0 h-8">
                  <td className="px-4 py-1 text-ink-soft">{label}</td>
                  <td className="px-3 py-1 text-right text-ink">{val}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
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
  const { displayCurrency } = useReportFmt(currency);
  // Client arithmetic over served fields, and NO provenance on any of it
  // (the census records these as plain). Absent inputs stay absent: an
  // EBITDA the envelope does not carry forms no multiple, a net debt
  // with a missing addend forms no equity value, and book equity paints
  // its gap state rather than a zero floor.
  // THE ONE EBITDA as served (711 and 72x inside), or its refusal — never
  // an engine metric row standing in for a refused figure.
  const servedOne = readServedOneEbitda(pl);
  const ebitda: number | null | undefined = servedOne ? servedOne.ebitda : metrics.ebitda;
  const ebitdaRefusal = servedOne && servedOne.ebitda === null ? servedOne.refusal : null;
  const hasEbitda = typeof ebitda === "number" && Number.isFinite(ebitda) && ebitda > 0;
  const netDebt = sumOf(bs.total_debt, negated(bs.cash));
  // BOOK EQUITY THE ENGINE REFUSED (it excludes a refused year's result —
  // no account 121, net 711 refused, the sheet short by the missing result;
  // critic round 2, 2026-09-27) is no NAV floor: the row prints the reason,
  // as the Valuation tab and the NAV cascade do — never the rows' short sum
  // and never a stale metric row.
  const bookEquityRefusal = equityRefusalOf(bs);
  const bookEquity: number | null | undefined = bookEquityRefusal
    ? null : bs.total_equity ?? metrics.total_equity;

  const multiples = [6, 8, 10].map((mult) => ({
    label: mult === 6 ? "Conservative (6×)" : mult === 8 ? "Mid (8×)" : "Premium (10×)",
    mult,
    ev: hasEbitda ? (ebitda as number) * mult : undefined,
    equity: hasEbitda && netDebt != null ? (ebitda as number) * mult - netDebt : undefined,
  }));

  return (
    <div className="space-y-3">
      {ebitdaRefusal ? (
        <Panel inset className="border-l-[3px] border-l-caution px-4 py-3 text-[12.5px] text-ink-soft" data-testid="report-valuation-ebitda-refused">
          EBITDA refused — {ebitdaRefusal.text.en}. No EV/EBITDA multiple can be
          formed; {bookEquityRefusal
            ? <>book equity is refused too — {bookEquityRefusal.text.en} — so no method forms a value.</>
            : "book equity (NAV floor) stands alone."}
        </Panel>
      ) : ebitda == null ? (
        <Panel inset className="border-l-[3px] border-l-caution px-4 py-3 text-[12.5px] text-ink-soft">
          EBITDA is not carried by this envelope — no EV/EBITDA multiple can be
          formed. For asset-heavy or distressed cases, prefer NAV (book equity)
          as the floor and revenue-multiple as a cross-check.
        </Panel>
      ) : !hasEbitda ? (
        <Panel inset className="border-l-[3px] border-l-caution px-4 py-3 text-[12.5px] text-ink-soft">
          EBITDA is non-positive — EV/EBITDA multiples produce meaningless values.
          For asset-heavy or distressed cases, prefer NAV (book equity) as the
          floor and revenue-multiple as a cross-check.
        </Panel>
      ) : null}
      <Panel className="overflow-x-auto">
        <PanelHeader title="Valuation envelope" />
        <table className="w-full text-[12.5px] min-w-[480px]">
          <thead className="bg-surface text-[10.5px] uppercase tracking-[0.08em] text-ink-mute">
            <tr className="border-b border-rule">
              <th className="text-left px-4 h-8 font-medium">Method</th>
              <th className="text-right px-3 h-8 font-medium">Enterprise value ({displayCurrency})</th>
              <th className="text-right px-3 h-8 font-medium">Equity value ({displayCurrency})</th>
            </tr>
          </thead>
          <tbody>
            {multiples.map((m) => (
              <tr key={m.label} className="border-t border-rule-soft first:border-t-0 h-8">
                <td className="px-4 py-1 text-ink">EV/EBITDA · {m.label}</td>
                <td className="px-3 py-1 text-right">
                  {m.ev != null ? <MoneyAmount value={m.ev} fromCurrency={currency as Currency} unit={false} /> : <span className="text-ink-mute">n/a</span>}
                </td>
                <td className="px-3 py-1 text-right">
                  {m.equity != null ? <MoneyAmount value={m.equity} fromCurrency={currency as Currency} unit={false} /> : <span className="text-ink-mute">n/a</span>}
                </td>
              </tr>
            ))}
            <tr className="border-t border-t-rule-strong h-8 bg-bg-2/60 font-semibold text-ink">
              <td className="px-4 py-1">Book equity (NAV floor)</td>
              <td className="px-3 py-1"></td>
              <td className="px-3 py-1 text-right">
                {bookEquityRefusal ? (
                  <span className="text-[12px] font-normal text-ink-soft" data-testid="report-valuation-book-equity-refused">
                    refused — {bookEquityRefusal.text.en}
                  </span>
                ) : (
                  <MoneyAmount value={bookEquity} fromCurrency={currency as Currency} unit={false} />
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </Panel>
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
      <div className="rounded-md border border-rule bg-bg-2/40 px-4 py-4 text-[13px] text-ink-soft">
        No deterministic recommendations fired. Pair with qualitative review or
        re-run the pipeline after uploading prior-period data.
      </div>
    );
  }
  return (
    <ol className="space-y-3">
      {recs.map((r, i) => {
        const sev = r.severity?.toLowerCase() ?? "medium";
        // Severity ladder — red only for critical (danger); amber
        // caution for high/medium; slate info for the rest.
        const sevRule =
          sev === "critical" ? "border-l-alert"
          : sev === "high"   ? "border-l-caution"
          : sev === "medium" ? "border-l-caution"
          : "border-l-info";
        const sevTone: ChipTone =
          sev === "critical" ? "alert"
          : sev === "high" || sev === "medium" ? "caution"
          : "info";
        return (
          <li key={i}>
            <Panel className={`border-l-[3px] ${sevRule} px-4 py-3`}>
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <Chip tone={sevTone} className="uppercase tracking-[0.06em]">{sev}</Chip>
                <span className="text-[14px] font-medium text-ink">{i + 1}. {r.title ?? "Recommendation"}</span>
              </div>
              {r.why && <p className="text-[12.5px] text-ink-soft mt-1"><strong className="text-ink">Why:</strong> {r.why}</p>}
              {r.action && <p className="text-[12.5px] text-ink-soft mt-1"><strong className="text-ink">Action:</strong> {r.action}</p>}
              {r.impact && <p className="text-[12.5px] text-ink-soft mt-1"><strong className="text-ink">Impact:</strong> {r.impact}</p>}
            </Panel>
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
      <h3 className="text-[13px] font-medium uppercase tracking-[0.08em] text-ink-soft mb-3">90-day action plan</h3>
      <div className="grid md:grid-cols-3 gap-3">
        {Object.entries(buckets).map(([window, items]) => (
          <Panel key={window}>
            <PanelHeader title={window} />
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
          </Panel>
        ))}
      </div>
    </div>
  );
}
