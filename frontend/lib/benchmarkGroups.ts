// benchmarkGroups.ts — THE GROUPING LAW for every benchmark percentile.
//
// Part D of the GLOBAL PUBLIC MARKETS wave. Two jobs, both about honesty:
//
// ── 1. PM2 by construction, not by convention ────────────────────────────
// A percentile is a claim about a POPULATION. The population is only real
// when its members are comparable, and comparability here has exactly
// three axes:
//
//     market group  ×  native currency  ×  accounting standard
//
// A US_GAAP filer and an IFRS filer capitalise leases, revenue and
// goodwill differently — their EBITDA margins are not the same
// measurement, so a median across them is not a median, it is an average
// of two rulers. Same for BVB next to global names (the 2026-08-04 fix
// that started this panel), and same again for CAS. So this module does
// not *ask* callers to keep cohorts clean: `computeBenchmarkStats` THROWS
// on a heterogeneous sample. Callers partition first (`partitionByKey`)
// and can therefore never accidentally blend.
//
// ── 2. FX never touches a percentile ─────────────────────────────────────
// Percentiles are computed on NATIVE values, always. Display FX exists —
// the currency toggle is real and money figures convert — but a converted
// value entering a distribution would silently re-rank the population
// every time today's BNR rate moved, and a "P75" that changes because the
// leu moved is not a fact about companies. Any member carrying an FX
// marker is refused with code `CONVERTED_VALUE`. Conversion is a DISPLAY
// step, applied after the statistic, and it must carry its rate + date
// (see `describeDisplayFx`).
//
// ── 3. Small-n honesty ───────────────────────────────────────────────────
// The live defect this lane fixes: the panel happily printed
// "Median / P25 / P75" for a group of TWO companies, interpolating a
// quartile between two points as if it were a distribution — and named a
// "Leader" and a "Laggard" when there were only two names to be. With
// n=1 it printed the same company as both. `computeBenchmarkStats`
// returns a discriminated union instead, and n<3 is a first-class,
// nameable state rather than a number nobody should trust.
//
// The market facts below mirror `src/engine/public_market/markets.yaml`
// (the engine's single market registry). This is the DISPLAY-side copy —
// it never produces a figure, only decides which figures may sit in one
// distribution.

// ── Axes ─────────────────────────────────────────────────────────────────

/** Accounting standard, spelled exactly as `markets.yaml` spells it. */
export type AccountingStandard =
  | "RAS/IFRS"
  | "US_GAAP"
  | "IFRS"
  | "CAS_IFRS"
  | "UNKNOWN";

/** Market group id — mirrors `markets.yaml` market_id, plus `unknown` for
 *  a venue this build has never heard of. An unrecognised exchange gets
 *  its OWN cohort; it is never folded into a known one. ABSENT != ZERO. */
export type MarketGroupId =
  | "ro"
  | "us"
  | "de"
  | "uk"
  | "fr"
  | "it"
  | "es"
  | "cn"
  | "ae"
  | "unknown";

interface MarketFacts {
  id: MarketGroupId;
  /** Short label for a cohort chip. */
  label: string;
  accountingStandard: AccountingStandard;
  /** Registry default currency — used only when a member does not declare
   *  its own. The member's own declaration always wins. */
  defaultCurrency: string;
  /** RO is its own group and always leads; marquee 1..8; rest Infinity. */
  marqueeRank: number;
  /** True for the deterministic home market (served by public_ro). */
  isHome: boolean;
}

