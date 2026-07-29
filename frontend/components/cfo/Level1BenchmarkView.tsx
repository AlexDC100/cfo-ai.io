// Level-1 Benchmark View — rendered when the user has only a public-
// records summary (listafirme/termene/firme.info PDF), no financial_
// period. The full BenchmarkReport page requires period-scoped data
// (calculated_metrics + statement_line_items) it doesn't have here, so
// we substitute this honest Level-1 view: a company-identity card,
// the latest-year metrics WE can derive (margin, equity ratio, debt
// ratios, asset turnover), industry-category benchmarks where seeded,
// and a clear DataDepthBanner explaining what's gated.
//
// Backend source: GET /api/benchmarks/public-records/latest
// (optionally ?document_id=<uuid> to pin to a specific upload).

import { useEffect, useState } from "react";
import { Loader2, Hash, Briefcase, Building2, TrendingUp, TrendingDown, AlertCircle, Info, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { getSupabase } from "@/lib/supabase";
import { DataDepthBanner } from "./DataDepthBanner";
import { DEPTH_PUBLIC_SUMMARY } from "@/lib/dataDepth";

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
  total_assets?: number;
  salariati: number | null;
}

interface Benchmark {
  p25: number | null;
  p50: number | null;
  p75: number | null;
  unit: string | null;
  source: string | null;
  source_year: number | null;
  confidence: string | null;
  notes: string | null;
}

interface Comparison {
  metric_name: string;
  company_value: number | null;
  benchmark: Benchmark;
  verdict: "top_quartile" | "above_median" | "below_median" | "bottom_quartile" | "not_available";
  lower_is_better: boolean;
}

interface Payload {
  mode: string;
  company: { name: string | null; cui: string | null; reg_com: string | null; caen_code: string | null; caen_label: string | null };
  industry: { category: string; source: string; label: string };
  benchmark_source: "exact_caen" | "category_aggregate" | "none";
  depth_level: number;
  latest_year: { year: number; metrics: Record<string, number | null> };
  history: YearRow[];
  comparisons: Comparison[];
  warnings: string[];
  document_id: string;
  generated_at: string;
}

interface Props {
  /** Optional — pins to a specific public-records document. When null,
   *  the backend returns the org's most-recent public-records upload. */
  documentId?: string | null;
}

const METRIC_LABELS: Record<string, { en: string; ro: string; fmt: "pct" | "ratio" | "currency" }> = {
  net_margin:           { en: "Net margin",            ro: "Marjă netă",          fmt: "pct"      },
  equity_ratio:         { en: "Equity ratio",          ro: "Pondere capitaluri",  fmt: "pct"      },
  debt_to_equity:       { en: "Debt / Equity",         ro: "Datorii / Capital",   fmt: "ratio"    },
  debt_to_assets:       { en: "Debt / Total assets",   ro: "Datorii / Total",     fmt: "pct"      },
  asset_turnover:       { en: "Asset turnover",        ro: "Rotația activelor",   fmt: "ratio"    },
  revenue_per_employee: { en: "Revenue per employee",  ro: "Cifră/salariat",      fmt: "currency" },
  profit_per_employee:  { en: "Profit per employee",   ro: "Profit/salariat",     fmt: "currency" },
  revenue_yoy_pct:      { en: "Revenue YoY growth",    ro: "Creștere CA YoY",     fmt: "pct"      },
  profit_yoy_pct:       { en: "Profit YoY growth",     ro: "Creștere profit YoY", fmt: "pct"      },
};

