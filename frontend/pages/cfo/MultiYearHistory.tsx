// Multi-Year History — renders the parsed listafirme.ro / termene.ro
// public-records summary. NOT a trial-balance reconstruction; this is
// the 6-aggregate × N-year table read straight from the PDF (zero
// LLM in the calculation path) so every number is auditable.
//
// Routes:
//   /multi-year-history             → latest extract for this org
//   /multi-year-history?doc=<id>   → specific document's extract
//
// Data source: /api/public-records/latest or /api/public-records/by-document/{id}.
// Persistence: piggybacks on `sku_analyses.briefing` JSONB (no new
// migration; the row's `briefing.kind` is `public_records_summary`).

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Loader2, TrendingUp, TrendingDown, Building2, Hash, MapPin, Globe } from "lucide-react";
// Instrument pass (2026-08): PageHeader replaces the gradient hero,
// panels/chips from the kit, every figure mono via the Amount family.
import { PageHeader, Panel, PanelHeader } from "@/components/instrument/Panel";
import { Amount } from "@/components/instrument/Amount";
import { provenanceOf, type AmountProvenance } from "@/components/instrument/Provenance";
import {
  MoneyAmount,
  MoneyAmountGroup,
  PercentLevel,
  useDisplayMoney,
} from "@/components/comparison/MoneyAmount";
import { getSupabase } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";
import { DataDepthBanner } from "@/components/cfo/DataDepthBanner";
import { DocumentSwitcher } from "@/components/cfo/DocumentSwitcher";
import { DEPTH_PUBLIC_SUMMARY } from "@/lib/dataDepth";
import { LearnableNumber } from "@/components/learning/LearnableNumber";
import { GuideMeButton } from "@/components/learning/GuideMeButton";
import { MULTIYEAR_GUIDE } from "@/components/learning/pageGuides";

const apiBase = (): string =>
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

interface YearRow {
  year: number;
  cifra_afaceri: number;
  profit_net: number;
  datorii_totale: number;
  active_imobilizate: number;
  active_circulante: number;
  capitaluri_proprii: number;
  total_assets: number;
  salariati: number | null;
  net_margin_pct: number | null;
}

interface Extract {
  id: string;
  document: { id: string; filename: string; status: string; detected_type: string | null; created_at: string };
  company_name: string | null;
  cui: string | null;
  reg_com: string | null;
  caen_code: string | null;
  caen_description: string | null;
  source_site: string | null;
  confidence: number | null;
  years: YearRow[];
  created_at: string;
}