const MARKETS: readonly MarketFacts[] = [
  { id: "ro", label: "BVB", accountingStandard: "RAS/IFRS", defaultCurrency: "RON", marqueeRank: 0, isHome: true },
  { id: "us", label: "US", accountingStandard: "US_GAAP", defaultCurrency: "USD", marqueeRank: 1, isHome: false },
  { id: "de", label: "Germany", accountingStandard: "IFRS", defaultCurrency: "EUR", marqueeRank: 2, isHome: false },
  { id: "uk", label: "UK", accountingStandard: "IFRS", defaultCurrency: "GBP", marqueeRank: 3, isHome: false },
  { id: "fr", label: "France", accountingStandard: "IFRS", defaultCurrency: "EUR", marqueeRank: 4, isHome: false },
  { id: "it", label: "Italy", accountingStandard: "IFRS", defaultCurrency: "EUR", marqueeRank: 5, isHome: false },
  { id: "es", label: "Spain", accountingStandard: "IFRS", defaultCurrency: "EUR", marqueeRank: 6, isHome: false },
  { id: "cn", label: "China", accountingStandard: "CAS_IFRS", defaultCurrency: "CNY", marqueeRank: 7, isHome: false },
  { id: "ae", label: "UAE", accountingStandard: "IFRS", defaultCurrency: "AED", marqueeRank: 8, isHome: false },
  { id: "unknown", label: "Unclassified", accountingStandard: "UNKNOWN", defaultCurrency: "", marqueeRank: Number.POSITIVE_INFINITY, isHome: false },
];

const MARKET_BY_ID = new Map<MarketGroupId, MarketFacts>(MARKETS.map((m) => [m.id, m]));

/** Exchange code (as the snapshot spells it) → market group. */
const EXCHANGE_TO_MARKET: Readonly<Record<string, MarketGroupId>> = {
  BVB: "ro",
  NYSE: "us",
  NASDAQ: "us",
  AMEX: "us",
  NYSEARCA: "us",
  XETRA: "de",
  FSE: "de",
  LSE: "uk",
  "EURONEXT PARIS": "fr",
  EPA: "fr",
  "BORSA ITALIANA": "it",
  BIT: "it",
  BME: "es",
  BMAD: "es",
  SSE: "cn",
  SZSE: "cn",
  HKEX: "cn",
  DFM: "ae",
  ADX: "ae",
};

export function marketGroupOfExchange(exchange: string | null | undefined): MarketGroupId {
  if (!exchange) return "unknown";
  return EXCHANGE_TO_MARKET[exchange.trim().toUpperCase()] ?? "unknown";
}

export function marketFacts(id: MarketGroupId): MarketFacts {
  return MARKET_BY_ID.get(id) ?? MARKET_BY_ID.get("unknown")!;
}

// ── The key ──────────────────────────────────────────────────────────────

export interface BenchmarkKey {
  marketGroup: MarketGroupId;
  /** NATIVE currency of the members' figures. Never a display currency. */
  currency: string;
  accountingStandard: AccountingStandard;
}

/** Stable id — the cohort's identity in React keys, test names and logs. */
export function benchmarkKeyId(key: BenchmarkKey): string {
  return `${key.marketGroup}|${key.currency || "?"}|${key.accountingStandard}`;
}

/** Human label: "BVB · RON · RAS/IFRS". */
export function benchmarkKeyLabel(key: BenchmarkKey): string {
  return [marketFacts(key.marketGroup).label, key.currency || "—", key.accountingStandard]
    .join(" · ");
}

// ── Members ──────────────────────────────────────────────────────────────

/** Everything the grouping law needs to place a company in a population.
 *  Deliberately value-FREE: a cohort is a property of the companies, not
 *  of the metric being asked about, so a surface partitions ONCE and then
 *  attaches each metric's values to the cohort it already trusts. */
export interface BenchmarkSubject {
  ticker: string;
  name: string;
  /** Exchange code as the snapshot spells it ("BVB", "NASDAQ", …). */
  exchange: string | null | undefined;
  /** The currency the subject's OWN figures are denominated in. */
  currency: string | null | undefined;
  /** Fiscal period label of those figures ("FY2024"). */
  fiscalLabel: string;
  /** Set by any code path that has run values through display FX. Its
   *  presence is fatal to a percentile — see `assertNativeSample`. */
  fxConverted?: boolean;
  /** Display currency a converted value was converted INTO. Also fatal. */
  displayCurrency?: string;
}

/** A subject with the metric value attached, in NATIVE units. */
export interface BenchmarkMember extends BenchmarkSubject {
  value: number;
}

