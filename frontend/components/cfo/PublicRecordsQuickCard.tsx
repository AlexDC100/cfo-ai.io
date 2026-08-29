// PublicRecordsQuickCard — rendered on the dashboard empty state when
// the user has at least one public-records upload (listafirme.ro /
// termene.ro / firme.info PDF) but no financial period loaded.
//
// Solves the "I uploaded my PDF and the dashboard shows nothing" gap.
// At Level 1 (public summary) we can't reconstruct EBITDA or detailed
// P&L but we CAN show: company identity, latest-year snapshot KPIs, a
// honest data-depth banner, and a one-click jump into the full
// Multi-Year History view.
//
// Polls `/api/public-records/latest` on mount. Renders nothing when
// the endpoint returns `{ extract: null }` (i.e. the org has no
// public-records uploads — the upload zone below this in the dashboard
// is the right surface in that case).

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Building2, Hash, Briefcase, TrendingUp, TrendingDown, Loader2 } from "lucide-react";
import { getSupabase } from "@/lib/supabase";
import { DataDepthBanner } from "./DataDepthBanner";
import { DEPTH_PUBLIC_SUMMARY } from "@/lib/dataDepth";
import { PUBLIC_RECORDS_ENABLED } from "@/config/features";

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
  document: { id: string; filename: string; status: string; created_at: string };
  company_name: string | null;
  cui: string | null;
  caen_code: string | null;
  caen_description: string | null;
  source_site: string | null;
  confidence: number | null;
  years: YearRow[];
}

export function PublicRecordsQuickCard() {
  const [extract, setExtract] = useState<Extract | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");

  useEffect(() => {
    // Flag-gated: when PUBLIC_RECORDS_ENABLED is false (current product
    // positioning), skip the backend fetch entirely so the card never
    // renders. Component returns null on the next paint.
    if (!PUBLIC_RECORDS_ENABLED) {
      setState("empty");
      return;
    }
    let active = true;
    void (async () => {
      try {
        const sb = getSupabase();
        const session = sb ? (await sb.auth.getSession()).data.session : null;
        const token = session?.access_token;
        if (!token) { if (active) setState("empty"); return; }
        const r = await fetch(`${apiBase()}/api/public-records/latest`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!active) return;
        if (!r.ok) { setState("error"); return; }
        const data = await r.json();
        if (data?.extract && (data.extract.years?.length ?? 0) > 0) {
          setExtract(data.extract);
          setState("ready");
        } else {
          setState("empty");
        }
      } catch {
        if (active) setState("error");
      }
    })();
    return () => { active = false; };
  }, []);

  if (state === "loading") {
    return (
      <div className="rounded-lg border border-rule bg-bg-2/30 p-6 flex items-center justify-center text-ink-soft text-[12.5px]">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Checking for prior uploads…
      </div>
    );
  }
  if (state !== "ready" || !extract) return null;

  // Latest year is row[0] (newest-first ordering from the parser).
  const latest = extract.years[0];
  const prev   = extract.years[1];

  const trend = (n: number, prev?: number): { dir: "up" | "down" | "flat"; pct: number | null } => {
    if (!prev || prev === 0) return { dir: "flat", pct: null };
    const change = (n - prev) / Math.abs(prev);
    return {
      dir: change > 0.005 ? "up" : change < -0.005 ? "down" : "flat",
      pct: change * 100,
    };
  };

  const revTrend = trend(latest.cifra_afaceri, prev?.cifra_afaceri);
  const profitTrend = trend(latest.profit_net, prev?.profit_net);

  return (
    <div className="rounded-lg overflow-hidden mb-4 bg-surface border border-rule shadow-sm">
      <DataDepthBanner depth={DEPTH_PUBLIC_SUMMARY} subject={extract.company_name} />

      <div className="p-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.06em] font-semibold text-ink-soft mb-1">
              <span className="text-brand">●</span>
              Latest public-records analysis
            </div>
            <h2 className="text-[17px] font-semibold text-ink leading-tight truncate">
              {extract.company_name || "Romanian company"}
            </h2>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-[12px] text-ink-soft">
              {extract.cui && (
                <span className="inline-flex items-center gap-1"><Hash className="h-3 w-3" />CUI {extract.cui}</span>
              )}
              {extract.caen_code && (
                <span className="inline-flex items-center gap-1"><Briefcase className="h-3 w-3" />CAEN {extract.caen_code}</span>
              )}
              {extract.source_site && (
                <span className="inline-flex items-center gap-1"><Building2 className="h-3 w-3" />{extract.source_site}</span>
              )}
              <span>{extract.years.length} years extracted</span>
            </div>
          </div>
          <Link
            to={`/multi-year-history?doc=${extract.document.id}`}
            className="shrink-0 inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-ink text-paper text-[12.5px] font-medium hover:bg-ink/90 transition-colors"
          >
            See full history <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        {/* Latest-year KPI strip — every figure is auditable from the source PDF */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KPI
            label={`Revenue ${latest.year}`}
            value={fmtRon(latest.cifra_afaceri)}
            trend={revTrend}
          />
          <KPI
            label={`Net profit ${latest.year}`}
            value={fmtRon(latest.profit_net)}
            trend={profitTrend}
            isProfit
          />
          <KPI
            label="Total assets"
            value={fmtRon(latest.total_assets)}
          />
          <KPI
            label="Employees"
            value={latest.salariati != null ? latest.salariati.toLocaleString() : "—"}
          />
        </div>
      </div>
    </div>
  );
}

interface KPIProps {
  label: string;
  value: string;
  trend?: { dir: "up" | "down" | "flat"; pct: number | null };
  isProfit?: boolean;
}
function KPI({ label, value, trend, isProfit }: KPIProps) {
  const trendColor =
    !trend || trend.dir === "flat" ? "hsl(var(--ink-mute))" :
    // For profit: up = green; for other metrics: up = neutral / context-dependent
    isProfit && trend.dir === "down" ? "hsl(var(--alert))" :
    trend.dir === "up" ? "hsl(var(--success))" : "hsl(var(--alert))";
  const TrendIcon = trend?.dir === "up" ? TrendingUp : trend?.dir === "down" ? TrendingDown : null;
  return (
    <div className="rounded-lg border border-rule bg-bg-2/30 p-3">
      <div className="text-[10.5px] uppercase tracking-[0.06em] text-ink-soft">{label}</div>
      <div className="text-[20px] font-semibold text-ink mt-0.5 tabular-nums">{value}</div>
      {TrendIcon && trend?.pct != null && (
        <div className="flex items-center gap-1 mt-0.5 text-[11px]" style={{ color: trendColor }}>
          <TrendIcon className="h-3 w-3" />
          {Math.abs(trend.pct).toFixed(1)}% YoY
        </div>
      )}
    </div>
  );
}

function fmtRon(n: number): string {
  if (n == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)} B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)} K`;
  return n.toLocaleString();
}
