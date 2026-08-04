// pciData — shared derivation logic for the Public Company Intelligence
// redesign (2026-08-04). Everything here is computed from data the page
// ALREADY loads (universe snapshots, the demo watchlist, the user's
// benchmark-peer store, the active period's statements) — no new
// endpoints, nothing modeled or invented.

import { useQuery } from "@tanstack/react-query";
import type { PublicCompanyFinancialSnapshot } from "@/lib/publicCompanyUniverse";
import type { WatchlistRow } from "@/lib/publicCompanyWatchlist";
import { fetchPriceHistory } from "@/lib/publicCompanyPriceHistory";
import { deriveTotals } from "@/lib/financialReport";
import type { Statements } from "@/lib/financialReport";
import type { SeriesDatum } from "@/lib/learning/multiPeriodSeries";

// ── Workspace industry → BVB universe sector ─────────────────────────────
// The org's `industry_display_name` (read via useActivePeriod().industry —
// the same source the dashboard briefing uses) is a free-ish display
// string ("Food & FMCG", "food manufacturing", …). The universe rows use
// the 12 UNIVERSE_SECTORS labels. Keyword mapping, lowercase matching —
// deliberately generous so a workspace always lands somewhere sensible,
// null when nothing matches (the peer rail then hides).

const SECTOR_KEYWORDS: ReadonlyArray<[RegExp, string]> = [
  [/food|fmcg|bever|agri|meat|dairy|bak/i, "Consumer Defensive"],
  [/retail|distribu|commerce|consumer/i, "Consumer Discretionary"],
  [/real\s*estate|imobil|property/i, "Real Estate"],
  [/construc|material|cement|steel|chem/i, "Materials"],
  [/it\b|software|tech|media|telecom/i, "Technology"],
  [/energy|oil|gas|petro/i, "Energy"],
  [/util|electric|power|water/i, "Utilities"],
  [/health|pharma|medic/i, "Healthcare"],
  [/logist|transport|manufactur|industr|machin|auto/i, "Industrials"],
  [/financ|bank|insur|invest/i, "Financials"],
  [/hospital|hotel|touris/i, "Consumer Discretionary"],
];

export function workspaceIndustryToSector(industry: string | null | undefined): string | null {
  if (!industry) return null;
  for (const [re, sector] of SECTOR_KEYWORDS) {
    if (re.test(industry)) return sector;
  }
  return null;
}

// ── Data completeness ("data pending") ───────────────────────────────────
// A card renders as PENDING (skeleton + "În curs de procesare" chip) when
// the snapshot carries no statutory P&L at all. Live price/day-change (if
// present) stays visible on pending cards.

export function isPendingRow(r: PublicCompanyFinancialSnapshot): boolean {
  return r.revenue == null && r.netIncome == null && r.ebitda == null;
}

// ── Standout metric per card ─────────────────────────────────────────────
// For each company, its single best claim-to-fame WITHIN THE VISIBLE GROUP
// (the currently filtered subset): the metric where the company ranks
// best. A chip renders only for group leaders (rank ≤ 3) so it stays a
// signal, not noise. Direction rules:
//   · ebitdaMargin / netMargin / dividendYield / roe — higher is better
//   · evToEbitda / peRatio — lower is better, only positive values count
//     (a negative multiple means negative earnings, not cheapness).

export type StandoutKey =
  | "ebitdaMargin"
  | "netMargin"
  | "dividendYield"
  | "roe"
  | "evToEbitda"
  | "peRatio";

interface StandoutDef {
  key: StandoutKey;
  goodHigh: boolean;
  /** Positive-only filter (valuation multiples). */
  positiveOnly?: boolean;
}

const STANDOUT_DEFS: ReadonlyArray<StandoutDef> = [
  { key: "ebitdaMargin", goodHigh: true },
  { key: "dividendYield", goodHigh: true },
  { key: "netMargin", goodHigh: true },
  { key: "roe", goodHigh: true },
  { key: "evToEbitda", goodHigh: false, positiveOnly: true },
  { key: "peRatio", goodHigh: false, positiveOnly: true },
];

export interface Standout {
  key: StandoutKey;
  value: number;
  rank: number; // 1 = best in group
  n: number;    // group size for this metric
}

/** Rank threshold for showing the chip — leaders only. */
const STANDOUT_MAX_RANK = 3;
/** A metric needs at least this many finite values to rank meaningfully. */
const STANDOUT_MIN_N = 3;

