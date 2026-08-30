// Benchmarking panel — peer-group percentiles for the headline metrics.
//
// 2026-08-04 (PCI redesign) — benchmark contamination fix. The old panel
// computed ONE median across the whole demo watchlist, silently blending
// BVB names (CFH, TLV) with NVDA/TSLA/PEP — a Romanian food processor
// "lagging" NVIDIA's EBITDA margin is not a finding, it's a category
// error. The watchlist is split into GROUPS by listing ("Peers BVB" vs
// "Global"), with sector subgroups at n ≥ 3 (pciData.buildBenchGroups).
//
// 2026-08-30 (GLOBAL PUBLIC MARKETS, Part D) — two things changed here,
// both about what a percentile is allowed to claim:
//
//   1. THE GROUPING LAW moved out of this file and into
//      `lib/benchmarkGroups.ts`. A group chip is a user-facing taxonomy;
//      a POPULATION is (market group × native currency × accounting
//      standard) and nothing else. Each selected group is partitioned
//      into cohorts, and every statistic comes out of
//      `computeBenchmarkStats`, which THROWS on a blended sample. The
//      panel can no longer produce a mixed median even by accident — the
//      old local `quantile()` helper is gone, so there is no second path
//      to a percentile in this surface.
//
//   2. SMALL-N HONESTY, fixing a live defect. The default group here is
//      "Peers BVB", which in the shipped watchlist is TWO companies —
//      and the panel was printing "Median 28.5% · P25 · P75" plus a
//      Leader and a Laggard for it, i.e. a quartile interpolated between
//      two points, and a ranking of two names where every member is both
//      the best and the worst of something. Now n<3 renders the raw
//      members under a named refusal, n=1 renders "only comparable: X",
//      and a zero-variance cohort prints its value once instead of three
//      identical quartiles.
//
// FX: every metric on this panel is a ratio or a percentage — unitless
// by construction — and the percentile path refuses FX-converted input
// outright (`assertNativeSample`). The cohort line therefore states the
// native currency, and when the viewer's display currency differs it
// says so, carrying the rate and its date, scoped to money figures only.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Info,
  Layers,
  Percent,
  Scale,
  TrendingUp,
  Wallet,
  X,
} from "lucide-react";
import i18n from "@/i18n";
import { DEMO_WATCHLIST, type WatchlistRow } from "@/lib/publicCompanyWatchlist";
import type { PublicCompanyFinancialSnapshot } from "@/lib/publicCompanyUniverse";
import { useBenchmarkPeers } from "@/lib/benchmarkPeersStore";
import { useCurrency } from "@/stores/currency";
import {
  MIN_N_FOR_PERCENTILES,
  benchmarkKeyLabel,
  computeBenchmarkStats,
  isRefusalState,
  describeDisplayFx,
  fiscalLabelFromIso,
  partitionByKey,
  type BenchmarkCohort,
  type BenchmarkStats,
  type BenchmarkSubject,
  type RankedMember,
} from "@/lib/benchmarkGroups";
import { Amount } from "@/components/instrument/Amount";
import { Chip as StateChip } from "@/components/instrument/Panel";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CompanyLogo } from "./CompanyLogo";
import {
  buildBenchGroups,
  defaultBenchGroupKey,
  type BenchGroup,
  type WorkspaceBenchMetrics,
} from "./pciData";
import "./pciI18n";

// ── i18n for the honesty states ──────────────────────────────────────────
// Registered here rather than in pciI18n.ts so this lane owns its own
// strings end to end. deep merge + overwrite=false, the same contract
// pciI18n uses: anything already merged from the locale files wins.