export function Level1BenchmarkView({ documentId }: Props) {
  const [data, setData] = useState<Payload | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [errMsg, setErrMsg] = useState<string>("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const sb = getSupabase();
        const session = sb ? (await sb.auth.getSession()).data.session : null;
        const token = session?.access_token;
        if (!token) { if (active) setState("empty"); return; }
        const qs = documentId ? `?document_id=${documentId}` : "";
        const r = await fetch(`${apiBase()}/api/benchmarks/public-records/latest${qs}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!active) return;
        if (r.status === 404) { setState("empty"); return; }
        if (!r.ok) {
          setState("error");
          try { setErrMsg((await r.json()).detail ?? r.statusText); }
          catch { setErrMsg(r.statusText); }
          return;
        }
        setData(await r.json());
        setState("ready");
      } catch (e) {
        if (active) { setState("error"); setErrMsg((e as Error).message); }
      }
    })();
    return () => { active = false; };
  }, [documentId]);

  if (state === "loading") {
    return (
      <div className="max-w-[680px] mx-auto py-16 text-center">
        <Loader2 size={20} className="animate-spin mx-auto text-ink-mute mb-3" />
        <p className="text-[13px] text-ink-soft">Building Level-1 benchmark…</p>
      </div>
    );
  }
  if (state === "empty") {
    return (
      <div className="max-w-[680px] mx-auto py-16 text-center">
        <h1 className="font-serif text-[24px] text-ink mb-2">No benchmark data yet</h1>
        <p className="text-[13px] text-ink-soft">
          Upload either a Romanian trial balance (for a full ratio benchmark) or a
          listafirme.ro / termene.ro public-records PDF (for a Level-1 benchmark
          on revenue, profit, debt and equity ratios) on the Dashboard.
        </p>
      </div>
    );
  }
  if (state === "error" || !data) {
    return (
      <div className="max-w-[680px] mx-auto py-16">
        <div className="rounded-lg border border-[hsl(var(--warning-2)/0.4)] bg-[hsl(var(--warning-2-tint))]/40 p-5">
          <h1 className="font-serif text-[20px] text-ink mb-1">Benchmark error</h1>
          <p className="text-[12.5px] text-ink-soft">{errMsg || "Unknown error."}</p>
        </div>
      </div>
    );
  }

  const latest = data.latest_year;
  const m = latest.metrics;

  // Build a quick map of comparisons by metric_name for the section below.
  const cmpByMetric = new Map<string, Comparison>();
  data.comparisons.forEach((c) => cmpByMetric.set(c.metric_name, c));

  return (
    <div className="max-w-[1200px] mx-auto py-6 px-2">
      <DataDepthBanner depth={DEPTH_PUBLIC_SUMMARY} subject={data.company.name} />

      {/* Company identity header */}
      <header className="rounded-2xl px-6 py-6 mb-6 text-white"
              style={{ background: "linear-gradient(135deg, #1B7268 0%, #2AA89B 100%)" }}>
        <div className="flex flex-col gap-3">
          <div className="text-[10.5px] uppercase tracking-[0.14em] opacity-80">
            Industry benchmark — Level 1 (Public Financial Summary)
          </div>
          <h1 className="font-serif text-[28px] leading-tight">
            {data.company.name || "Romanian company"}
          </h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] opacity-90">
            {data.company.cui && <span><Hash size={11} className="inline mr-1" />CUI {data.company.cui}</span>}
            {data.company.reg_com && <span><Building2 size={11} className="inline mr-1" />{data.company.reg_com}</span>}
            {data.company.caen_code && (
              <span><Briefcase size={11} className="inline mr-1" />CAEN {data.company.caen_code} — {data.company.caen_label}</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2 mt-1">
            <span className="inline-block text-[10.5px] uppercase tracking-[0.08em] font-semibold px-2 py-0.5 rounded-md"
                  style={{ background: "rgba(92,211,197,0.18)", color: "#8FE3D9", border: "1px solid rgba(92,211,197,0.30)" }}>
              Industry: {data.industry.category}
              {data.industry.source === "mapped_2digit" ? " · auto-detected from CAEN" : ""}
            </span>
            <Link
              to={`/multi-year-history?doc=${data.document_id}`}
              className="inline-flex items-center gap-1 text-[12px] underline decoration-white/30 hover:decoration-white/60"
            >
              See full multi-year history <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        </div>
      </header>

      {/* Latest-year KPI strip — what we can read directly from the PDF */}
      <section className="rounded-lg border border-rule bg-surface mb-6">
        <div className="px-5 py-3 border-b border-rule">
          <h2 className="text-[14px] font-semibold text-ink">
            {latest.year} snapshot — extracted from public records
          </h2>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4">
          <BigKPI label="Revenue"        value={m.revenue}      fmt="currency" />
          <BigKPI label="Net profit"     value={m.net_profit}   fmt="currency" tone={(m.net_profit ?? 0) >= 0 ? "positive" : "negative"} />
          <BigKPI label="Total assets"   value={m.total_assets} fmt="currency" />
          <BigKPI label="Total debt"     value={m.total_debt}   fmt="currency" />
          <BigKPI label="Equity"         value={m.total_equity} fmt="currency" />
          <BigKPI label="Employees"      value={m.employees}    fmt="int" />
          <BigKPI label="Net margin"     value={m.net_margin}   fmt="pct" />
          <BigKPI label="Equity ratio"   value={m.equity_ratio} fmt="pct" />
        </div>
      </section>

      {/* Industry comparison table */}
      <section className="rounded-lg border border-rule bg-surface mb-6">
        <div className="px-5 py-3 border-b border-rule flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-ink">
            Comparison vs industry ({data.industry.label})
          </h2>
          {data.benchmark_source === "category_aggregate" && (
            <span className="inline-flex items-center gap-1 text-[10.5px] text-ink-soft">
              <Info className="h-3 w-3" />
              Aggregated across category — exact CAEN not yet seeded
            </span>
          )}
        </div>
        {data.comparisons.length === 0 ? (
          <div className="p-5 text-[13px] text-ink-soft">
            No benchmarks seeded yet for this CAEN or its category. Our catalogue is
            expanding; check back soon or contact support to prioritize your industry.
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-[0.06em] text-ink-soft border-b border-rule">
                <th className="px-4 py-2">Metric</th>
                <th className="px-4 py-2 text-right">{data.company.name?.split(" ")[0] || "Company"}</th>
                <th className="px-4 py-2 text-right">P25</th>
                <th className="px-4 py-2 text-right">Median</th>
                <th className="px-4 py-2 text-right">P75</th>
                <th className="px-4 py-2">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {data.comparisons.map((c) => {
                const lbl = METRIC_LABELS[c.metric_name] ?? { en: c.metric_name, ro: c.metric_name, fmt: "ratio" as const };
                return (
                  <tr key={c.metric_name} className="border-b border-rule/50 hover:bg-bg-2/30">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-ink">{lbl.en}</div>
                      <div className="text-[11px] text-ink-soft">{lbl.ro}</div>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-ink">
                      {fmtVal(c.company_value, lbl.fmt)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-soft">
                      {fmtVal(c.benchmark.p25, lbl.fmt)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-soft">
                      {fmtVal(c.benchmark.p50, lbl.fmt)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-soft">
                      {fmtVal(c.benchmark.p75, lbl.fmt)}
                    </td>
                    <td className="px-4 py-2.5">
                      <VerdictPill verdict={c.verdict} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* Warnings / disclosures */}
      {data.warnings.length > 0 && (
        <section className="rounded-lg border border-[hsl(var(--warning-2)/0.4)] bg-[hsl(var(--warning-2-tint))]/40 p-4 mb-6">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-[hsl(var(--warning-2))]" />
            <div className="text-[12.5px] text-ink space-y-1">
              {data.warnings.map((w, i) => <div key={i}>· {w}</div>)}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

interface BigKPIProps {
  label: string;
  value: number | null | undefined;
  fmt: "currency" | "pct" | "ratio" | "int";
  tone?: "neutral" | "positive" | "negative";
}
function BigKPI({ label, value, fmt, tone = "neutral" }: BigKPIProps) {
  const color = tone === "negative" ? "#c62828" : tone === "positive" ? "#2AA89B" : "#1a1a1a";
  return (
    <div className="rounded-lg border border-rule bg-bg-2/30 p-3">
      <div className="text-[10.5px] uppercase tracking-[0.06em] text-ink-soft">{label}</div>
      <div className="text-[18px] font-semibold mt-0.5 tabular-nums" style={{ color }}>
        {fmtVal(value, fmt)}
      </div>
    </div>
  );
}

function fmtVal(v: number | null | undefined, fmt: "currency" | "pct" | "ratio" | "int"): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (fmt === "pct") return `${(v * 100).toFixed(1)}%`;
  if (fmt === "ratio") return `${v.toFixed(2)}×`;
  if (fmt === "int") return Math.round(v).toLocaleString();
  // currency — abbreviate large numbers
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)} B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)} M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(0)} K`;
  return v.toLocaleString();
}

function VerdictPill({ verdict }: { verdict: Comparison["verdict"] }) {
  const map: Record<typeof verdict, { label: string; bg: string; fg: string }> = {
    top_quartile:    { label: "Top quartile",    bg: "#E6F7F4", fg: "#2AA89B" },
    above_median:    { label: "Above median",    bg: "#E6F7F4", fg: "#2AA89B" },
    below_median:    { label: "Below median",    bg: "#E6F7F4", fg: "#2AA89B" },
    bottom_quartile: { label: "Bottom quartile", bg: "#fde8e8", fg: "#c62828" },
    not_available:   { label: "n/a",             bg: "#f0f4f8", fg: "#5a6577" },
  };
  const v = map[verdict];
  return (
    <span className="inline-flex items-center text-[10.5px] uppercase tracking-[0.04em] font-semibold px-2 py-0.5 rounded-md"
          style={{ background: v.bg, color: v.fg }}>
      {v.label}
    </span>
  );
}