export function benchmarkKeyOf(member: BenchmarkSubject): BenchmarkKey {
  const group = marketGroupOfExchange(member.exchange);
  const declared = (member.currency ?? "").trim().toUpperCase();
  return {
    marketGroup: group,
    // The member's own declaration wins; the registry default is only a
    // fallback for a row that never said. An empty currency stays empty
    // rather than borrowing one — an unstated unit is not a known unit.
    currency: declared || marketFacts(group).defaultCurrency,
    accountingStandard: marketFacts(group).accountingStandard,
  };
}

// ── The refusal ──────────────────────────────────────────────────────────

export type BenchmarkIntegrityCode =
  | "MIXED_MARKET_GROUP"
  | "MIXED_CURRENCY"
  | "MIXED_ACCOUNTING_STANDARD"
  | "CONVERTED_VALUE";

/** Thrown, never returned — a blended percentile must not be renderable.
 *  Callers partition with `partitionByKey` first; nothing in the product
 *  is expected to catch this. */
export class BenchmarkIntegrityError extends Error {
  readonly code: BenchmarkIntegrityCode;
  readonly detail: string;
  constructor(code: BenchmarkIntegrityCode, detail: string) {
    super(`[${code}] ${detail}`);
    this.name = "BenchmarkIntegrityError";
    this.code = code;
    this.detail = detail;
  }
}

/** Refuse any sample whose values have been through display FX.
 *  Exported so a caller can assert it at its own boundary too. */
export function assertNativeSample(members: readonly BenchmarkSubject[]): void {
  for (const m of members) {
    if (m.fxConverted || m.displayCurrency) {
      throw new BenchmarkIntegrityError(
        "CONVERTED_VALUE",
        `${m.ticker} carries an FX-converted value` +
          (m.displayCurrency ? ` (displayed in ${m.displayCurrency})` : "") +
          ". Percentiles are computed on native values only.",
      );
    }
  }
}

/** THE grouping gate. Returns the single key every member shares, or
 *  throws naming the axis that was mixed. Empty input returns null. */
export function assertHomogeneous(
  members: readonly BenchmarkSubject[],
): BenchmarkKey | null {
  assertNativeSample(members);
  if (members.length === 0) return null;
  const first = benchmarkKeyOf(members[0]!);
  for (let i = 1; i < members.length; i += 1) {
    const k = benchmarkKeyOf(members[i]!);
    if (k.marketGroup !== first.marketGroup) {
      throw new BenchmarkIntegrityError(
        "MIXED_MARKET_GROUP",
        `${members[0]!.ticker} is ${first.marketGroup}, ${members[i]!.ticker} is ${k.marketGroup}`,
      );
    }
    if (k.currency !== first.currency) {
      throw new BenchmarkIntegrityError(
        "MIXED_CURRENCY",
        `${members[0]!.ticker} reports in ${first.currency || "?"}, ${members[i]!.ticker} in ${k.currency || "?"}`,
      );
    }
    if (k.accountingStandard !== first.accountingStandard) {
      throw new BenchmarkIntegrityError(
        "MIXED_ACCOUNTING_STANDARD",
        `${members[0]!.ticker} files ${first.accountingStandard}, ${members[i]!.ticker} files ${k.accountingStandard}`,
      );
    }
  }
  return first;
}

// ── Partitioning (what callers use before asking for a statistic) ─────────

export interface BenchmarkCohort<T extends BenchmarkSubject = BenchmarkMember> {
  id: string;
  key: BenchmarkKey;
  label: string;
  members: T[];
}

/** Canonical cohort order: Romania (its own group) first, then the
 *  marquee — US, DE, UK, FR, IT, ES, CN, AE — then everything else A→Z,
 *  with unclassified last. Ties broken by currency then standard so the
 *  order is total and stable. */
function cohortRank(key: BenchmarkKey): [number, string, string, string] {
  const f = marketFacts(key.marketGroup);
  return [f.marqueeRank, f.label, key.currency, key.accountingStandard];
}