const honestyEn = {
  // F1 (critique r1): the section subtitle used to promise "median and
  // P25/P75", which the default two-company group is right to withhold.
  // The subtitle now states the law instead of the statistic.
  subtitle:
    "One population at a time — a market group, one reporting currency, one accounting standard. Percentiles need at least {{min}} comparable peers; below that the panel names the peers instead.",
  population: "Population",
  populationSplit:
    "This group spans {{n}} populations. Percentiles are computed inside one at a time — a median across accounting standards is an average of two rulers, not a median.",
  fiscalMixed: "Mixed fiscal years",
  nativeNote: "Percentiles are computed on native {{currency}} figures.",
  native: "native {{currency}}",
  fxNote:
    "Display conversion ({{fx}}) applies to money figures only — it never enters a percentile.",
  tooFew: "Not enough peers for percentiles",
  tooFewCount: "{{n}} of {{min}}",
  rule:
    "A quartile drawn between fewer than {{min}} points is interpolation, not a distribution — so the tiles below name their peers instead of computing one.",
  onlyComparable: "Only comparable: {{ticker}}",
  onlyComparableWhy: "Nothing else in this population carries this metric.",
  noSpread: "All {{n}} report the same value",
  noSpreadWhy: "No spread, so no P25/P75 and no ranking.",
  members: "Members",
  // "Your peers" — the group holding every company the user added, from
  // any market. It SPANS populations on purpose; the cohort chips below
  // it are the split.
  groupPeers: "Your peers",
  standard: "{{standard}}",
  // i18next plural suffixes — "1 of these peers are listed" was the copy
  // a single foreign peer produced, which is the common case.
  crossMarket_one:
    "One of these peers is listed outside Romania. It forms its own population below — {{standards}} are compared only with themselves.",
  crossMarket_other:
    "{{count}} of these peers are listed outside Romania. They form their own populations below — {{standards}} are compared only with themselves.",
  metric: {
    netMargin: "Net margin",
    netMarginShort: "Net margin",
    debtEquity: "Debt / equity",
    debtEquityShort: "Debt / equity",
  },
};

const honestyRo = {
  subtitle:
    "O singură populație pe rând — un grup de piață, o monedă de raportare, un standard contabil. Percentilele au nevoie de cel puțin {{min}} companii comparabile; sub acest prag, panoul enumeră companiile în loc de o mediană.",
  population: "Populație",
  populationSplit:
    "Grupul conține {{n}} populații. Percentilele se calculează în interiorul uneia singure — o mediană peste standarde contabile diferite este o medie a două rigle, nu o mediană.",
  fiscalMixed: "Ani fiscali diferiți",
  nativeNote: "Percentilele se calculează pe cifrele native în {{currency}}.",
  native: "nativ {{currency}}",
  fxNote:
    "Conversia de afișare ({{fx}}) se aplică doar sumelor — nu intră niciodată într-o percentilă.",
  tooFew: "Prea puțini peers pentru percentile",
  tooFewCount: "{{n}} din {{min}}",
  rule:
    "O cuartilă trasată între mai puțin de {{min}} puncte este interpolare, nu o distribuție — de aceea cardurile de mai jos enumeră companiile în loc să calculeze una.",
  onlyComparable: "Singura companie comparabilă: {{ticker}}",
  onlyComparableWhy: "Nimic altceva din această populație nu are acest indicator.",
  noSpread: "Toate cele {{n}} raportează aceeași valoare",
  noSpreadWhy: "Nicio dispersie, deci fără P25/P75 și fără clasament.",
  members: "Companii",
  groupPeers: "Peers-ii tăi",
  standard: "{{standard}}",
  crossMarket_one:
    "Unul dintre acești peers este listat în afara României. Formează propria populație mai jos — {{standards}} se compară doar cu ele însele.",
  crossMarket_few:
    "{{count}} dintre acești peers sunt listați în afara României. Ei formează populații separate mai jos — {{standards}} se compară doar cu ele însele.",
  crossMarket_other:
    "{{count}} de peers sunt listați în afara României. Ei formează populații separate mai jos — {{standards}} se compară doar cu ele însele.",
  metric: {
    netMargin: "Marjă netă",
    netMarginShort: "Marjă netă",
    debtEquity: "Datorii / capitaluri",
    debtEquityShort: "Datorii / capitaluri",
  },
};

i18n.addResourceBundle(
  "en",
  "translation",
  // groupPeers sits beside groupBvb / groupGlobal because pciData names
  // the group by that key; the honesty bundle carries it so this lane
  // owns its own strings without editing the locale files.
  { pci: { bench: { h: honestyEn, groupPeers: honestyEn.groupPeers } } },
  true,
  false,
);
i18n.addResourceBundle(
  "ro",
  "translation",
  { pci: { bench: { h: honestyRo, groupPeers: honestyRo.groupPeers } } },
  true,
  false,
);

// ── Props / metrics ──────────────────────────────────────────────────────