export function computeStandouts(
  rows: PublicCompanyFinancialSnapshot[],
): Map<string, Standout> {
  const out = new Map<string, Standout>();
  // Per metric: sorted list of [ticker, value] best-first.
  const perMetric = new Map<StandoutKey, Array<[string, number]>>();
  for (const def of STANDOUT_DEFS) {
    const vals: Array<[string, number]> = [];
    for (const r of rows) {
      const v = r[def.key];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (def.positiveOnly && v <= 0) continue;
      vals.push([r.ticker, v]);
    }
    if (vals.length < STANDOUT_MIN_N) continue;
    vals.sort((a, b) => (def.goodHigh ? b[1] - a[1] : a[1] - b[1]));
    perMetric.set(def.key, vals);
  }
  for (const r of rows) {
    let best: Standout | null = null;
    for (const def of STANDOUT_DEFS) {
      const vals = perMetric.get(def.key);
      if (!vals) continue;
      const idx = vals.findIndex(([t]) => t === r.ticker);
      if (idx < 0) continue;
      const cand: Standout = {
        key: def.key,
        value: vals[idx][1],
        rank: idx + 1,
        n: vals.length,
      };
      // Prefer the metric with the better (lower) rank fraction.
      if (!best || cand.rank / cand.n < best.rank / best.n) best = cand;
    }
    if (best && best.rank <= STANDOUT_MAX_RANK) out.set(r.ticker, best);
  }
  return out;
}

// ── 30-day price sparkline (existing price-history endpoint, 1M range) ───
// One cached query per ticker; cards on the current page trigger it
// lazily. Errors degrade to "no sparkline" — never a broken card.

