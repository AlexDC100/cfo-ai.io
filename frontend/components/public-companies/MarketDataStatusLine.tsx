// MarketDataStatusLine — the four facts every market surface owes the
// reader BEFORE any number: where the figures come from, how often they
// refresh, what happens with prices, and under what licence the bytes
// arrive. Read straight from the market registry; nothing here is
// composed by hand per market, so a market cannot be described one way
// on one screen and another way on the next.
//
// Two honesty rules are enforced structurally rather than by wording:
//
//   1. The cached-holdings count renders ONLY when the live registry
//      endpoint answered (`holdingsKnown`). When the service is down we
//      say holdings are unknown — an absent count is not a count of
//      zero, and "0 companies cached" would be a fabricated fact.
//   2. `price_source: none` on the HOME market does not read as "no
//      prices exist" — Romanian quotes are served by the pipeline that
//      already serves Romania, not by this registry. That distinction
//      is structural (`marquee_rank === 0`), never a market-id branch.

import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";

import { Chip } from "@/components/instrument/Panel";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ChipTone } from "@/components/instrument/Panel";
import type { MarketEntry, MarketStatus } from "@/lib/marketApi";
import { useMarketName } from "./MarketTabs";
import "./marketI18n";

const STATUS_TONE: Record<MarketStatus, ChipTone> = {
  live: "success",
  fundamentals_only: "caution",
  awaiting_provider: "neutral",
};

/** Human label for a machine cadence value, falling back to the raw
 *  value so an unrecognised cadence is shown as-is rather than dropped. */
export function useCadenceLabel(): (cadence: string) => string {
  const { t, i18n } = useTranslation();
  return (cadence: string) => {
    const key = `pcm.cadence.${cadence}`;
    return i18n.exists(key) ? t(key) : cadence;
  };
}

/** Human label for a machine price_source value. The home market gets
 *  its own sentence — see the header note. */
export function usePriceSourceLabel(): (m: MarketEntry) => string {
  const { t, i18n } = useTranslation();
  return (m: MarketEntry) => {
    if (m.price_source === "none" && m.marquee_rank === 0) {
      return t("pcm.priceSource.homeNote");
    }
    const key = `pcm.priceSource.${m.price_source}`;
    return i18n.exists(key) ? t(key) : m.price_source;
  };
}

/** The ONE place the cached-holdings sentence is decided, so the status
 *  line and the registry grid can never disagree about what a count
 *  means. Returns null when no sentence should be printed at all.
 *
 *  Three structural cases, none of them a market-id branch:
 *   · home market      — never holds entities in this store by design;
 *   · no feed + no held— a zero here reads as a shortfall, not as the
 *                        absence of a source, so it is omitted;
 *   · holdings unknown — an absent count is never rendered as zero. */
export function useHoldingsText(): (
  market: MarketEntry,
  holdingsKnown: boolean,
) => string | null {
  const { t } = useTranslation();
  return (market, holdingsKnown) => {
    const held = market.entities_held;
    if (market.marquee_rank === 0) return t("pcm.data.holdingsHome");
    if (!holdingsKnown || typeof held !== "number") {
      return t("pcm.data.holdingsUnknown");
    }
    if (held === 0) {
      return market.fundamentals_source === "none"
        ? null
        : t("pcm.data.holdingsZero");
    }
    return held === 1
      ? t("pcm.data.holdingsOne")
      : t("pcm.data.holdings", { count: held });
  };
}

export function MarketStatusChip({ status }: { status: MarketStatus }) {
  const { t } = useTranslation();
  return (
    <Chip tone={STATUS_TONE[status]} dot data-testid={`market-status-${status}`}>
      {t(`pcm.status.${status}`)}
    </Chip>
  );
}

export function MarketDataStatusLine({
  market,
  holdingsKnown,
  bundled,
  className,
}: {
  market: MarketEntry;
  /** True only when the live registry endpoint answered. */
  holdingsKnown: boolean;
  /** True when the registry itself came from the bundled mirror. */
  bundled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const name = useMarketName();
  const cadence = useCadenceLabel();
  const priceSource = usePriceSourceLabel();

  const holdingsText = useHoldingsText()(market, holdingsKnown);

  const sourceText =
    market.fundamentals_source === "none"
      ? t("pcm.data.noSource")
      : market.fundamentals_source;



  return (
    <div
      data-testid={`market-data-status-${market.market_id}`}
      className={`rounded-md border border-rule bg-bg-2 px-3 py-2.5 ${className ?? ""}`.trim()}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="text-[10.5px] uppercase tracking-[0.14em] font-semibold text-ink-soft">
          {t("pcm.data.label")}
        </span>
        <MarketStatusChip status={market.status} />
        <span className="text-[11.5px] text-ink-soft">{name(market)}</span>
        <span className="font-mono text-[10.5px] text-ink-mute">
          {market.exchanges.join(" · ")} · {market.currency} · {market.accounting_standard}
        </span>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t("pcm.data.why")}
              data-testid={`market-status-why-${market.market_id}`}
              className="
                inline-flex h-6 w-6 items-center justify-center rounded-full border border-rule
                text-ink-soft transition-colors hover:bg-surface hover:text-ink
              "
            >
              <Info size={11} strokeWidth={2} />
            </button>
          </PopoverTrigger>
          <PopoverContent side="bottom" align="start" className="w-[340px] p-3.5">
            <div className="text-[10.5px] uppercase tracking-[0.1em] font-semibold text-ink-soft mb-1.5">
              {t(`pcm.status.${market.status}`)}
            </div>
            <p className="text-[12px] leading-relaxed text-ink-soft">
              {t(`pcm.status.${market.status}Why`)}
            </p>
            {/* The registry's own coverage note, verbatim — the sentence
                the engine authors wrote about what this market can and
                cannot deliver. Never paraphrased here. */}
            <p className="mt-2 border-t border-rule-soft pt-2 text-[11.5px] leading-relaxed text-ink-mute">
              {market.coverage_note}
            </p>
          </PopoverContent>
        </Popover>
      </div>

      <dl className="mt-2 grid gap-x-4 gap-y-1 text-[11.5px] sm:grid-cols-2">
        <Fact label={t("pcm.data.source")} value={sourceText} mono />
        <Fact label={t("pcm.data.cadence")} value={cadence(market.refresh_cadence)} />
        <Fact label={t("pcm.data.prices")} value={priceSource(market)} />
        <Fact label={t("pcm.data.license")} value={market.license_notes} />
      </dl>

      {(bundled || holdingsText) && (
        <div className="mt-2 border-t border-rule-soft pt-1.5 text-[11px] text-ink-mute">
          {/* When the registry itself came from the bundled copy, that one
              sentence already carries the holdings answer — printing both
              would read as two independent failures. */}
          <span data-testid={`market-holdings-${market.market_id}`}>
            {bundled ? t("pcm.data.bundled") : holdingsText}
          </span>
        </div>
      )}
    </div>
  );
}

function Fact({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 gap-1.5">
      <dt className="shrink-0 text-ink-mute">{label}</dt>
      <dd
        className={`min-w-0 text-ink-soft ${mono ? "font-mono text-[11px]" : ""}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}