interface Props {
  rows?: WatchlistRow[];
  /** Loaded universe — resolves the user's added peers into metric rows. */
  universeRows?: PublicCompanyFinancialSnapshot[];
  /** "Compania ta" metrics for the drill-down overlay (null → no overlay). */
  workspace?: WorkspaceBenchMetrics | null;
  /** Universe sector matching the active workspace's industry — picks the
   *  default group. */
  workspaceSector?: string | null;
}

type MetricKey =
  | "revenue_growth_pct"
  | "ebitda_margin_pct"
  | "net_margin_pct"
  | "net_debt_to_ebitda"
  | "debt_to_equity"
  | "fcf_yield_pct"
  | "ev_ebitda"
  | "dividend_yield_pct";

interface Metric {
  key: MetricKey;
  labelKey: string;
  shortKey: string;
  icon: typeof Activity;
  /** Both are currency-NEUTRAL. No metric on this panel is money, which
   *  is why nothing here is ever eligible for display conversion. */
  unit: "pct" | "x";
  goodHigh: boolean; // affects leader/laggard + drill sort direction
  /** Reads the workspace's value for the overlay; undefined = metric is
   *  market-linked and a private company cannot have it. */
  you?: (w: WorkspaceBenchMetrics) => number | null;
}

// Two metrics (net margin, debt / equity) were added 2026-08-30 because
// they are the only ones a real filing-sourced peer can carry end to end
// today: both are a ratio of two money figures from the SAME statement,
// so a US_GAAP 10-K and a RAS/IFRS snapshot can each produce one from
// what they actually state. A tile with no finite value in the active
// cohort renders nothing at all (BenchmarkTile returns null on "empty"),
// so a group whose rows never carried them is visually unchanged.
const METRICS: Metric[] = [
  { key: "revenue_growth_pct", labelKey: "pci.bench.metric.growth", shortKey: "pci.bench.metric.growthShort", icon: TrendingUp, unit: "pct", goodHigh: true, you: (w) => w.revenue_growth_pct },
  { key: "ebitda_margin_pct", labelKey: "pci.bench.metric.ebitda", shortKey: "pci.bench.metric.ebitdaShort", icon: Percent, unit: "pct", goodHigh: true, you: (w) => w.ebitda_margin_pct },
  { key: "net_margin_pct", labelKey: "pci.bench.h.metric.netMargin", shortKey: "pci.bench.h.metric.netMarginShort", icon: Percent, unit: "pct", goodHigh: true, you: (w) => w.net_margin_pct },
  { key: "net_debt_to_ebitda", labelKey: "pci.bench.metric.leverage", shortKey: "pci.bench.metric.leverageShort", icon: Scale, unit: "x", goodHigh: false, you: (w) => w.net_debt_to_ebitda },
  { key: "debt_to_equity", labelKey: "pci.bench.h.metric.debtEquity", shortKey: "pci.bench.h.metric.debtEquityShort", icon: Scale, unit: "x", goodHigh: false, you: (w) => w.debt_to_equity },
  { key: "fcf_yield_pct", labelKey: "pci.bench.metric.fcf", shortKey: "pci.bench.metric.fcfShort", icon: Wallet, unit: "pct", goodHigh: true },
  { key: "ev_ebitda", labelKey: "pci.bench.metric.evEbitda", shortKey: "pci.bench.metric.evEbitdaShort", icon: Layers, unit: "x", goodHigh: false },
  { key: "dividend_yield_pct", labelKey: "pci.bench.metric.dividend", shortKey: "pci.bench.metric.dividendShort", icon: Activity, unit: "pct", goodHigh: true },
];

/** A cohort member that still carries the row its values come from, so a
 *  metric's sample is attached AFTER the population is settled. */
type Subject = BenchmarkSubject & { row: WatchlistRow };

function rowToSubject(r: WatchlistRow): Subject {
  return {
    ticker: r.ticker,
    name: r.name,
    exchange: r.exchange,
    // The row's own market id wins over its exchange. A peer resolved
    // from a pm1 envelope has no exchange to map (the US registry lists
    // NYSE and NASDAQ; the filing names neither), so without this the
    // cohort key would fall to "unknown" and a real US_GAAP filer would
    // sit in an "Unclassified" population instead of the US one.
    marketId: r.market_id ?? null,
    currency: r.currency,
    // A stated fiscal label (from the peer's own document, or the
    // universe's `latestPeriod`) beats one inferred from when the row was
    // last touched — `last_updated_iso` is a fetch timestamp, not a
    // period end, and a peer added today would otherwise claim FY2026.
    fiscalLabel: r.fiscal_label || fiscalLabelFromIso(r.last_updated_iso),
    row: r,
  };
}

