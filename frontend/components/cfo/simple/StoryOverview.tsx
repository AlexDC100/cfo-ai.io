// THE DIAL — Story Overview (Prompt 12, Part C). Simple mode only.
//
// The reading-order narrative an owner sees instead of the Pro overview:
// five Panels — How you did · Your cash · What you owe · The one thing to
// watch · Suggested next steps. Pro renders today's overview untouched;
// this surface only REARRANGES what Pro already shows:
//
//   · Every figure renders through <Amount> from the SAME accessors the
//     Pro key-metric row reads (headline / deriveTotals / balanceSheet),
//     converted through the SAME useConvertedAmounts hook — gate M1
//     asserts the strings are cent-identical across modes.
//   · Context sentences are the deterministic templates from
//     lib/contextLines.ts — reviewed copy, no model call, fully
//     functional with AI dead. Absent input -> null -> nothing renders.
//   · "The one thing to watch" is the TOP existing recommendation; its
//     body is the payload's own rationale when present, a template
//     fallback otherwise. Never generated at runtime.

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";

import { Amount, AmountGroup } from "@/components/instrument/Amount";
import type { AmountProvenance } from "@/components/instrument/Provenance";
import { Chip, Panel, PanelBody, PanelHeader, type ChipTone } from "@/components/instrument/Panel";
import { annotateTerms } from "./annotateTerms";
import { Term } from "@/components/instrument/Term";
import {
  cashRunwayLine,
  debtCoverageLine,
  netDebtLine,
  profitLine,
  revenueYoyLine,
} from "@/lib/contextLines";
import { useActiveLocale } from "@/lib/locale";
import type { Recommendation } from "@/lib/financialReport";

import "./storyI18n";
import { useConvertedAmounts } from "./convertedAmounts";

// ── top-recommendation pick (presentation-only ordering) ───────────────

const PRIORITY_ORDER: Record<Recommendation["priority"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  info: 3,
};

/** Stable priority sort over the EXISTING recommendations — no new
 *  content, only reading order. */
export function sortRecommendations(recs: Recommendation[]): Recommendation[] {
  return [...recs].sort(
    (a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9),
  );
}

export function pickTopRecommendation(recs: Recommendation[]): Recommendation | null {
  return sortRecommendations(recs)[0] ?? null;
}

const SEV_CHIP: Record<Recommendation["priority"], { tone: ChipTone; key: string }> = {
  critical: { tone: "alert", key: "story.sev.critical" },
  high: { tone: "alert", key: "story.sev.critical" },
  medium: { tone: "caution", key: "story.sev.watch" },
  info: { tone: "neutral", key: "story.sev.info" },
};

// ── the component ──────────────────────────────────────────────────────

export interface StoryOverviewProps {
  /** Statement currency — conversion to display currency happens here,
   *  through the same hook as Pro's key-metric row. */
  currency: string;
  /** headline.totalOperatingRevenue — same accessor as Pro. */
  revenue: number;
  /** headline.tileNetProfitRon — same accessor as Pro. */
  profit: number;
  /** statements.balanceSheet.cash — same accessor as Pro. */
  cash: number;
  /** deriveTotals(statements).netDebt — same accessor as Pro. */
  netDebt: number;
  /** deriveTotals(statements).totalDebt — same accessor as Pro. */
  totalDebt: number;
  /** headline.tileEbitdaRon — sentence input only (debt coverage). */
  ebitda: number | null;
  /** The P&L builder's "Total operating expenses (cash)" subtotal — the
   *  same served figure the Pro P&L tab renders. Null -> no runway line. */
  annualOperatingCosts: number | null;
  /** trendFor("operating_revenue") — same series as Pro's trend chip. */
  revenueTrend: { pct: number; prevLabel: string } | null;
  recommendations: Recommendation[];
  onJumpToTab?: (tab: string) => void;
  /** Origin of each figure, built ONCE by the page (`lib/headlineProvenance`)
   *  from the same inputs as the figures and shared with Pro's
   *  KeyMetricsRow — mode parity covers the origin as well as the value.
   *  A missing or null entry renders that figure plain. */
  provenance?: Partial<
    Record<"revenue" | "profit" | "cash" | "netDebt" | "totalDebt", AmountProvenance | null>
  >;
}

