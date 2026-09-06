// pciData — shared derivation logic for the Public Company Intelligence
// redesign (2026-08-04). Everything here is computed from data the page
// ALREADY loads (universe snapshots, the demo watchlist, the user's
// benchmark-peer store, the active period's statements) — no new
// endpoints, nothing modeled or invented.

import { useQuery } from "@tanstack/react-query";
import type { PublicCompanyFinancialSnapshot } from "@/lib/publicCompanyUniverse";
import type { WatchlistRow } from "@/lib/publicCompanyWatchlist";
import type { PeerEntry } from "@/lib/benchmarkPeersStore";
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
//
// GLOBAL PUBLIC MARKETS (2026-08-30) — a third builtin group: "Your
// peers", every company the user explicitly added, from ANY market.
//
// It exists because the two original groups could not hold one: "Peers
// BVB" only admitted rows the (Romania-only) universe could resolve, so
// a peer added from the US tab was silently dropped — added, stored, and
// invisible. "Global" is the DEMO watchlist, whose AAPL row carries
// illustrative figures; routing a real SEC-sourced peer there would have
// put it beside a same-ticker row of invented numbers.
//
// A GROUP IS NOT A POPULATION. This group deliberately spans markets;
// BenchmarkingPanel then runs `partitionByKey` over it, so the Romanian
// peers and the US peers are two cohorts with two medians and two
// accounting standards. That split is the point, not a side effect.

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
    currency: r.currency || "RON",
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
    net_margin_pct: r.netMargin ?? NaN,
    debt_to_equity: r.debtToEquity ?? NaN,
    fiscal_label: r.latestPeriod ?? null,
    // A row with no data timestamp has none to pass on; "" keeps the
    // watchlist shape and `fiscalLabelFromIso("")` refuses ("—").
    last_updated_iso: r.lastUpdated ?? "",
    status: r.mode === "live" ? "fresh" : "demo",
  };
}

/** A peer the loaded universe cannot resolve, rendered from what its own
 *  document gave at add time. Every metric the entry does not carry is
 *  NaN — the statistic drops non-finite values, so an absent ratio costs
 *  the peer a tile rather than filling one with a zero. */
function peerEntryToWatchlist(p: PeerEntry): WatchlistRow {
  const m = p.metrics ?? {};
  const or = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  return {
    ticker: p.ticker,
    name: p.name,
    sector: p.sector ?? "—",
    industry: "—",
    exchange: p.exchange ?? "",
    currency: p.currency,
    market_id: p.marketId ?? null,
    accounting_standard: p.accountingStandard ?? null,
    fiscal_label: p.fiscalLabel ?? null,
    // Market-cap and revenue are MONEY and this row is only ever used for
    // unitless ratio statistics, so they are left absent rather than
    // carried in a currency the panel would have to convert.
    market_cap_usd: NaN,
    revenue_usd: NaN,
    ebitda_margin_pct: or(m.ebitda_margin_pct),
    net_debt_to_ebitda: or(m.net_debt_to_ebitda),
    pe_ratio: NaN,
    ev_ebitda: or(m.ev_ebitda),
    fcf_yield_pct: or(m.fcf_yield_pct),
    dividend_yield_pct: or(m.dividend_yield_pct),
    revenue_growth_pct: or(m.revenue_growth_pct),
    net_margin_pct: or(m.net_margin_pct),
    debt_to_equity: or(m.debt_to_equity),
    last_updated_iso: p.addedAt,
    status: "fresh",
  };
}

export function buildBenchGroups(
  watchlist: WatchlistRow[],
  universeRows: PublicCompanyFinancialSnapshot[],
  peers: PeerEntry[],
): BenchGroup[] {
  const byTicker = new Map(universeRows.map((r) => [r.ticker, r] as const));

  const bvbRows = new Map<string, WatchlistRow>();
  for (const w of watchlist) {
    if (w.exchange === "BVB") bvbRows.set(w.ticker, w);
  }
  // The user's Romanian peers join the BVB group with metrics read from
  // the loaded universe snapshot (only metrics the snapshot actually
  // has). A peer from any other market is NOT admitted here — that is
  // the blend PM7 forbids, and it is why the "Your peers" group exists.
  for (const p of peers) {
    if (bvbRows.has(p.ticker)) continue;
    const u = byTicker.get(p.ticker);
    if (u && u.exchange === "BVB") bvbRows.set(p.ticker, universeRowToWatchlist(u));
  }

  const globalRows = watchlist.filter((w) => w.exchange !== "BVB");

  // "Your peers" — every explicitly added company, whatever its market.
  // Romanian peers resolve against the loaded universe (real snapshot
  // metrics); everything else renders from the figures its own document
  // carried at add time.
  const peerRows: WatchlistRow[] = peers.map((p) => {
    const u = byTicker.get(p.ticker);
    if (u && (!p.marketId || p.marketId === "ro")) {
      const row = universeRowToWatchlist(u);
      return { ...row, market_id: p.marketId ?? row.market_id ?? null };
    }
    return peerEntryToWatchlist(p);
  });

  const groups: BenchGroup[] = [
    { key: "bvb", labelKey: "pci.bench.groupBvb", rows: [...bvbRows.values()] },
    { key: "global", labelKey: "pci.bench.groupGlobal", rows: globalRows },
  ];
  // Placed FIRST when it exists: the companies the user chose outrank the
  // shipped demo sets in a chip row they have to read left to right.
  if (peerRows.length > 0) {
    groups.unshift({ key: "peers", labelKey: "pci.bench.groupPeers", rows: peerRows });
  }

  // Sector subgroups (cheap): any sector with ≥3 members inside a parent
  // group gets its own chip, labeled "<parent> · <sector>". The parent
  // name is looked up, not inferred from `key !== "bvb"` — that ternary
  // silently labelled every non-BVB parent "Global", which was harmless
  // while there were exactly two parents and wrong the moment a third
  // ("Your peers") appeared.
  const PARENT_LABEL: Readonly<Record<string, string>> = {
    bvb: "BVB",
    global: "Global",
    peers: "Peers",
  };
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
          label: `${PARENT_LABEL[parent.key] ?? parent.key} · ${sector}`,
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
  // A peer from outside the home market has NO other group that can show
  // it — "Peers BVB" refuses it by construction and "Global" is the demo
  // set. Landing on any other chip would leave the user staring at a
  // panel that does not contain the company they just added, which reads
  // exactly like the peer having been dropped.
  const peerGroup = groups.find((g) => g.key === "peers");
  if (peerGroup?.rows.some((r) => !!r.market_id && r.market_id !== "ro")) {
    return peerGroup.key;
  }
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