function compareCohorts(
  a: BenchmarkCohort<BenchmarkSubject>,
  b: BenchmarkCohort<BenchmarkSubject>,
): number {
  const [ar, al, ac, as_] = cohortRank(a.key);
  const [br, bl, bc, bs] = cohortRank(b.key);
  if (ar !== br) return ar - br;
  if (al !== bl) return al.localeCompare(bl);
  if (ac !== bc) return ac.localeCompare(bc);
  return as_.localeCompare(bs);
}

/** Split a mixed list into comparable cohorts. This is the ONLY sanctioned
 *  way to get from "some companies" to "a population". */
export function partitionByKey<T extends BenchmarkSubject>(
  members: readonly T[],
): Array<BenchmarkCohort<T>> {
  assertNativeSample(members);
  const byId = new Map<string, BenchmarkCohort<T>>();
  for (const m of members) {
    const key = benchmarkKeyOf(m);
    const id = benchmarkKeyId(key);
    let cohort = byId.get(id);
    if (!cohort) {
      cohort = { id, key, label: benchmarkKeyLabel(key), members: [] };
      byId.set(id, cohort);
    }
    cohort.members.push(m);
  }
  return [...byId.values()].sort(compareCohorts);
}

// ── Fiscal alignment ─────────────────────────────────────────────────────

export interface FiscalAlignment {
  /** True when every member reports the same fiscal label. */
  aligned: boolean;
  /** Distinct labels, newest first. */
  labels: string[];
  /** "FY2024" when aligned, "FY2024 vs FY2023" when not. Never silent. */
  label: string;
}

export function fiscalAlignment(members: readonly BenchmarkSubject[]): FiscalAlignment {
  const labels = [...new Set(members.map((m) => m.fiscalLabel).filter(Boolean))].sort(
    (a, b) => b.localeCompare(a),
  );
  return {
    aligned: labels.length <= 1,
    labels,
    label: labels.length === 0 ? "—" : labels.join(" vs "),
  };
}

// ── The statistic ────────────────────────────────────────────────────────

export interface RankedMember {
  ticker: string;
  name: string;
  value: number;
}

interface StatsBase {
  key: BenchmarkKey;
  n: number;
  fiscal: FiscalAlignment;
  /** Every member of the sample, best-first by the metric's direction.
   *  Present in every state — a refusal still shows who was in the room. */
  members: RankedMember[];
}

export type BenchmarkStats =
  /** Nothing to say. No member carried a finite value. */
  | { kind: "empty"; key: BenchmarkKey | null; n: 0; fiscal: FiscalAlignment; members: [] }
  /** Exactly one comparable — "Only comparable: X". No median, no spread. */
  | (StatsBase & { kind: "single_comparable"; only: RankedMember })
  /** n = 2. A quartile between two points is interpolation, not a
   *  distribution. Show the raw members instead. */
  | (StatsBase & { kind: "too_few"; minimumN: number })
  /** n >= 3 but every value identical. Print the value ONCE — a P25 and a
   *  P75 equal to the median is fake spread. */
  | (StatsBase & { kind: "zero_variance"; value: number })
  /** The only state that earns percentiles. */
  | (StatsBase & {
      kind: "percentiles";
      median: number;
      p25: number;
      p75: number;
      leader: RankedMember;
      laggard: RankedMember;
    });

/** Below this, percentiles are not computed. Three is the smallest sample
 *  where a median has a member of its own on each side. */
export const MIN_N_FOR_PERCENTILES = 3;

/** Linear-interpolated quantile. Module-private ON PURPOSE: every
 *  percentile in the benchmarking surface must come out of
 *  `computeBenchmarkStats`, so the grouping gate cannot be bypassed. */
function quantile(sortedAsc: readonly number[], q: number): number {
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sortedAsc[base + 1];
  if (next !== undefined) return sortedAsc[base]! + rest * (next - sortedAsc[base]!);
  return sortedAsc[base]!;
}

export interface BenchmarkStatsOptions {
  /** Direction of "good" — drives leader/laggard and the members ordering. */
  goodHigh: boolean;
}

