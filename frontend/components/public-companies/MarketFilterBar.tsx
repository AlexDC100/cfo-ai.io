// MarketFilterBar — the ONE market-narrowing control shared by the
// universe-scoped surfaces (Risk Radar, Geographic Map).
//
// It is built from the REGISTRY, not from the markets present in the
// data. That is deliberate: a filter that only offered markets we
// already hold rows for could never show the reader that a market
// exists and is empty — and "United States is not on this map yet,
// here is why" is exactly the state this wave exists to make visible.
// Each option therefore carries its own row count, including zero.

import { useTranslation } from "react-i18next";

import type { MarketEntry } from "@/lib/marketApi";
import { useMarketName } from "./MarketTabs";
import "./marketI18n";

export interface MarketFilterOption {
  market: MarketEntry;
  /** Rows currently loaded for this market on the calling surface. */
  count: number;
}

export function MarketFilterBar({
  options,
  activeMarketId,
  onChange,
  testId,
}: {
  options: MarketFilterOption[];
  /** null = every market. */
  activeMarketId: string | null;
  onChange: (marketId: string | null) => void;
  testId: string;
}) {
  const { t } = useTranslation();
  const name = useMarketName();
  const total = options.reduce((n, o) => n + o.count, 0);

  return (
    <div
      data-testid={testId}
      className="
        flex items-center gap-1.5 overflow-x-auto pb-1 -mb-1
        sm:flex-wrap sm:overflow-visible sm:pb-0 sm:mb-0
        [scrollbar-width:none] [&::-webkit-scrollbar]:hidden
      "
    >
      <span className="shrink-0 text-[10.5px] uppercase tracking-[0.14em] font-semibold text-ink-soft mr-1">
        {t("pcm.filter.label")}
      </span>
      <Pill
        label={t("pcm.filter.all")}
        count={total}
        selected={activeMarketId === null}
        onClick={() => onChange(null)}
        testId={`${testId}-all`}
      />
      {options.map((o) => (
        <Pill
          key={o.market.market_id}
          label={name(o.market)}
          count={o.count}
          selected={activeMarketId === o.market.market_id}
          onClick={() => onChange(o.market.market_id)}
          testId={`${testId}-${o.market.market_id}`}
        />
      ))}
    </div>
  );
}

function Pill({
  label,
  count,
  selected,
  onClick,
  testId,
}: {
  label: string;
  count: number;
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
        shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border
        text-[11.5px] font-medium transition-colors duration-micro
        ${selected
          ? "border-brand/50 bg-brand-tint text-brand-dark dark:text-brand-light"
          : "border-rule bg-surface text-ink hover:bg-bg-2 hover:border-rule-strong"}
      `}
    >
      {label}
      <span
        className={`font-mono text-[10px] tabular-nums ${selected ? "" : "text-ink-soft"}`}
      >
        {count}
      </span>
    </button>
  );
}