// ── Panel ────────────────────────────────────────────────────────────────

export function BenchmarkingPanel({
  rows = DEMO_WATCHLIST,
  universeRows = [],
  workspace = null,
  workspaceSector = null,
}: Props) {
  const { t } = useTranslation();
  const peers = useBenchmarkPeers();
  const { display, rates } = useCurrency();

  const groups = useMemo(
    () => buildBenchGroups(rows, universeRows, peers),
    [rows, universeRows, peers],
  );

  const [groupKey, setGroupKey] = useState<string | null>(null);
  const activeKey =
    groupKey && groups.some((g) => g.key === groupKey)
      ? groupKey
      : defaultBenchGroupKey(groups, workspaceSector);
  const active = groups.find((g) => g.key === activeKey) ?? groups[0];

  // THE GROUPING LAW. A chip is a taxonomy; a cohort is a population.
  const cohorts = useMemo<Array<BenchmarkCohort<Subject>>>(
    () => (active ? partitionByKey(active.rows.map(rowToSubject)) : []),
    [active],
  );

  const [cohortId, setCohortId] = useState<string | null>(null);
  const cohort =
    cohorts.find((c) => c.id === cohortId) ?? cohorts[0] ?? null;

  const [drill, setDrill] = useState<MetricKey | null>(null);

  // ONE statistic per (cohort × metric), computed here and shared by the
  // tile, the panel note and the drill-down — so those three surfaces
  // cannot disagree about n, ordering or state.
  const statsByMetric = useMemo(() => {
    const out = new Map<MetricKey, BenchmarkStats>();
    if (!cohort) return out;
    for (const m of METRICS) {
      out.set(
        m.key,
        computeBenchmarkStats(
          cohort.members.map((sub) => ({ ...sub, value: sub.row[m.key] as number })),
          { goodHigh: m.goodHigh },
        ),
      );
    }
    return out;
  }, [cohort]);

  const refusing = [...statsByMetric.values()].some(
    (st) => st.kind !== "empty" && isRefusalState(st),
  );

  if (!active || !cohort) return null;

  const groupLabel = (g: BenchGroup) => (g.labelKey ? t(g.labelKey) : g.label ?? g.key);

  // Display FX is a LABEL, never an input. Rates are quoted per 1 EUR, so
  // the cohort→display rate is a ratio of the two legs.
  const nativeCurrency = cohort.key.currency;
  const fxLine =
    nativeCurrency === display
      ? null
      : describeDisplayFx({
          from: nativeCurrency,
          to: display,
          rate:
            (rates.rates[display as keyof typeof rates.rates] ?? NaN) /
            (rates.rates[nativeCurrency as keyof typeof rates.rates] ?? NaN),
          asOf: rates.as_of,
          source: rates.source,
        });

  return (
    <section data-testid="public-companies-benchmark-panel">
      <div className="mb-4">
        <h2 className="text-[13px] font-medium uppercase tracking-[0.08em] text-ink-soft">
          {t("pci.bench.title")}
        </h2>
        <p className="text-[12px] text-ink-soft mt-1 max-w-[640px]">
          {t("pci.bench.h.subtitle", { min: MIN_N_FOR_PERCENTILES })}
        </p>
      </div>

      {/* Group selector — never blended: exactly one group is active and
          every stat below reads only that group's rows. */}
      <div
        data-testid="benchmark-group-chips"
        className="
          mb-3 flex gap-1.5 overflow-x-auto pb-1 -mb-1 sm:flex-wrap sm:overflow-visible sm:pb-0
          [scrollbar-width:none] [&::-webkit-scrollbar]:hidden
        "
      >
        {groups.map((g) => (
          <button
            key={g.key}
            type="button"
            onClick={() => {
              setGroupKey(g.key);
              setCohortId(null);
              setDrill(null);
            }}
            aria-pressed={g.key === active.key}
            data-testid={`benchmark-group-${g.key}`}
            className={`
              shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-full border
              text-[11.5px] font-medium transition-colors duration-micro cursor-pointer
              ${g.key === active.key
                ? "border-brand/50 bg-brand-tint text-brand-dark dark:text-brand-light"
                : "border-rule bg-surface text-ink hover:bg-bg-2 hover:border-rule-strong"}
            `}
          >
            {groupLabel(g)}
            <span
              className={`font-mono text-[10px] tabular-nums ${
                g.key === active.key ? "" : "text-ink-soft"
              }`}
            >
              {t("pci.bench.n", { n: g.rows.length })}
            </span>
          </button>
        ))}
      </div>

      {/* When a group spans markets, say so in words BEFORE the chips.
          The chips alone read as a filter; the sentence says they are a
          partition — the peers are not being compared with each other
          across the line. */}
      {cohorts.length > 1 && (
        <p
          data-testid="benchmark-cross-market-note"
          className="mb-2 max-w-[720px] text-[11px] leading-relaxed text-ink-soft"
        >
          {t("pci.bench.h.crossMarket", {
            count: cohorts
              .filter((c) => c.key.marketGroup !== "ro")
              .reduce((n, c) => n + c.members.length, 0),
            standards: [...new Set(cohorts.map((c) => c.key.accountingStandard))].join(
              " / ",
            ),
          })}
        </p>
      )}

      {/* Cohort selector — only when the chosen group really does span
          more than one population. Silence would be the bug. */}
      {cohorts.length > 1 && (
        <div
          data-testid="benchmark-cohort-chips"
          className="mb-3 flex flex-wrap items-center gap-1.5"
        >
          {cohorts.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setCohortId(c.id);
                setDrill(null);
              }}
              aria-pressed={c.id === cohort.id}
              data-testid={`benchmark-cohort-${c.id}`}
              className={`
                inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border
                font-mono text-[10.5px] transition-colors duration-micro cursor-pointer
                ${c.id === cohort.id
                  ? "border-brand/50 bg-brand-tint text-brand-dark dark:text-brand-light"
                  : "border-rule-soft bg-bg-2 text-ink-soft hover:text-ink hover:border-rule"}
              `}
            >
              {c.label}
              <span className="tabular-nums opacity-70">
                {t("pci.bench.n", { n: c.members.length })}
              </span>
            </button>
          ))}
        </div>
      )}

      <CohortLine
        cohort={cohort}
        split={cohorts.length > 1 ? cohorts.length : 0}
        fxLine={fxLine}
      />

      {/* F2 (critique r1): the reason a percentile is withheld is stated
          ONCE here, not repeated inside all six tiles. */}
      {refusing && (
        <p
          data-testid="benchmark-rule-note"
          className="mb-3 -mt-1 text-[11px] text-ink-soft max-w-[720px]"
        >
          {t("pci.bench.h.rule", { min: MIN_N_FOR_PERCENTILES })}
        </p>
      )}

      <div className="cards-stagger grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {METRICS.map((m) => (
          <BenchmarkTile
            key={m.key}
            metric={m}
            stats={statsByMetric.get(m.key)!}
            active={drill === m.key}
            onClick={() => setDrill((cur) => (cur === m.key ? null : m.key))}
          />
        ))}
      </div>

      {drill && (
        <DrillDownPanel
          metric={METRICS.find((m) => m.key === drill)!}
          stats={statsByMetric.get(drill)!}
          groupLabel={groupLabel(active)}
          cohort={cohort}
          workspace={workspace}
          onClose={() => setDrill(null)}
        />
      )}
    </section>
  );
}