/**
 * The one entry point to a benchmark statistic.
 *
 * Throws `BenchmarkIntegrityError` when the sample mixes market groups,
 * currencies or accounting standards, or when any value has been through
 * display FX. Callers partition with `partitionByKey` first.
 */
export function computeBenchmarkStats(
  members: readonly BenchmarkMember[],
  options: BenchmarkStatsOptions,
): BenchmarkStats {
  const key = assertHomogeneous(members); // throws on any mixed axis
  const finite = members.filter((m) => Number.isFinite(m.value));
  const fiscal = fiscalAlignment(finite);

  if (finite.length === 0) {
    return { kind: "empty", key, n: 0, fiscal, members: [] };
  }

  // Best-first. Deterministic tie-break on ticker so the ordering is a
  // total order and two renders of the same data never disagree.
  const ranked: RankedMember[] = finite
    .map((m) => ({ ticker: m.ticker, name: m.name, value: m.value }))
    .sort((a, b) =>
      a.value === b.value
        ? a.ticker.localeCompare(b.ticker)
        : options.goodHigh
        ? b.value - a.value
        : a.value - b.value,
    );

  const base: StatsBase = { key: key!, n: ranked.length, fiscal, members: ranked };

  if (ranked.length === 1) {
    return { ...base, kind: "single_comparable", only: ranked[0]! };
  }
  if (ranked.length < MIN_N_FOR_PERCENTILES) {
    return { ...base, kind: "too_few", minimumN: MIN_N_FOR_PERCENTILES };
  }

  const asc = ranked.map((r) => r.value).sort((a, b) => a - b);
  const lo = asc[0]!;
  const hi = asc[asc.length - 1]!;
  if (lo === hi) {
    return { ...base, kind: "zero_variance", value: lo };
  }

  const leader = ranked[0]!;
  const laggard = ranked[ranked.length - 1]!;
  // Defensive: with real spread these are always distinct companies. If a
  // future data path ever makes them the same row, degrade to the honest
  // single-comparable line rather than print a leader who is also the
  // laggard — the exact defect this lane exists to kill.
  if (leader.ticker === laggard.ticker) {
    return { ...base, kind: "single_comparable", only: leader };
  }

  return {
    ...base,
    kind: "percentiles",
    median: quantile(asc, 0.5),
    p25: quantile(asc, 0.25),
    p75: quantile(asc, 0.75),
    leader,
    laggard,
  };
}

/** True for the states that must NOT render a median / P25 / P75. */
export function isRefusalState(stats: BenchmarkStats): boolean {
  return stats.kind !== "percentiles";
}

// ── Display FX (never an input, only a label) ─────────────────────────────

export interface DisplayFx {
  /** Native currency of the cohort. */
  from: string;
  /** Currency the viewer has selected. */
  to: string;
  /** Units of `to` per 1 unit of `from`. */
  rate: number;
  /** ISO date the upstream published the rate. */
  asOf: string;
  /** "BNR" | "fallback". */
  source: string;
}

/** The tooltip line a converted MONEY figure must carry. Percentile
 *  figures never call this — they are computed and shown in native units.
 *  Returns null when no conversion is happening (native == display). */
export function describeDisplayFx(fx: DisplayFx | null): string | null {
  if (!fx) return null;
  if (!fx.from || !fx.to || fx.from === fx.to) return null;
  if (!Number.isFinite(fx.rate) || fx.rate <= 0) return null;
  const rate = fx.rate < 1 ? fx.rate.toFixed(4) : fx.rate.toFixed(3);
  return `1 ${fx.from} = ${rate} ${fx.to} · ${fx.source} · ${fx.asOf}`;
}

// ── Adapters ─────────────────────────────────────────────────────────────

/** Fiscal label from an ISO date — "2024-12-31" → "FY2024". Returns "—"
 *  for anything unparseable rather than guessing a year. */
export function fiscalLabelFromIso(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})/.exec(iso.trim());
  if (!m) return "—";
  return `FY${m[1]}`;
}
