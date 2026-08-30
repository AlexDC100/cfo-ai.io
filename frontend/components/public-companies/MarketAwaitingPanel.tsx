// MarketAwaitingPanel — the CALM state for a market with no feed.
//
// DOD3: a market tab is never blank and never fabricated. When the
// registry says `awaiting_provider` there is no deterministic source
// wired, so this panel does the only honest thing available — it states
// three facts:
//
//   · what arrives the moment a provider is connected,
//   · what is missing right now, named precisely,
//   · the environment variable that activates it.
//
// It deliberately does NOT say "no results found". That phrasing implies
// a search happened and came back empty, which would be a claim about
// the market rather than about our wiring. It also carries no number,
// no placeholder chart and no greyed-out metric grid: a skeleton that
// never resolves reads as a broken page, and a zero reads as a figure.

import { useTranslation } from "react-i18next";
import { Check, Minus, Terminal } from "lucide-react";

import { Panel, PanelBody, PanelHeader } from "@/components/instrument/Panel";
import { PROVIDER_ENV_VAR, type MarketEntry } from "@/lib/marketApi";
import { MarketDataStatusLine } from "./MarketDataStatusLine";
import { useMarketName } from "./MarketTabs";
import "./marketI18n";

export function MarketAwaitingPanel({
  market,
  holdingsKnown,
  bundled,
}: {
  market: MarketEntry;
  holdingsKnown: boolean;
  bundled?: boolean;
}) {
  const { t } = useTranslation();
  const name = useMarketName();
  const label = name(market);

  return (
    <div className="space-y-4" data-testid={`market-awaiting-${market.market_id}`}>
      <MarketDataStatusLine
        market={market}
        holdingsKnown={holdingsKnown}
        bundled={bundled}
      />

      <Panel>
        <PanelHeader as="h2" title={t("pcm.awaiting.title", { market: label })} />
        <PanelBody className="space-y-4">
          <p className="max-w-[720px] text-[12.5px] leading-relaxed text-ink-soft">
            {t("pcm.awaiting.lede")}
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <section>
              <h3 className="mb-1.5 text-[10.5px] uppercase tracking-[0.14em] font-semibold text-ink-soft">
                {t("pcm.awaiting.comingTitle")}
              </h3>
              <ul className="space-y-1.5">
                <Line icon="check">{t("pcm.awaiting.comingFundamentals")}</Line>
                <Line icon="check">{t("pcm.awaiting.comingPrices")}</Line>
                <Line icon="check">{t("pcm.awaiting.comingBenchmark")}</Line>
              </ul>
            </section>

            <section>
              <h3 className="mb-1.5 text-[10.5px] uppercase tracking-[0.14em] font-semibold text-ink-soft">
                {t("pcm.awaiting.missingTitle")}
              </h3>
              <ul className="space-y-1.5">
                <Line icon="minus">
                  {t("pcm.awaiting.missingFeed", { market: label })}
                </Line>
                <Line icon="minus">{t("pcm.awaiting.missingPrices")}</Line>
              </ul>
            </section>
          </div>

          {/* The activation step, named exactly. An operator reading this
              should not have to look anywhere else to unblock it. */}
          <div className="rounded-md border border-rule bg-bg-2 px-3 py-2.5">
            <div className="mb-1 flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.14em] font-semibold text-ink-soft">
              <Terminal size={11} strokeWidth={2} aria-hidden />
              {t("pcm.awaiting.activateTitle")}
            </div>
            <p className="text-[12px] leading-relaxed text-ink-soft">
              {t("pcm.awaiting.activateBody", { env: PROVIDER_ENV_VAR })}
            </p>
            <code
              data-testid={`market-activate-env-${market.market_id}`}
              className="mt-1.5 inline-block rounded border border-rule bg-surface px-1.5 py-0.5 font-mono text-[11px] text-ink"
            >
              {PROVIDER_ENV_VAR}
            </code>
          </div>
        </PanelBody>
      </Panel>
    </div>
  );
}

function Line({
  icon,
  children,
}: {
  icon: "check" | "minus";
  children: React.ReactNode;
}) {
  const Icon = icon === "check" ? Check : Minus;
  return (
    <li className="flex gap-2 text-[12px] leading-relaxed text-ink-soft">
      <Icon
        size={13}
        strokeWidth={2}
        aria-hidden
        className={`mt-0.5 shrink-0 ${icon === "check" ? "text-success" : "text-ink-mute"}`}
      />
      <span className="min-w-0">{children}</span>
    </li>
  );
}