export default function MultiYearHistory() {
  const [params] = useSearchParams();
  const docId = params.get("doc");
  const { toast } = useToast();
  const [extract, setExtract] = useState<Extract | null>(null);
  const [loading, setLoading] = useState(true);
  // CUR-FIX — every fmtRON(...) call below this point should use `fmtCur(...)`
  // instead. RON-source ANAF data converts to the user's TopHeader currency.
  const fmtCur = useFmtCur();
  // Display-currency code for table captions (the cells drop per-cell
  // units to keep the ledger quiet; the caption carries the unit once).
  const { display } = useDisplayMoney();

  // Where a year's figures come from: the uploaded public-records
  // document (its filename) and the site it was pulled from, and the year
  // as the period. The payload carries no page or table anchor and no
  // extraction method, so none is claimed — and `extract.confidence` is
  // NOT passed: the card renders a confidence only beside a Method (it
  // is that method's verification score), and this extract names none.
  // It used to be passed and never rendered (critic finding #5,
  // ea6df1f) — a field in the payload nobody could see. The parser's own
  // definition is "the fraction of expected fields parsed successfully",
  // which the footer below states in those words, where it belongs.
  const yearOrigin = (year: number): AmountProvenance | null =>
    extract
      ? provenanceOf({
          source: [extract.document?.filename, extract.source_site]
            .filter((x): x is string => typeof x === "string" && x.length > 0)
            .join(" · "),
          period: String(year),
        })
      : null;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const sb = getSupabase();
      const { data } = sb ? await sb.auth.getSession() : { data: { session: null } };
      const token = data?.session?.access_token;
      const url = docId
        ? `${apiBase()}/api/public-records/by-document/${docId}`
        : `${apiBase()}/api/public-records/latest`;
      try {
        const r = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = await r.json();
        if (!cancelled) setExtract(body.extract ?? null);
      } catch (e: unknown) {
        if (!cancelled) toast({
          title: "Couldn't load history",
          description: e instanceof Error ? e.message : "Network error",
          variant: "destructive",
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [docId, toast]);

  if (loading) return (
    <>
      <div className="flex items-center justify-center py-32 text-ink-mute">
        <Loader2 size={20} className="animate-spin mr-2" />Loading multi-year history…
      </div>
    </>
  );

  if (!extract) return (
    <>
      <div className="max-w-[640px] mx-auto py-24 text-center">
        <Building2 size={28} className="mx-auto text-ink-mute mb-3" />
        <h1 className="text-[22px] font-semibold tracking-[-0.005em] text-ink">No public-records data yet</h1>
        <p className="mt-2 text-[14px] text-ink-soft">
          Upload a listafirme.ro / termene.ro company-summary PDF and the parser
          extracts the 6-aggregate × N-year history into this view.
        </p>
      </div>
    </>
  );

  const years = extract.years.slice().sort((a, b) => b.year - a.year);
  const latest = years[0];

  return (
    <>
      <div className="max-w-[1200px]" data-testid="multi-year-history">
        {/* DocumentSwitcher — lets the user jump between any analyzed
            doc (trial-balance period OR public-records upload) WITHOUT
            leaving this page. Picking a TB period navigates back to
            /dashboard (since multi-year-history only renders public-
            records data); picking another public-records upload reloads
            this same view with ?doc=<id>. */}
        <DocumentSwitcher className="max-w-[480px] mb-4" />

        {/* Data-depth banner — sets the user's expectations honestly:
            Level 1 (Public Financial Summary) means we have 6 aggregates
            × N years; we DON'T have EBITDA, cost structure, or DIO/DSO.
            Banner is collapsible so it doesn't crowd the page on repeat
            visits, but always discoverable. */}
        <DataDepthBanner depth={DEPTH_PUBLIC_SUMMARY} subject={extract.company_name} />

        {/* A3 hero eviction — the gradient banner becomes the compact
            instrument header; the memo identity survives in the eyebrow. */}
        <div className="mb-6 pb-4 border-b border-rule">
          <PageHeader
            eyebrow="Multi-year financial history"
            title={extract.company_name ?? "Public records summary"}
            actions={
              <div className="flex items-center gap-2 flex-wrap print:hidden">
                <GuideMeButton pageId="multi-year-history" title="Multi-year history" steps={MULTIYEAR_GUIDE} />
                <button
                  onClick={() => window.print()}
                  data-testid="multiyear-print"
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-rule bg-surface text-ink text-[12.5px] font-medium hover:bg-bg-2 transition-colors duration-micro"
                >
                  Print / Save PDF
                </button>
              </div>
            }
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-soft">
            {extract.cui && <span><Hash size={11} className="inline mr-1 text-ink-mute" />CUI <span className="font-mono tabular-nums">{extract.cui}</span></span>}
            {extract.reg_com && <span><Building2 size={11} className="inline mr-1 text-ink-mute" />{extract.reg_com}</span>}
            {extract.caen_code && <span><MapPin size={11} className="inline mr-1 text-ink-mute" />CAEN <span className="font-mono tabular-nums">{extract.caen_code}</span>{extract.caen_description ? ` — ${extract.caen_description}` : ""}</span>}
            {extract.source_site && <span><Globe size={11} className="inline mr-1 text-ink-mute" />{extract.source_site}</span>}
          </div>
        </div>

        {/* Latest-year KPI row — quick read of "where is this company now".
            ONE AmountGroup: the three money tiles share a scale. */}
        {latest && (
          <MoneyAmountGroup
            values={[latest.cifra_afaceri, latest.profit_net, latest.datorii_totale]}
            fromCurrency="RON"
          >
            <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              <KpiTile
                label={`Revenue ${latest.year}`}
                value={<LearnableNumber conceptKey="operating_revenue" value={latest.cifra_afaceri}><MoneyAmount value={latest.cifra_afaceri} fromCurrency="RON" /></LearnableNumber>}
                sub={(() => {
                  const prev = years[1];
                  if (!prev || prev.cifra_afaceri <= 0) return "";
                  const yoy = (latest.cifra_afaceri / prev.cifra_afaceri - 1) * 100;
                  return `${yoy >= 0 ? "+" : ""}${yoy.toFixed(1)}% YoY`;
                })()}
                positive={(() => {
                  const prev = years[1];
                  if (!prev) return true;
                  return latest.cifra_afaceri >= prev.cifra_afaceri;
                })()}
              />
              <KpiTile
                label="Net profit"
                value={<LearnableNumber conceptKey="net_profit" value={latest.profit_net}><MoneyAmount value={latest.profit_net} fromCurrency="RON" /></LearnableNumber>}
                sub={latest.net_margin_pct != null ? `${latest.net_margin_pct.toFixed(1)}% net margin` : ""}
                positive={latest.profit_net > 0}
              />
              <KpiTile
                label="Total debt"
                value={<LearnableNumber conceptKey="total_debt" value={latest.datorii_totale}><MoneyAmount value={latest.datorii_totale} fromCurrency="RON" /></LearnableNumber>}
                sub={latest.capitaluri_proprii > 0 ? `D/E ${(latest.datorii_totale/latest.capitaluri_proprii).toFixed(2)}×` : ""}
                positive={true}
                neutral
              />
              <KpiTile
                label="Employees"
                // A year with no head-count in the filing is a GAP ("—"),
                // never a zero employees wearing the filing as its source.
                value={<Amount kind="count" value={latest.salariati} provenance={yearOrigin(latest.year)} />}
                sub={(() => {
                  const prev = years[1];
                  if (!prev || !prev.salariati || !latest.salariati) return "";
                  const delta = latest.salariati - prev.salariati;
                  return `${delta >= 0 ? "+" : ""}${delta} vs ${prev.year}`;
                })()}
                positive
                neutral
              />
            </section>
          </MoneyAmountGroup>
        )}

        {/* ── INSIGHTS — deterministic context paragraph ────────────────
            Synthesizes 4-6 observations from the multi-year data: revenue
            CAGR, profitability streak, loss recovery, employee growth,
            balance-sheet shape, and an overall verdict. No LLM — every
            number is read directly from the parsed table so the output
            is reproducible and audit-able.                                */}
        {years.length >= 2 && <InsightsSection years={years} company={extract.company_name ?? "The company"} />}

        {/* Multi-year table — newest → oldest. ONE AmountGroup over every
            money cell so the whole ledger reads on a single scale. */}
        <Panel className="mb-6">
          <PanelHeader
            title="Reported aggregates"
            actions={
              <span className="text-[11px] text-ink-mute">
                figures in <span className="font-mono">{display}</span>
              </span>
            }
          />
          <div className="overflow-x-auto">
          <MoneyAmountGroup
            values={years.flatMap((y) => [y.cifra_afaceri, y.profit_net, y.total_assets, y.datorii_totale, y.capitaluri_proprii])}
            fromCurrency="RON"
          >
            <table className="w-full text-[12.5px] min-w-[720px]">
              <thead className="bg-surface text-[10.5px] uppercase tracking-[0.08em] text-ink-mute">
                <tr className="border-b border-rule">
                  <th className="text-left px-4 h-8 font-medium">Year</th>
                  <th className="text-right px-3 h-8 font-medium">Revenue (cifra afaceri)</th>
                  <th className="text-right px-3 h-8 font-medium">Net profit</th>
                  <th className="text-right px-3 h-8 font-medium">Net margin</th>
                  <th className="text-right px-3 h-8 font-medium">Total assets</th>
                  <th className="text-right px-3 h-8 font-medium">Total debt</th>
                  <th className="text-right px-3 h-8 font-medium">Equity</th>
                  <th className="text-right px-3 h-8 font-medium">Employees</th>
                </tr>
              </thead>
              <tbody>
                {years.map((y, i) => {
                  const prev = years[i + 1];
                  const revGrowth = prev && prev.cifra_afaceri > 0 ? (y.cifra_afaceri / prev.cifra_afaceri - 1) * 100 : null;
                  const lossYear = y.profit_net < 0;
                  return (
                    <tr key={y.year} className={`border-t border-rule-soft first:border-t-0 h-8 ${lossYear ? "bg-alert-tint/40" : ""}`}>
                      <td className="px-4 py-1 font-mono font-medium text-ink tabular-nums">{y.year}</td>
                      <td className="px-3 py-1 text-right">
                        <MoneyAmount value={y.cifra_afaceri} fromCurrency="RON" unit={false} provenance={yearOrigin(y.year)} />
                        {revGrowth != null && (
                          <span className={`ml-1 font-mono tabular-nums text-[10px] ${revGrowth >= 0 ? "text-success" : "text-alert"}`}>
                            {revGrowth >= 0 ? "+" : ""}{revGrowth.toFixed(0)}%
                          </span>
                        )}
                      </td>
                      <td className={`px-3 py-1 text-right ${lossYear ? "text-alert" : ""}`}>
                        <MoneyAmount value={y.profit_net} fromCurrency="RON" unit={false} provenance={yearOrigin(y.year)} />
                      </td>
                      <td className={`px-3 py-1 text-right ${lossYear ? "text-alert" : "text-ink-soft"}`}>
                        <PercentLevel value={y.net_margin_pct} />
                      </td>
                      <td className="px-3 py-1 text-right text-ink-soft"><MoneyAmount value={y.total_assets} fromCurrency="RON" unit={false} provenance={yearOrigin(y.year)} /></td>
                      <td className="px-3 py-1 text-right text-ink-soft"><MoneyAmount value={y.datorii_totale} fromCurrency="RON" unit={false} provenance={yearOrigin(y.year)} /></td>
                      <td className="px-3 py-1 text-right"><MoneyAmount value={y.capitaluri_proprii} fromCurrency="RON" unit={false} provenance={yearOrigin(y.year)} /></td>
                      <td className="px-3 py-1 text-right text-ink-mute"><Amount kind="count" value={y.salariati} provenance={yearOrigin(y.year)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </MoneyAmountGroup>
          </div>
        </Panel>

        {/* Simple sparkline-style revenue + profit chart in pure SVG */}
        <TrendChart years={years.slice().reverse()} />

        <p className="mt-6 text-[10.5px] text-ink-mute leading-relaxed">
          <strong>Source.</strong> Data extracted from a public-records aggregator PDF
          ({extract.source_site ?? "listafirme.ro / termene.ro / firme.info family"}).
          All numbers are read deterministically from the source — zero LLM in the
          calculation path. Confidence: {extract.confidence != null ? (extract.confidence * 100).toFixed(0) : "—"}%.
          Public-records aggregates are filed by ANAF / ONRC — same source banks and
          due-diligence services use. For trial-balance-level detail upload the
          internal balanță de verificare separately.
        </p>
      </div>
    </>
  );
}

// CUR-FIX — ANAF / ONRC public-records data is always filed in RON. The
// `fmtRON` helper used to assume RON for display too; we now route the
// value through the global currency switcher so toggling EUR/USD in
// TopHeader updates this page along with the rest of the surfaces.
import { useCurrency } from "@/stores/currency";
import { convertFromTo } from "@/lib/money";

function fmtRON(n: number): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} B`;
  if (abs >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)} M`;
  if (abs >= 1_000)         return `${(n / 1_000).toFixed(0)} K`;
  return n.toFixed(0);
}

/** CUR-FIX — `fmtCur(n)` is the currency-aware drop-in replacement for
 *  `fmtRON(n)`. Source RON → display currency, then compact format. */
function useFmtCur() {
  const { display, rates } = useCurrency();
  return (n: number | null | undefined): string => {
    if (n == null || !Number.isFinite(n)) return "—";
    const converted = convertFromTo(n, "RON", display, rates.rates);
    return fmtRON(converted);
  };
}

function KpiTile({ label, value, sub, positive, neutral }: {
  label: string; value: React.ReactNode; sub: string; positive: boolean; neutral?: boolean;
}) {
  // Sentiment carries through the SEMANTIC pair only: success for gains,
  // alert for losses; neutral figures stay ink.
  const Color = neutral ? "text-ink" : (positive ? "text-success" : "text-alert");
  const Trend = neutral ? null : (positive ? TrendingUp : TrendingDown);
  return (
    <Panel className="p-4">
      <div className="text-[10px] uppercase tracking-[0.12em] text-ink-mute font-medium">{label}</div>
      <div className={`mt-1 text-[21px] leading-tight ${Color}`}>{value}</div>
      {sub && (
        <div className="mt-1 text-[11.5px] text-ink-mute flex items-center gap-1">
          {Trend && <Trend size={11} className={Color} />}
          <span>{sub}</span>
        </div>
      )}
    </Panel>
  );
}

// Insights — deterministic context paragraph + 4-6 bullet observations.
// Reads the multi-year array (years sorted newest→oldest) and computes:
//   · revenue CAGR over the full span
//   · count of profitable vs loss years
//   · best year and worst year
//   · employee growth
//   · D/E trajectory (leverage rising or falling)
//   · margin trend (3-year average vs first-3-year average)
//   · verdict — short headline sentence
// Then renders as a navy "CFO read" card matching the comprehensive
// report's executive-summary style. No LLM call — every number is
// computed directly from the data, so output is audit-able.
function InsightsSection({ years, company }: { years: YearRow[]; company: string }) {
  // CUR-FIX — currency-aware compact formatter for in-prose money mentions.
  const fmtCur = useFmtCur();
  // years arrives newest→oldest; build the analysis from oldest→newest
  // (chronological) since CAGR / trends read more naturally that way.
  const sorted = [...years].sort((a, b) => a.year - b.year);
  const first = sorted[0];
  const latest = sorted[sorted.length - 1];
  const n = sorted.length;

  // Revenue CAGR over the full reporting window.
  const cagr = (first.cifra_afaceri > 0 && latest.cifra_afaceri > 0 && n > 1)
    ? (Math.pow(latest.cifra_afaceri / first.cifra_afaceri, 1 / (n - 1)) - 1) * 100
    : null;

  // Profitability streak.
  const profitYears = sorted.filter((y) => y.profit_net > 0).length;
  const lossYears = sorted.filter((y) => y.profit_net < 0).length;
  const lossYearsList = sorted.filter((y) => y.profit_net < 0).map((y) => y.year);

  // Best & worst year (by net profit absolute).
  const bestYear = [...sorted].sort((a, b) => b.profit_net - a.profit_net)[0];
  const worstYear = [...sorted].sort((a, b) => a.profit_net - b.profit_net)[0];

  // Employee growth.
  const empGrowth = (first.salariati && latest.salariati)
    ? latest.salariati - first.salariati
    : null;
  const empGrowthPct = (first.salariati && latest.salariati && first.salariati > 0)
    ? ((latest.salariati / first.salariati) - 1) * 100
    : null;

  // Recent profitability trend: 3-year average net margin (or shorter span).
  const recentWindow = Math.min(3, sorted.length);
  const recent = sorted.slice(-recentWindow);
  const recentNetMargin = (() => {
    const totalRev = recent.reduce((s, y) => s + y.cifra_afaceri, 0);
    const totalProf = recent.reduce((s, y) => s + y.profit_net, 0);
    return totalRev > 0 ? (totalProf / totalRev) * 100 : null;
  })();

  // Capital structure — D/E in latest year.
  const latestDE = latest.capitaluri_proprii > 0 ? latest.datorii_totale / latest.capitaluri_proprii : null;

  // Verdict headline — pick from the strongest signal.
  const verdict = (() => {
    if (lossYears > profitYears) return { tone: "alert" as const, text: `Distress profile — ${lossYears}/${n} years posted a net loss.` };
    if (recentNetMargin != null && recentNetMargin >= 15) return { tone: "ok" as const, text: `Premium-margin operator — ${recentNetMargin.toFixed(0)}% net margin over the last ${recentWindow} years.` };
    if (recentNetMargin != null && recentNetMargin >= 5) return { tone: "ok" as const, text: `Healthy profitability — ${recentNetMargin.toFixed(1)}% net margin over the last ${recentWindow} years.` };
    if (recentNetMargin != null && recentNetMargin >= 0) return { tone: "warn" as const, text: `Thin margins — ${recentNetMargin.toFixed(1)}% net margin over the last ${recentWindow} years.` };
    return { tone: "warn" as const, text: `Margins compressed — review the cost structure.` };
  })();
  // Verdict tone → the semantic ladder: success / caution / alert (the
  // one allowed red — a majority-loss distress profile).
  const verdictRule =
    verdict.tone === "ok" ? "border-l-success"
    : verdict.tone === "warn" ? "border-l-caution"
    : "border-l-alert";

  // Bullets — pick the meaningful ones; never invent.
  const bullets: string[] = [];
  if (cagr != null) {
    const verb = cagr >= 0 ? "grew" : "declined";
    bullets.push(`Revenue ${verb} from ${fmtCur(first.cifra_afaceri)} (${first.year}) to ${fmtCur(latest.cifra_afaceri)} (${latest.year}) — ${cagr >= 0 ? "+" : ""}${cagr.toFixed(1)}% CAGR over ${n - 1} years.`);
  }
  if (lossYears > 0 && lossYears < n) {
    bullets.push(`${profitYears}/${n} years profitable; loss years: ${lossYearsList.join(", ")}.`);
  } else if (lossYears === 0 && profitYears > 0) {
    bullets.push(`All ${n} reporting years posted a net profit — no recorded loss in the window.`);
  }
  if (bestYear && worstYear && bestYear !== worstYear) {
    bullets.push(`Peak profit: ${fmtCur(bestYear.profit_net)} in ${bestYear.year}; trough: ${fmtCur(worstYear.profit_net)} in ${worstYear.year}.`);
  }
  if (empGrowth != null && empGrowthPct != null) {
    const verb = empGrowth >= 0 ? "grew" : "shrunk";
    bullets.push(`Headcount ${verb} from ${first.salariati} (${first.year}) to ${latest.salariati} (${latest.year}) — ${empGrowth >= 0 ? "+" : ""}${empGrowth} (${empGrowthPct >= 0 ? "+" : ""}${empGrowthPct.toFixed(0)}%).`);
  }
  if (latestDE != null) {
    const lev = latestDE < 0.5 ? "conservatively geared"
              : latestDE < 1.0 ? "moderately geared"
              : latestDE < 2.0 ? "elevated leverage"
              : "highly leveraged";
    bullets.push(`Latest balance sheet (${latest.year}): debt-to-equity ${latestDE.toFixed(2)}× — ${lev}.`);
  }

  return (
    <section data-testid="multiyear-insights" className="mb-6 space-y-3">
      <Panel className={`border-l-[3px] ${verdictRule} px-5 py-4`}>
        <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium mb-1">
          CFO read · 20-year context
        </div>
        <p className="text-[15px] font-semibold tracking-[-0.005em] text-ink leading-snug">{verdict.text}</p>
        <p className="mt-2 text-[12.5px] text-ink-soft">
          {company} reports {n} years of public financial data ({first.year} – {latest.year}).
          The observations below are computed directly from the source — no LLM
          interpretation, every number is in the table.
        </p>
      </Panel>
      <ul className="space-y-1.5 text-[13px] text-ink-soft leading-relaxed pl-5">
        {bullets.map((b, i) => (
          <li key={i} className="list-disc marker:text-ink-mute">{b}</li>
        ))}
      </ul>
    </section>
  );
}

function TrendChart({ years }: { years: YearRow[] }) {
  // Pure-SVG dual-line chart: revenue (brand) + net profit (success).
  // We don't import recharts because the rest of the app uses inline SVG
  // for trend renders and we want this page to feel consistent.
  //
  // Colors flow through Tailwind stroke-*/fill-* token utilities so the
  // chart re-themes with Paper/Terminal like every other surface. Y-axis
  // labels are currency-converted (formerly hardcoded `fmtRON`) so
  // toggling EUR/USD in the top bar repaints the chart axis too. SVG
  // <text> can't host a React component — we use the same `useFmtCur()`
  // helper as the rest of this file.
  const fmtCur = useFmtCur();
  if (years.length < 2) return null;
  const w = 1100;
  const h = 220;
  const padL = 64, padR = 24, padT = 16, padB = 30;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const xs = years.map((y) => y.year);
  const revs = years.map((y) => y.cifra_afaceri);
  const profs = years.map((y) => y.profit_net);
  const yMin = Math.min(0, ...profs, ...revs);
  const yMax = Math.max(...profs, ...revs);
  const xScale = (i: number) => padL + (i / (years.length - 1)) * innerW;
  const yScale = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin || 1)) * innerH;
  const revPath = years.map((y, i) => `${i === 0 ? "M" : "L"}${xScale(i)},${yScale(y.cifra_afaceri)}`).join(" ");
  const profPath = years.map((y, i) => `${i === 0 ? "M" : "L"}${xScale(i)},${yScale(y.profit_net)}`).join(" ");
  // Zero baseline
  const zeroY = yScale(0);
  return (
    <Panel>
      <PanelHeader
        title={<>Revenue + net profit · <span className="font-mono tabular-nums normal-case">{xs[0]} → {xs[xs.length - 1]}</span></>}
        actions={
          <div className="flex items-center gap-3 text-[11.5px] text-ink-soft">
            <span className="inline-flex items-center gap-1"><span className="w-3 h-0.5 bg-brand"></span>Revenue</span>
            <span className="inline-flex items-center gap-1"><span className="w-3 h-0.5 bg-success"></span>Net profit</span>
          </div>
        }
      />
      <div className="p-4">
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="xMidYMid meet">
        {/* Zero baseline */}
        {yMin < 0 && (
          <line x1={padL} y1={zeroY} x2={w - padR} y2={zeroY} className="stroke-rule" strokeDasharray="2 3" />
        )}
        {/* Revenue line */}
        <path d={revPath} fill="none" className="stroke-brand" strokeWidth="2" />
        {/* Profit line */}
        <path d={profPath} fill="none" className="stroke-success" strokeWidth="2" />
        {/* X-axis labels — every other year to keep it readable */}
        {xs.map((y, i) => (
          (i % 2 === 0 || i === xs.length - 1) && (
            <text key={y} x={xScale(i)} y={h - padB + 16} textAnchor="middle" fontSize="10" className="fill-ink-mute font-mono tabular-nums">{y}</text>
          )
        ))}
        {/* Y-axis ticks — min, 0, max */}
        <text x={padL - 6} y={yScale(yMax) + 4} textAnchor="end" fontSize="10" className="fill-ink-mute font-mono tabular-nums">{fmtCur(yMax)}</text>
        {yMin < 0 && <text x={padL - 6} y={zeroY + 4} textAnchor="end" fontSize="10" className="fill-ink-mute font-mono tabular-nums">0</text>}
        <text x={padL - 6} y={yScale(yMin) + 4} textAnchor="end" fontSize="10" className="fill-ink-mute font-mono tabular-nums">{fmtCur(yMin)}</text>
      </svg>
      </div>
    </Panel>
  );
}