export function useCardSparkline(ticker: string, enabled: boolean) {
  return useQuery({
    queryKey: ["pci-spark", ticker],
    queryFn: async (): Promise<SeriesDatum[]> => {
      const payload = await fetchPriceHistory(ticker, "1M");
      return payload.points
        .slice(-30)
        .map((p) => ({ label: p.date, value: p.close }));
    },
    enabled,
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

// ── Benchmark groups ─────────────────────────────────────────────────────
// The watchlist is split by LISTING — "Peers BVB" (exchange === "BVB",
// augmented with the user's own added peers resolved against the loaded
// universe) vs "Global" (everything else). Sector subgroups materialize
// automatically once a group's sector has ≥3 members. Stats downstream
// are computed strictly per group — never across groups.

export interface BenchGroup {
  key: string;
  /** i18n key when builtin ("pci.bench.groupBvb" / "pci.bench.groupGlobal"),
   *  literal label for sector subgroups. */
  labelKey?: string;
  label?: string;
  rows: WatchlistRow[];
}

function universeRowToWatchlist(r: PublicCompanyFinancialSnapshot): WatchlistRow {
  return {
    ticker: r.ticker,
    name: r.companyName,
    sector: r.sector ?? "—",
    industry: r.industry ?? "—",
    exchange: r.exchange ?? "BVB",
    currency: (r.currency === "RON" ? "RON" : "USD"),
    country: r.country ?? undefined,
    market_cap_usd: r.marketCap ?? NaN,
    revenue_usd: r.revenue ?? NaN,
    ebitda_margin_pct: r.ebitdaMargin ?? NaN,
    net_debt_to_ebitda: r.netDebtToEbitda ?? NaN,
    pe_ratio: r.peRatio ?? NaN,
    ev_ebitda: r.evToEbitda ?? NaN,
    fcf_yield_pct: r.fcfYield ?? NaN,
    dividend_yield_pct: r.dividendYield ?? NaN,
    revenue_growth_pct: r.revenueGrowth ?? NaN,
    last_updated_iso: r.lastUpdated,
    status: r.mode === "live" ? "fresh" : "demo",
  };
}

export function buildBenchGroups(
  watchlist: WatchlistRow[],
  universeRows: PublicCompanyFinancialSnapshot[],
  peerTickers: string[],
): BenchGroup[] {
  const byTicker = new Map(universeRows.map((r) => [r.ticker, r] as const));

  const bvbRows = new Map<string, WatchlistRow>();
  for (const w of watchlist) {
    if (w.exchange === "BVB") bvbRows.set(w.ticker, w);
  }
  // The user's added peers join the BVB group with metrics read from the
  // loaded universe snapshot (only metrics the snapshot actually has).
  for (const t of peerTickers) {
    if (bvbRows.has(t)) continue;
    const u = byTicker.get(t);
    if (u && u.exchange === "BVB") bvbRows.set(t, universeRowToWatchlist(u));
  }

  const globalRows = watchlist.filter((w) => w.exchange !== "BVB");

  const groups: BenchGroup[] = [
    { key: "bvb", labelKey: "pci.bench.groupBvb", rows: [...bvbRows.values()] },
    { key: "global", labelKey: "pci.bench.groupGlobal", rows: globalRows },
  ];

  // Sector subgroups (cheap): any sector with ≥3 members inside a parent
  // group gets its own chip, labeled "<parent> · <sector>".
  for (const parent of [...groups]) {
    const bySector = new Map<string, WatchlistRow[]>();
    for (const r of parent.rows) {
      const s = r.sector || "—";
      if (!bySector.has(s)) bySector.set(s, []);
      bySector.get(s)!.push(r);
    }
    for (const [sector, rows] of bySector) {
      if (rows.length >= 3 && rows.length < parent.rows.length) {
        groups.push({
          key: `${parent.key}-${sector.toLowerCase().replace(/\s+/g, "-")}`,
          label: `${parent.key === "bvb" ? "BVB" : "Global"} · ${sector}`,
          rows,
        });
      }
    }
  }
  return groups.filter((g) => g.rows.length > 0);
}

/** Default group: the sector subgroup matching the workspace's industry
 *  when one exists, otherwise the BVB group. */
export function defaultBenchGroupKey(
  groups: BenchGroup[],
  workspaceSector: string | null,
): string {
  if (workspaceSector) {
    const match = groups.find(
      (g) => g.key.startsWith("bvb-") && g.label?.endsWith(workspaceSector),
    );
    if (match) return match.key;
  }
  return groups.find((g) => g.key === "bvb")?.key ?? groups[0]?.key ?? "bvb";
}

// ── Workspace ("Compania ta") metrics for overlay / compare ──────────────
// Derived from the loaded period's statements with the SAME deriveTotals
// the statements/benchmark pages use. Only metrics the statements can
// honestly produce; market-linked metrics (P/E, EV/EBITDA, dividend
// yield, FCF yield) stay null — a private company has no market price.

export interface WorkspaceBenchMetrics {
  name: string;
  revenue: number;
  ebitda_margin_pct: number | null;
  net_margin_pct: number | null;
  net_debt_to_ebitda: number | null;
  debt_to_equity: number | null;
  revenue_growth_pct: number | null;
}

export function workspaceBenchMetrics(
  statements: Statements | null | undefined,
  workspaceName?: string | null,
): WorkspaceBenchMetrics | null {
  if (!statements) return null;
  const t = deriveTotals(statements);
  const rev = statements.incomeStatement.revenue;
  if (!Number.isFinite(rev) || rev === 0) return null;
  const priorRev = statements.prior?.incomeStatement.revenue;
  return {
    name: workspaceName || statements.companyName,
    revenue: rev,
    ebitda_margin_pct: Number.isFinite(t.ebitda) ? (t.ebitda / rev) * 100 : null,
    net_margin_pct: Number.isFinite(t.netIncome) ? (t.netIncome / rev) * 100 : null,
    net_debt_to_ebitda:
      Number.isFinite(t.netDebt) && Number.isFinite(t.ebitda) && t.ebitda > 0
        ? t.netDebt / t.ebitda
        : null,
    debt_to_equity:
      Number.isFinite(t.totalDebt) && Number.isFinite(t.totalEquity) && t.totalEquity > 0
        ? t.totalDebt / t.totalEquity
        : null,
    revenue_growth_pct:
      typeof priorRev === "number" && Number.isFinite(priorRev) && priorRev > 0
        ? ((rev - priorRev) / priorRev) * 100
        : null,
  };
}

// ── Formatting (native currency, tabular) ────────────────────────────────

export function fmtCompactMoney(
  value: number | null | undefined,
  currency: string,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const cur = currency || "RON";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${cur} ${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${cur} ${(value / 1e6).toFixed(0)}M`;
  if (abs >= 1e3) return `${cur} ${(value / 1e3).toFixed(0)}K`;
  return `${cur} ${value.toFixed(0)}`;
}

export function fmtPrice(
  value: number | null | undefined,
  currency: string,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export function fmtSignedPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function fmtPct1(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

export function fmtX(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}×`;
}

export function fmtStandoutValue(key: StandoutKey, value: number): string {
  switch (key) {
    case "evToEbitda":
    case "peRatio":
      return fmtX(value);
    default:
      return fmtPct1(value);
  }
}