// ── Cohort provenance line ───────────────────────────────────────────────

function CohortLine({
  cohort,
  split,
  fxLine,
}: {
  cohort: BenchmarkCohort<Subject>;
  split: number;
  /** Rate + date for the tooltip ONLY. No figure on this panel is money,
   *  so nothing here is ever converted — the line exists to say so. */
  fxLine: string | null;
}) {
  const { t } = useTranslation();
  // Fiscal alignment is a property of the WHOLE cohort here (each tile
  // recomputes it over its own finite sample and can be narrower).
  const labels = [...new Set(cohort.members.map((m) => m.fiscalLabel))].sort((a, b) =>
    b.localeCompare(a),
  );
  const fiscalLabel = labels.length ? labels.join(" vs ") : "—";
  const fiscalMixed = labels.length > 1;

  return (
    <div
      data-testid="benchmark-cohort-line"
      className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-ink-soft"
    >
      <span className="uppercase tracking-[0.1em]">{t("pci.bench.h.population")}</span>
      <span className="font-mono text-ink" data-testid="benchmark-cohort-key">
        {benchmarkKeyLabel(cohort.key)}
      </span>
      <span aria-hidden>·</span>
      <span
        className={`font-mono tabular-nums ${fiscalMixed ? "text-ink" : ""}`}
        data-testid="benchmark-fiscal-label"
      >
        {fiscalLabel}
      </span>
      {fiscalMixed && (
        <StateChip tone="caution" className="text-[9.5px]">
          {t("pci.bench.h.fiscalMixed")}
        </StateChip>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t("pci.bench.h.nativeNote", { currency: cohort.key.currency })}
            className="inline-flex items-center text-ink-mute hover:text-ink transition-colors"
            data-testid="benchmark-fx-info"
          >
            <Info size={12} strokeWidth={2} />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[300px] text-[11px] leading-relaxed">
          <p>{t("pci.bench.h.nativeNote", { currency: cohort.key.currency })}</p>
          {fxLine && <p className="mt-1">{t("pci.bench.h.fxNote", { fx: fxLine })}</p>}
          {split > 0 && <p className="mt-1">{t("pci.bench.h.populationSplit", { n: split })}</p>}
        </TooltipContent>
      </Tooltip>

      {/* Only when it carries information: the viewer's display currency
          differs from the one these figures are stated in. When they
          match, the currency is already on the population line and a
          second "native RON" is noise. */}
      {fxLine && (
        <span className="font-mono text-ink-mute" data-testid="benchmark-fx-line">
          {t("pci.bench.h.native", { currency: cohort.key.currency })}
        </span>
      )}
    </div>
  );
}

// ── Metric tile ──────────────────────────────────────────────────────────

function BenchmarkTile({
  metric,
  stats,
  active,
  onClick,
}: {
  metric: Metric;
  /** Computed once by the panel from the settled cohort — the tile never
   *  assembles its own sample, so it cannot assemble a blended one. */
  stats: BenchmarkStats;
  active: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();

  if (stats.kind === "empty") return null;

  const clickable = stats.n > 0;

  return (
    <button
      type="button"
      onClick={clickable ? onClick : undefined}
      aria-pressed={active}
      data-testid={`public-companies-benchmark-${metric.key}`}
      data-state={stats.kind}
      className={`
        relative flex flex-col rounded-md border bg-surface text-left
        transition-colors duration-micro
        ${clickable ? "cursor-pointer" : "cursor-default"}
        ${active ? "border-brand/60" : "border-rule hover:border-rule-strong"}
      `}
    >
      <div className="p-4 w-full">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] uppercase tracking-[0.1em] font-medium text-ink-soft">
            {t(metric.shortKey)}
          </span>
          <span
            className="font-mono text-[10px] tabular-nums text-ink-soft"
            data-testid={`benchmark-n-${metric.key}`}
          >
            {t("pci.bench.n", { n: stats.n })}
          </span>
        </div>

        {stats.kind === "percentiles" ? (
          <div className="mt-2.5">
            <div className="text-[10.5px] text-ink-soft">{t("pci.bench.median")}</div>
            <MetricAmount
              value={stats.median}
              unit={metric.unit}
              className="text-[24px] font-medium leading-tight text-ink"
            />
            <div className="mt-1 flex items-baseline gap-1 text-[10.5px] text-ink-soft">
              P25 <MetricAmount value={stats.p25} unit={metric.unit} className="text-[10.5px]" />
              <span aria-hidden>·</span>
              P75 <MetricAmount value={stats.p75} unit={metric.unit} className="text-[10.5px]" />
            </div>
          </div>
        ) : (
          <RefusalBody metric={metric} stats={stats} />
        )}
      </div>

      {/* Bottom sleeve. Leader/laggard exist only where there is a real
          distribution to lead; otherwise the sleeve lists the raw members,
          because "who was in the room" is the honest answer at small n. */}
      {stats.kind === "percentiles" ? (
        <div className="mt-auto w-full border-t border-rule-soft bg-bg-2 px-4 py-2.5 space-y-1 rounded-b-md">
          <LeaderRow
            icon={<ArrowUp size={11} className="text-success" />}
            label={t("pci.bench.leader")}
            ticker={stats.leader.ticker}
            value={<MetricAmount value={stats.leader.value} unit={metric.unit} className="text-[11px] text-ink-soft" />}
          />
          <LeaderRow
            icon={<ArrowDown size={11} className="text-ink-soft" />}
            label={t("pci.bench.laggard")}
            ticker={stats.laggard.ticker}
            value={<MetricAmount value={stats.laggard.value} unit={metric.unit} className="text-[11px] text-ink-soft" />}
          />
        </div>
      ) : (
        <MemberSleeve metric={metric} members={stats.members} />
      )}
    </button>
  );
}

/** What a tile shows INSTEAD of a median when the sample cannot carry one.
 *  Each branch names the reason — a blank space would read as missing
 *  data rather than as a refusal. */
function RefusalBody({ metric, stats }: { metric: Metric; stats: BenchmarkStats }) {
  const { t } = useTranslation();

  if (stats.kind === "single_comparable") {
    return (
      <div className="mt-2.5" data-testid={`benchmark-refusal-${metric.key}`}>
        <div className="text-[12px] font-medium text-ink leading-snug">
          {t("pci.bench.h.onlyComparable", { ticker: stats.only.ticker })}
        </div>
        <MetricAmount
          value={stats.only.value}
          unit={metric.unit}
          className="text-[20px] font-medium leading-tight text-ink mt-1"
        />
        <div className="mt-1 text-[10.5px] text-ink-soft">
          {t("pci.bench.h.onlyComparableWhy")}
        </div>
      </div>
    );
  }

  if (stats.kind === "zero_variance") {
    return (
      <div className="mt-2.5" data-testid={`benchmark-refusal-${metric.key}`}>
        <div className="text-[12px] font-medium text-ink leading-snug">
          {t("pci.bench.h.noSpread", { n: stats.n })}
        </div>
        {/* Printed ONCE. A P25 and a P75 identical to the median would be
            three renderings of one number dressed as a range. */}
        <MetricAmount
          value={stats.value}
          unit={metric.unit}
          className="text-[20px] font-medium leading-tight text-ink mt-1"
        />
        <div className="mt-1 text-[10.5px] text-ink-soft">{t("pci.bench.h.noSpreadWhy")}</div>
      </div>
    );
  }

  if (stats.kind === "too_few") {
    // The "why" is stated once at panel level; repeating it in every tile
    // turned the grid into six identical paragraphs (critique r1, F2).
    return (
      <div className="mt-2.5" data-testid={`benchmark-refusal-${metric.key}`}>
        <div className="text-[12px] font-medium text-ink leading-snug">
          {t("pci.bench.h.tooFew")}
        </div>
        <div className="mt-1 font-mono text-[10.5px] tabular-nums text-ink-soft">
          {t("pci.bench.h.tooFewCount", { n: stats.n, min: stats.minimumN })}
        </div>
      </div>
    );
  }

  return null;
}

/** The raw members, shown wherever a statistic was refused. */
function MemberSleeve({ metric, members }: { metric: Metric; members: RankedMember[] }) {
  const { t } = useTranslation();
  if (!members.length) return null;
  return (
    <div
      className="mt-auto w-full border-t border-rule-soft bg-bg-2 px-4 py-2.5 space-y-1 rounded-b-md"
      data-testid={`benchmark-members-${metric.key}`}
    >
      <div className="text-[9.5px] uppercase tracking-[0.1em] text-ink-mute">
        {t("pci.bench.h.members")}
      </div>
      {members.map((m) => (
        <div key={m.ticker} className="flex items-center justify-between gap-2 text-[11.5px]">
          <span className="font-mono font-medium text-ink truncate">{m.ticker}</span>
          <MetricAmount value={m.value} unit={metric.unit} className="text-[11px] text-ink-soft" />
        </div>
      ))}
    </div>
  );
}

function LeaderRow({
  icon, label, ticker, value,
}: { icon: React.ReactNode; label: string; ticker: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11.5px]">
      <span className="inline-flex items-center gap-1 text-ink-soft">
        {icon} {label}
      </span>
      <span className="inline-flex items-baseline gap-1.5 text-ink">
        <span className="font-mono font-medium">{ticker}</span>
        {value}
      </span>
    </div>
  );
}

