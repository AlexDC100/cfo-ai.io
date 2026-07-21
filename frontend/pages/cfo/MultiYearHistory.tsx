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
        <h1 className="font-serif text-[28px] text-ink">No public-records data yet</h1>
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

        {/* Header card matching the institutional-memo pattern */}
        <header className="rounded-2xl px-6 py-6 mb-6 text-white"
                style={{ background: "linear-gradient(135deg, #1B7268 0%, #2AA89B 100%)" }}>
          {/* 2026-05-26 (mobile fix): stack vertically on mobile so
              the 32px serif company name doesn't get column-stacked
              by the Print/Save PDF button cluster on iPhone widths. */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <div className="text-[10.5px] uppercase tracking-[0.14em] opacity-80">
                Multi-year financial history
              </div>
              <h1 className="mt-1 font-serif text-[26px] sm:text-[32px] leading-tight">
                {extract.company_name ?? "Public records summary"}
              </h1>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] opacity-90">
                {extract.cui && <span><Hash size={11} className="inline mr-1" />CUI {extract.cui}</span>}
                {extract.reg_com && <span><Building2 size={11} className="inline mr-1" />{extract.reg_com}</span>}
                {extract.caen_code && <span><MapPin size={11} className="inline mr-1" />CAEN {extract.caen_code}{extract.caen_description ? ` — ${extract.caen_description}` : ""}</span>}
                {extract.source_site && <span><Globe size={11} className="inline mr-1" />{extract.source_site}</span>}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap sm:shrink-0 print:hidden">
              <GuideMeButton pageId="multi-year-history" title="Multi-year history" steps={MULTIYEAR_GUIDE} />
              <button
                onClick={() => window.print()}
                data-testid="multiyear-print"
                className="inline-flex items-center gap-1.5 rounded-md bg-rule-soft/60 hover:bg-rule-soft px-3 py-1.5 text-[12.5px] font-medium transition-colors"
              >
                Print / Save PDF
              </button>
            </div>
          </div>
        </header>

        {/* Latest-year KPI row — quick read of "where is this company now" */}
        {latest && (
          <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <KpiTile
              label={`Revenue ${latest.year}`}
              value={<LearnableNumber conceptKey="operating_revenue" value={latest.cifra_afaceri}>{fmtCur(latest.cifra_afaceri)}</LearnableNumber>}
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
              value={<LearnableNumber conceptKey="net_profit" value={latest.profit_net}>{fmtCur(latest.profit_net)}</LearnableNumber>}
              sub={latest.net_margin_pct != null ? `${latest.net_margin_pct.toFixed(1)}% net margin` : ""}
              positive={latest.profit_net > 0}
            />
            <KpiTile
              label="Total debt"
              value={<LearnableNumber conceptKey="total_debt" value={latest.datorii_totale}>{fmtCur(latest.datorii_totale)}</LearnableNumber>}
              sub={latest.capitaluri_proprii > 0 ? `D/E ${(latest.datorii_totale/latest.capitaluri_proprii).toFixed(2)}×` : ""}
              positive={true}
              neutral
            />
            <KpiTile
              label="Employees"
              value={(latest.salariati ?? 0).toLocaleString()}
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
        )}

        {/* ── INSIGHTS — deterministic context paragraph ────────────────
            Synthesizes 4-6 observations from the multi-year data: revenue
            CAGR, profitability streak, loss recovery, employee growth,
            balance-sheet shape, and an overall verdict. No LLM — every
            number is read directly from the parsed table so the output
            is reproducible and audit-able.                                */}
        {years.length >= 2 && <InsightsSection years={years} company={extract.company_name ?? "The company"} />}

        {/* Multi-year table — newest → oldest */}
        <section className="rounded-2xl border border-rule bg-surface overflow-x-auto mb-6">
          <table className="w-full text-[12.5px]">
            <thead className="bg-bg-2/40 text-[10.5px] uppercase tracking-[0.08em] text-ink-mute">
              <tr>
                <th className="text-left px-3 py-2.5">Year</th>
                <th className="text-right px-3 py-2.5">Revenue (cifra afaceri)</th>
                <th className="text-right px-3 py-2.5">Net profit</th>
                <th className="text-right px-3 py-2.5">Net margin</th>
                <th className="text-right px-3 py-2.5">Total assets</th>
                <th className="text-right px-3 py-2.5">Total debt</th>
                <th className="text-right px-3 py-2.5">Equity</th>
                <th className="text-right px-3 py-2.5">Employees</th>
              </tr>
            </thead>
            <tbody>
              {years.map((y, i) => {
                const prev = years[i + 1];
                const revGrowth = prev && prev.cifra_afaceri > 0 ? (y.cifra_afaceri / prev.cifra_afaceri - 1) * 100 : null;
                const lossYear = y.profit_net < 0;
                return (
                  <tr key={y.year} className={`border-t border-rule/40 ${lossYear ? "bg-red-50/30 dark:bg-red-500/[0.04]" : ""}`}>
                    <td className="px-3 py-2 font-medium text-ink tabular-nums">{y.year}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtCur(y.cifra_afaceri)}
                      {revGrowth != null && (
                        <span className={`ml-1 text-[10px] ${revGrowth >= 0 ? "text-[#2AA89B]" : "text-red-600"}`}>
                          {revGrowth >= 0 ? "+" : ""}{revGrowth.toFixed(0)}%
                        </span>
                      )}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${lossYear ? "text-red-700" : ""}`}>
                      {fmtCur(y.profit_net)}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${lossYear ? "text-red-700" : "text-ink-soft"}`}>
                      {y.net_margin_pct != null ? `${y.net_margin_pct.toFixed(1)}%` : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-soft">{fmtCur(y.total_assets)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-soft">{fmtCur(y.datorii_totale)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtCur(y.capitaluri_proprii)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-mute">{y.salariati ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

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
  label: string; value: string; sub: string; positive: boolean; neutral?: boolean;
}) {
  const Color = neutral ? "text-ink" : (positive ? "text-[#2AA89B] dark:text-[#5CD3C5]" : "text-red-700 dark:text-red-400");
  const Trend = neutral ? null : (positive ? TrendingUp : TrendingDown);
  return (
    <div className="rounded-xl border border-rule bg-surface p-4">
      <div className="text-[10px] uppercase tracking-[0.12em] text-ink-mute font-medium">{label}</div>
      <div className={`mt-1 font-serif text-[26px] leading-tight tabular-nums ${Color}`}>{value}</div>
      {sub && (
        <div className="mt-1 text-[11.5px] text-ink-mute flex items-center gap-1">
          {Trend && <Trend size={11} className={Color} />}
          <span>{sub}</span>
        </div>
      )}
    </div>
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
  const verdictColor =
    verdict.tone === "ok" ? "border-[#8FE3D9]/50 bg-[#E6F7F4]/40 dark:bg-[#5CD3C5]/[0.06]"
    : verdict.tone === "warn" ? "border-[#8FE3D9]/50 bg-[#E6F7F4]/40 dark:bg-[#5CD3C5]/[0.06]"
    : "border-red-300/50 bg-red-50/40 dark:bg-red-500/[0.06]";

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
      <div className={`rounded-2xl border-l-[3px] ${verdictColor} border border-rule bg-surface px-5 py-4`}>
        <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium mb-1">
          CFO read · 20-year context
        </div>
        <p className="font-serif text-[17px] text-ink leading-snug">{verdict.text}</p>
        <p className="mt-2 text-[12.5px] text-ink-soft">
          {company} reports {n} years of public financial data ({first.year} – {latest.year}).
          The observations below are computed directly from the source — no LLM
          interpretation, every number is in the table.
        </p>
      </div>
      <ul className="space-y-1.5 text-[13px] text-ink-soft leading-relaxed pl-5">
        {bullets.map((b, i) => (
          <li key={i} className="list-disc marker:text-ink-mute">{b}</li>
        ))}
      </ul>
    </section>
  );
}

function TrendChart({ years }: { years: YearRow[] }) {
  // Pure-SVG dual-line chart: revenue (blue) + net profit (emerald).
  // We don't import recharts because the rest of the app uses inline SVG
  // for trend renders and we want this page to feel consistent.
  //
  // Y-axis labels are currency-converted (formerly hardcoded `fmtRON`) so
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
    <section className="rounded-2xl border border-rule bg-surface p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-serif text-[15px] text-ink">Revenue + net profit · {xs[0]} → {xs[xs.length-1]}</h3>
        <div className="flex items-center gap-3 text-[11.5px]">
          <span className="inline-flex items-center gap-1"><span className="w-3 h-0.5 bg-[#2AA89B]"></span>Revenue</span>
          <span className="inline-flex items-center gap-1"><span className="w-3 h-0.5 bg-[#2AA89B]"></span>Net profit</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="xMidYMid meet">
        {/* Zero baseline */}
        {yMin < 0 && (
          <line x1={padL} y1={zeroY} x2={w - padR} y2={zeroY} stroke="#d1d5db" strokeDasharray="2 3" />
        )}
        {/* Revenue area + line */}
        <path d={revPath} fill="none" stroke="#5CD3C5" strokeWidth="2" />
        {/* Profit line */}
        <path d={profPath} fill="none" stroke="#2AA89B" strokeWidth="2" />
        {/* X-axis labels — every other year to keep it readable */}
        {xs.map((y, i) => (
          (i % 2 === 0 || i === xs.length - 1) && (
            <text key={y} x={xScale(i)} y={h - padB + 16} textAnchor="middle" fontSize="10" fill="#6b7280">{y}</text>
          )
        ))}
        {/* Y-axis ticks — min, 0, max */}
        <text x={padL - 6} y={yScale(yMax) + 4} textAnchor="end" fontSize="10" fill="#6b7280">{fmtCur(yMax)}</text>
        {yMin < 0 && <text x={padL - 6} y={zeroY + 4} textAnchor="end" fontSize="10" fill="#6b7280">0</text>}
        <text x={padL - 6} y={yScale(yMin) + 4} textAnchor="end" fontSize="10" fill="#6b7280">{fmtCur(yMin)}</text>
      </svg>
    </section>
  );
}