export function StoryOverview({
  currency,
  revenue,
  profit,
  cash,
  netDebt,
  totalDebt,
  ebitda,
  annualOperatingCosts,
  revenueTrend,
  recommendations,
  onJumpToTab,
  provenance,
}: StoryOverviewProps) {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const ctx = { locale };

  // ONE conversion + ONE magnitude group for every figure on this surface.
  // The group's scale-picking set mirrors Pro's key-metric row (revenue /
  // profit / cash / net debt) so shared figures land on the same scale;
  // totalDebt renders inside the group at that shared scale.
  const { converted, symbol } = useConvertedAmounts(
    [revenue, profit, cash, netDebt, totalDebt],
    currency,
  );
  const [cRevenue, cProfit, cCash, cNetDebt, cTotalDebt] = converted;

  const yoyLine = revenueYoyLine(revenueTrend ? revenueTrend.pct : null, ctx);
  const pLine = profitLine(profit, ctx);
  const runwayLine = cashRunwayLine(cash, annualOperatingCosts, ctx);
  const ndLine = netDebtLine(ctx);
  // Coverage ratio derived from the SAME served pair (netDebt / EBITDA)
  // the Pro surfaces show side by side. netDebt <= 0 is a truthful
  // "more cash than debt" regardless of EBITDA; a non-positive EBITDA
  // with real net debt yields no line (never a guessed one).
  const netDebtToEbitda =
    ebitda != null && ebitda > 0 ? netDebt / ebitda : netDebt <= 0 ? 0 : null;
  const coverageLine = debtCoverageLine(netDebtToEbitda, ctx);

  const sorted = sortRecommendations(recommendations);
  const topRec = sorted[0] ?? null;
  const nextRecs = sorted.slice(1, 5);

  const figureRow = (
    label: ReactNode,
    value: number | null,
    testid: string,
    origin: AmountProvenance | null | undefined,
  ) => (
    <div className="flex items-baseline justify-between gap-3 py-1.5" data-testid={testid}>
      <span className="min-w-0 text-[13px] text-ink-2">{label}</span>
      {/* `${testid}-amount` — gate M1 compares this string against the Pro
          KeyMetricsRow's `${testid}-amount` for the same fixture value. */}
      <span
        className="shrink-0 text-[19px] font-medium leading-none text-ink"
        data-testid={`${testid}-amount`}
      >
        <Amount value={value} currency={symbol} provenance={origin ?? null} />
      </span>
    </div>
  );

  return (
    <div className="space-y-4" data-testid="story-overview">
      {/* 1 · HOW YOU DID — revenue + profit, YoY in words, honest profit line. */}
      <Panel data-testid="story-how">
        <PanelHeader
          as="h2"
          title={t("story.how.title")}
          actions={
            revenueTrend ? (
              <Chip tone="neutral" title={t("story.vsLastPeriod", { period: revenueTrend.prevLabel })}>
                <Amount kind="percent" value={revenueTrend.pct} fractionDigits={1} />
              </Chip>
            ) : undefined
          }
        />
        <PanelBody>
          <AmountGroup values={[cRevenue, cProfit, cCash, cNetDebt]}>
            {figureRow(<Term id="revenue" />, cRevenue, "story-figure-revenue", provenance?.revenue)}
            {figureRow(<Term id="net_profit" />, cProfit, "story-figure-profit", provenance?.profit)}
          </AmountGroup>
          {(yoyLine || pLine) && (
            <div className="mt-2 space-y-0.5 border-t border-rule-soft pt-2">
              {yoyLine && <p className="text-[12.5px] leading-relaxed text-ink-soft">{yoyLine}</p>}
              {pLine && <p className="text-[12.5px] leading-relaxed text-ink-soft">{pLine}</p>}
            </div>
          )}
        </PanelBody>
      </Panel>

      {/* 2 · YOUR CASH — position + deterministic runway sentence. */}
      <Panel data-testid="story-cash">
        <PanelHeader as="h2" title={t("story.cash.title")} />
        <PanelBody>
          <AmountGroup values={[cRevenue, cProfit, cCash, cNetDebt]}>
            {figureRow(t("story.cash.label"), cCash, "story-figure-cash", provenance?.cash)}
          </AmountGroup>
          {runwayLine && (
            <div className="mt-2 border-t border-rule-soft pt-2">
              <p className="text-[12.5px] leading-relaxed text-ink-soft" data-testid="story-runway-line">
                {runwayLine}
              </p>
            </div>
          )}
        </PanelBody>
      </Panel>

      {/* 3 · WHAT YOU OWE — debt picture + net-debt meaning + coverage. */}
      <Panel data-testid="story-owe">
        <PanelHeader as="h2" title={t("story.owe.title")} />
        <PanelBody>
          <AmountGroup values={[cRevenue, cProfit, cCash, cNetDebt]}>
            {figureRow(t("story.owe.totalLoans"), cTotalDebt, "story-figure-total-debt", provenance?.totalDebt)}
            {figureRow(<Term id="net_debt" />, cNetDebt, "story-figure-net-debt", provenance?.netDebt)}
          </AmountGroup>
          <div className="mt-2 space-y-0.5 border-t border-rule-soft pt-2">
            <p className="text-[12.5px] leading-relaxed text-ink-soft">{ndLine}</p>
            {coverageLine && (
              <p className="text-[12.5px] leading-relaxed text-ink-soft" data-testid="story-coverage-line">
                {coverageLine}
              </p>
            )}
          </div>
        </PanelBody>
      </Panel>

      {/* 4 · THE ONE THING TO WATCH — the top EXISTING recommendation. */}
      <Panel data-testid="story-watch">
        <PanelHeader
          as="h2"
          title={t("story.watch.title")}
          actions={
            topRec ? (
              <Chip tone={SEV_CHIP[topRec.priority].tone} dot>
                {t(SEV_CHIP[topRec.priority].key)}
              </Chip>
            ) : undefined
          }
        />
        <PanelBody>
          {topRec ? (
            <>
              {/* Engine copy arrives with bare jargon (DSCR, covenant,
                  capex) that the static M3 lint can never see — the
                  dictionary annotator wraps each known term in <Term>
                  and changes nothing else. */}
              <p className="text-[13.5px] font-medium leading-snug text-ink">
                {annotateTerms(topRec.title)}
              </p>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
                {topRec.rationale?.trim()
                  ? annotateTerms(topRec.rationale)
                  : t("story.watch.fallbackBody")}
              </p>
            </>
          ) : (
            <>
              <p className="text-[13.5px] font-medium leading-snug text-ink">
                {t("story.watch.allClearTitle")}
              </p>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
                {t("story.watch.allClearBody")}
              </p>
            </>
          )}
        </PanelBody>
      </Panel>

      {/* 5 · SUGGESTED NEXT STEPS — the existing recommendations, plain. */}
      <Panel data-testid="story-next">
        <PanelHeader
          as="h2"
          title={t("story.next.title")}
          actions={
            onJumpToTab && recommendations.length > 0 ? (
              <button
                type="button"
                onClick={() => onJumpToTab("recommendations")}
                data-testid="story-see-all"
                className="inline-flex items-center gap-0.5 text-[12px] font-medium text-brand-d transition-colors duration-micro hover:text-brand"
              >
                {t("story.next.seeAll")}
                <ChevronRight size={13} strokeWidth={2} />
              </button>
            ) : undefined
          }
        />
        <PanelBody>
          {nextRecs.length > 0 ? (
            <ul className="divide-y divide-rule-soft">
              {nextRecs.map((rec) => (
                <li key={rec.id} className="flex items-center gap-2.5 py-2 first:pt-0 last:pb-0">
                  <Chip tone={SEV_CHIP[rec.priority].tone} className="shrink-0">
                    {t(SEV_CHIP[rec.priority].key)}
                  </Chip>
                  <span className="min-w-0 truncate text-[13px] text-ink-2">{rec.title}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] leading-relaxed text-ink-soft">{t("story.next.empty")}</p>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}