// ── Drill-down — per-company bars across the active cohort ───────────────

function DrillDownPanel({
  metric,
  stats,
  groupLabel,
  cohort,
  workspace,
  onClose,
}: {
  metric: Metric;
  stats: BenchmarkStats;
  /** The chip the user actually clicked ("Global · Technology"). The
   *  cohort key is on the population line above; repeating it here cost
   *  the sector context (critique r1, F4). */
  groupLabel: string;
  cohort: BenchmarkCohort<Subject>;
  workspace: WorkspaceBenchMetrics | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  interface Bar {
    ticker: string;
    name: string;
    value: number;
    you?: boolean;
  }

  // The same statistic the tile rendered — one sort authority, so the
  // drill-down can never disagree with the tile above it.
  const bars: Bar[] = stats.members.map((m) => ({
    ticker: m.ticker,
    name: m.name,
    value: m.value,
  }));

  const youValue = workspace && metric.you ? metric.you(workspace) : null;
  const youSupported = !!metric.you;
  if (workspace && youValue != null && Number.isFinite(youValue)) {
    // The workspace is an overlay, never a cohort member — a private
    // RAS book is not part of the listed population and must not move
    // its median. It is appended after the statistic is computed.
    bars.push({ ticker: "—", name: workspace.name, value: youValue, you: true });
    bars.sort((a, b) => (metric.goodHigh ? b.value - a.value : a.value - b.value));
  }

  const min = Math.min(...bars.map((b) => b.value));
  const max = Math.max(...bars.map((b) => b.value));
  const span = max - min;
  const widthPct = (v: number) => (span === 0 ? 100 : 6 + ((v - min) / span) * 94);

  if (!bars.length) return null;

  return (
    <div
      data-testid={`benchmark-drill-${metric.key}`}
      className="mt-3 rounded-md border border-rule bg-surface p-4 animate-in fade-in slide-in-from-top-1 duration-overlay"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[13px] font-medium text-ink">
            {t("pci.bench.drillTitle", { metric: t(metric.labelKey), group: groupLabel })}
          </div>
          <div className="font-mono text-[10.5px] text-ink-soft tabular-nums mt-0.5">
            {t("pci.bench.n", { n: stats.n })} · {stats.fiscal.label} · {cohort.key.currency}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("pci.bench.close")}
          className="h-11 w-11 -m-2 flex items-center justify-center text-ink-soft hover:text-ink transition-colors"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      <div className="mt-3 space-y-1.5">
        {bars.map((b) => (
          <div
            key={`${b.ticker}-${b.you ? "you" : "row"}`}
            className="flex items-center gap-2.5 min-w-0"
            data-testid={b.you ? "benchmark-drill-you" : `benchmark-drill-row-${b.ticker}`}
          >
            <span className="w-[92px] shrink-0 flex items-center gap-1.5 min-w-0">
              {b.you ? (
                <StateChip tone="accent" className="truncate text-[9.5px]">
                  {t("pci.bench.you")}
                </StateChip>
              ) : (
                <>
                  <CompanyLogo ticker={b.ticker} variant="monogram" size={16} className="rounded-sm" />
                  <span className="font-mono text-[10.5px] font-medium text-ink tabular-nums truncate">
                    {b.ticker}
                  </span>
                </>
              )}
            </span>
            <div className="flex-1 min-w-0 h-4 rounded-sm bg-bg-2 overflow-hidden">
              <div
                className={`h-full rounded-sm transition-[width] duration-overlay ${
                  b.you ? "bg-brand" : "bg-brand/30"
                }`}
                style={{ width: `${widthPct(b.value)}%` }}
              />
            </div>
            <span className="w-[64px] shrink-0 text-right">
              <MetricAmount value={b.value} unit={metric.unit} className="text-[11px] text-ink" />
            </span>
          </div>
        ))}
      </div>

      {/* Overlay honesty note — metric exists for listed companies but
          not for the private workspace (market-linked, or missing from
          the loaded period). */}
      {workspace && (!youSupported || youValue == null) && (
        <div className="mt-3 text-[10.5px] text-ink-soft italic">
          {t("pci.bench.noOverlay")}
        </div>
      )}
    </div>
  );
}

// ── Formatting ───────────────────────────────────────────────────────────

/** The one way a benchmark figure renders — through <Amount>, so mono
 *  tabular + locale come for free. Percent values arrive in percentage
 *  POINTS from the watchlist rows; <Amount kind="percent"> takes ratios.
 *  Neither unit is money, so no display conversion applies here. */
function MetricAmount({
  value,
  unit,
  className,
}: {
  value: number;
  unit: "pct" | "x";
  className?: string;
}) {
  if (unit === "pct") {
    return <Amount kind="percent" value={value / 100} fractionDigits={1} className={className} />;
  }
  return <Amount kind="multiple" value={value} className={className} />;
}
