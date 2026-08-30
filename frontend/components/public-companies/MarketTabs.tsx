// MarketTabs — the primary axis of /public-companies.
//
// Renders the market strip in REGISTRY ORDER (Romania first and in its
// own group, then marquee rank, then A→Z), collapsing Europe into one
// tab with country sub-filters. The strip is BUILT from the registry
// (lib/marketApi.buildMarketTabs), never hand-listed, so a market added
// to markets.yaml appears here without an edit — and can never silently
// disappear.
//
// Visual system: the instrument's hairline underline tabs — a 2px accent
// rule sitting ON the container's 1px border, never a fill, never a
// shadow. Each tab carries a status dot so "Live" and "Awaiting
// provider" are legible before the tab is opened; a tab that hides a
// gap behind a neutral label is the failure this whole surface exists
// to avoid.

import { useTranslation } from "react-i18next";

import {
  ALL_MARKETS_TAB_ID,
  type MarketEntry,
  type MarketStatus,
  type MarketTab,
} from "@/lib/marketApi";
import "./marketI18n";

/** Tone for a market's status dot. `caution` is the one amber meaning
 *  in this design system ("not finished yet"), which is exactly what
 *  fundamentals_only and awaiting_provider are. */
const STATUS_DOT: Record<MarketStatus, string> = {
  live: "bg-success",
  fundamentals_only: "bg-caution",
  awaiting_provider: "bg-ink-mute",
};

/** Display name for a market, translated when the locale carries a name
 *  for it and falling back to the registry's own English display_name.
 *  The registry is the authority; this only localises it. */
export function useMarketName(): (m: MarketEntry) => string {
  const { t, i18n } = useTranslation();
  return (m: MarketEntry) => {
    const key = `pcm.market.${m.market_id}`;
    return i18n.exists(key) ? t(key) : m.display_name;
  };
}

/** The status a TAB reports: the best status among the markets it
 *  scopes to. A region tab whose members differ shows the strongest,
 *  and the per-country sub-filter row shows each country's own. */
export function tabStatus(tab: MarketTab): MarketStatus {
  const order: MarketStatus[] = ["live", "fundamentals_only", "awaiting_provider"];
  let best = order.length - 1;
  for (const m of tab.markets) {
    const idx = order.indexOf(m.status);
    if (idx >= 0 && idx < best) best = idx;
  }
  return order[best];
}

export function MarketTabs({
  tabs,
  activeId,
  onSelect,
  activeCountryId,
  onSelectCountry,
}: {
  tabs: MarketTab[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Active country inside a region tab; null = the whole region. */
  activeCountryId: string | null;
  onSelectCountry: (marketId: string | null) => void;
}) {
  const { t } = useTranslation();
  const name = useMarketName();
  const active = tabs.find((tb) => tb.id === activeId) ?? tabs[0];

  const labelFor = (tb: MarketTab): string => {
    if (tb.kind === "all") return t("pcm.tab.all");
    if (tb.kind === "region") return t(`pcm.region.${tb.region}`);
    return tb.market ? name(tb.market) : tb.id;
  };

  return (
    <div data-testid="market-tabs">
      <div
        role="tablist"
        aria-label={t("pcm.tab.aria")}
        className="
          flex gap-5 border-b border-rule overflow-x-auto
          [scrollbar-width:none] [&::-webkit-scrollbar]:hidden
        "
      >
        {tabs.map((tb) => {
          const isActive = tb.id === active?.id;
          const status = tabStatus(tb);
          return (
            <button
              key={tb.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(tb.id)}
              data-testid={`market-tab-${tb.id}`}
              data-status={tb.kind === "all" ? undefined : status}
              className={`
                shrink-0 inline-flex items-center gap-1.5
                -mb-px pb-2 pt-1 border-b-2
                text-[12.5px] font-medium whitespace-nowrap
                transition-colors duration-micro
                ${isActive
                  ? "border-brand text-ink"
                  : "border-transparent text-ink-soft hover:text-ink"}
              `}
            >
              {tb.kind !== "all" && (
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`}
                />
              )}
              {labelFor(tb)}
            </button>
          );
        })}
      </div>

      {/* Region sub-filters — one pill per country in the region, plus
          an "all of <region>" reset. Each pill carries its own status
          dot: inside Europe today, four countries are filings-only and
          Germany has no feed at all, and flattening that into one tab
          label would be a lie by omission. */}
      {active?.kind === "region" && active.markets.length > 1 && (
        <div
          className="mt-3 flex flex-wrap items-center gap-1.5"
          data-testid={`market-subfilters-${active.region}`}
        >
          <span className="text-[10.5px] uppercase tracking-[0.14em] font-semibold text-ink-soft mr-1">
            {t("pcm.tab.countries")}
          </span>
          <CountryPill
            label={t("pcm.tab.allCountries")}
            selected={activeCountryId === null}
            onClick={() => onSelectCountry(null)}
            testId={`market-subfilter-${active.region}-all`}
          />
          {active.markets.map((m) => (
            <CountryPill
              key={m.market_id}
              label={name(m)}
              status={m.status}
              selected={activeCountryId === m.market_id}
              onClick={() => onSelectCountry(m.market_id)}
              testId={`market-subfilter-${m.market_id}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CountryPill({
  label,
  status,
  selected,
  onClick,
  testId,
}: {
  label: string;
  status?: MarketStatus;
  selected: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      data-testid={testId}
      className={`
        inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border
        text-[11.5px] font-medium transition-colors duration-micro
        ${selected
          ? "border-brand/50 bg-brand-tint text-brand-dark dark:text-brand-light"
          : "border-rule bg-surface text-ink hover:bg-bg-2 hover:border-rule-strong"}
      `}
    >
      {status && (
        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />
      )}
      {label}
    </button>
  );
}

export { ALL_MARKETS_TAB_ID };
