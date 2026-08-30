// MarketSurface — what a NON-Romanian market tab renders.
//
// One switch, driven entirely by the registry's `status`. There is no
// market-id branch anywhere in this file: the same three components
// serve every market the registry will ever carry, which is what makes
// "add a market to markets.yaml and it appears, correctly labelled"
// true rather than aspirational.
//
//   live               → MarketLookupPanel: read a company out of the
//                        spine store by ticker. The route never calls
//                        the upstream feed on a page view, so a miss is
//                        reported as "not cached yet", never as "no such
//                        company".
//   fundamentals_only  → MarketNotAddressablePanel: the feed is real and
//                        the extractor runs; the ticker→filing lookup is
//                        what is missing. Said in those words.
//   awaiting_provider  → MarketAwaitingPanel (its own file).
//
// EVERY NUMBER ON THIS SURFACE COMES OUT OF THE DOCUMENT. Figures render
// through <Amount>, and the provenance hover appears ONLY where the
// payload carries provenance — <Amount> itself refuses a provenance prop
// with no substance, so an unsourced figure simply has no trust chrome.

import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Loader2, Search } from "lucide-react";

import { Amount, AmountGroup } from "@/components/instrument/Amount";
import { Chip, Panel, PanelBody, PanelHeader } from "@/components/instrument/Panel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  fetchMarketCompany,
  type MarketCompanyResult,
  type MarketEntry,
  type MarketFigure,
  type MarketRefusal,
} from "@/lib/marketApi";
import { MarketDataStatusLine, useHoldingsText } from "./MarketDataStatusLine";
import { MarketAwaitingPanel } from "./MarketAwaitingPanel";
import { useMarketName } from "./MarketTabs";
import "./marketI18n";

// ── minor-unit handling ────────────────────────────────────────────────
// A money figure arrives as an INTEGER in minor units. Converting it to
// major units needs the scale, and GUESSING the scale is how a figure
// silently becomes wrong by 100x — so the scale is only ever taken from
// something the document actually says:
//
//   · the named minor unit, when the document carries one ("cent"), or
//   · the ISO 4217 minor-unit exponent of the document's own currency.
//
// A currency outside the table, or a named unit we do not know, refuses:
// the row renders an em dash with the unit in a tooltip instead of a
// number the reader would have no way to know was scaled wrong.
const NAMED_MINOR_UNIT_EXPONENT: Readonly<Record<string, number>> = { cent: 2 };

/** ISO 4217 minor-unit exponents for every currency the market registry
 *  can name today. Extended deliberately — a zero-decimal currency (JPY,
 *  KRW) MUST be added here before its market goes live, not defaulted. */
const CURRENCY_MINOR_UNIT_EXPONENT: Readonly<Record<string, number>> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  RON: 2,
  CNY: 2,
  HKD: 2,
  AED: 2,
};

export function figureMajor(fig: MarketFigure): number | null {
  const minor = fig.value_minor;
  if (typeof minor !== "number" || !Number.isInteger(minor)) return null;
  let exponent: number | undefined;
  if (typeof fig.minor_unit === "string" && fig.minor_unit) {
    exponent = NAMED_MINOR_UNIT_EXPONENT[fig.minor_unit];
  } else if (typeof fig.currency === "string" && fig.currency) {
    exponent = CURRENCY_MINOR_UNIT_EXPONENT[fig.currency.toUpperCase()];
  }
  if (exponent === undefined) return null;
  return minor / Math.pow(10, exponent);
}

/** Preferred render order. Anything not listed still renders, after
 *  these, so a new figure name is never dropped on the floor. */
const FIGURE_ORDER = [
  "revenue",
  "net_income",
  "ebitda",
  "total_assets",
  "equity",
  "total_debt",
  "cash_and_equivalents",
  "shares_outstanding",
];

function orderedFigureNames(figures: Record<string, MarketFigure>): string[] {
  const names = Object.keys(figures);
  const known = FIGURE_ORDER.filter((n) => names.includes(n));
  const rest = names.filter((n) => !FIGURE_ORDER.includes(n)).sort();
  return [...known, ...rest];
}

function humanFigureName(name: string): string {
  return name
    .split("_")
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

// ── the switch ─────────────────────────────────────────────────────────

export function MarketSurface({
  market,
  holdingsKnown,
  bundled,
}: {
  market: MarketEntry;
  holdingsKnown: boolean;
  bundled?: boolean;
}) {
  if (market.status === "awaiting_provider") {
    return (
      <MarketAwaitingPanel
        market={market}
        holdingsKnown={holdingsKnown}
        bundled={bundled}
      />
    );
  }
  if (market.status === "fundamentals_only") {
    return (
      <MarketNotAddressablePanel
        market={market}
        holdingsKnown={holdingsKnown}
        bundled={bundled}
      />
    );
  }
  return (
    <MarketLookupPanel
      market={market}
      holdingsKnown={holdingsKnown}
      bundled={bundled}
    />
  );
}

// ── fundamentals_only ──────────────────────────────────────────────────

export function MarketNotAddressablePanel({
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
    <div className="space-y-4" data-testid={`market-not-addressable-${market.market_id}`}>
      <MarketDataStatusLine
        market={market}
        holdingsKnown={holdingsKnown}
        bundled={bundled}
      />
      <Panel>
        <PanelHeader as="h2" title={t("pcm.notAddressable.title", { market: label })} />
        <PanelBody className="space-y-3.5">
          <p className="max-w-[720px] text-[12.5px] leading-relaxed text-ink-soft">
            {t("pcm.notAddressable.lede", { market: label })}
          </p>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <div className="rounded-md border border-rule bg-bg-2 px-3 py-2.5">
              <div className="mb-1 text-[10.5px] uppercase tracking-[0.14em] font-semibold text-ink-soft">
                {t("pcm.notAddressable.whatWorks")}
              </div>
              <p className="text-[12px] leading-relaxed text-ink-soft">
                {t("pcm.notAddressable.whatWorksBody", {
                  source: market.fundamentals_source,
                })}
              </p>
            </div>
            <div className="rounded-md border border-rule bg-bg-2 px-3 py-2.5">
              <div className="mb-1 text-[10.5px] uppercase tracking-[0.14em] font-semibold text-ink-soft">
                {t("pcm.notAddressable.whatIsMissing")}
              </div>
              <p className="text-[12px] leading-relaxed text-ink-soft">
                {t("pcm.notAddressable.whatIsMissingBody")}
              </p>
            </div>
          </div>
        </PanelBody>
      </Panel>
    </div>
  );
}

// ── live ───────────────────────────────────────────────────────────────

export function MarketLookupPanel({
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
  const [draft, setDraft] = useState("");
  const [symbol, setSymbol] = useState<string | null>(null);

  const query = useQuery<MarketCompanyResult>({
    queryKey: ["public-market", "company", market.market_id, symbol],
    queryFn: () => fetchMarketCompany(market.market_id, symbol ?? ""),
    enabled: !!symbol,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: false,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = draft.trim().toUpperCase();
    setSymbol(next || null);
  };

  const held = holdingsKnown ? market.entities_held : undefined;

  return (
    <div className="space-y-4" data-testid={`market-lookup-${market.market_id}`}>
      <MarketDataStatusLine
        market={market}
        holdingsKnown={holdingsKnown}
        bundled={bundled}
      />

      <Panel>
        <PanelHeader as="h2" title={t("pcm.lookup.title", { market: label })} />
        <PanelBody className="space-y-3.5">
          <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor={`market-ticker-${market.market_id}`}>
              {t("pcm.lookup.placeholder")}
            </label>
            <div className="relative min-w-0 flex-1 sm:max-w-[280px]">
              <Search
                size={13}
                strokeWidth={2}
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-mute"
              />
              <input
                id={`market-ticker-${market.market_id}`}
                data-testid={`market-ticker-input-${market.market_id}`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t("pcm.lookup.placeholder")}
                autoComplete="off"
                spellCheck={false}
                className="
                  h-11 w-full rounded-md border border-rule bg-surface pl-8 pr-3
                  font-mono text-[12.5px] uppercase text-ink
                  placeholder:font-sans placeholder:normal-case placeholder:text-ink-mute
                  focus:border-rule-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30
                "
              />
            </div>
            <button
              type="submit"
              data-testid={`market-ticker-submit-${market.market_id}`}
              className="
                h-11 shrink-0 rounded-md bg-brand px-4 text-[12.5px] font-medium text-paper
                transition-colors hover:bg-brand-d
              "
            >
              {t("pcm.lookup.submit")}
            </button>
          </form>

          <p className="text-[11.5px] text-ink-soft">
            {t("pcm.lookup.hint", { examples: market.exchanges.join(" / ") })}
          </p>

          {/* Holdings — a claim about what is cached, so it renders only
              when the live registry answered with a real count. */}
          {typeof held === "number" && held > 0 && (
            <p className="text-[11.5px] text-ink-mute">
              {t("pcm.lookup.cachedNote", { count: held })}
            </p>
          )}
          {typeof held === "number" && held === 0 && !symbol && (
            <div
              className="rounded-md border border-rule bg-bg-2 px-3 py-2.5"
              data-testid={`market-empty-${market.market_id}`}
            >
              <div className="mb-1 text-[12px] font-medium text-ink">
                {t("pcm.lookup.emptyTitle", { market: label })}
              </div>
              <p className="text-[12px] leading-relaxed text-ink-soft">
                {t("pcm.lookup.emptyBody", { source: market.fundamentals_source })}
              </p>
            </div>
          )}

          {symbol && query.isFetching && (
            <div className="flex items-center gap-2 text-[12px] text-ink-soft">
              <Loader2 size={13} className="animate-spin" aria-hidden />
              {t("pcm.lookup.searching")}
            </div>
          )}

          {symbol && !query.isFetching && query.data?.ok === false && (
            <MarketRefusalNote refusal={query.data.refusal} />
          )}

          {symbol && !query.isFetching && query.data?.ok === true && (
            <MarketCompanyDocumentView result={query.data} />
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}

// ── refusals ───────────────────────────────────────────────────────────

/** A refusal is a RESULT, not an error page. It names which gap it is —
 *  "no feed", "no ticker lookup" and "not cached yet" are three
 *  different answers and must never collapse into one message. */
export function MarketRefusalNote({ refusal }: { refusal: MarketRefusal }) {
  const { t, i18n } = useTranslation();
  const titleKey = `pcm.refusal.${refusal.code}`;
  const title = i18n.exists(titleKey) ? t(titleKey) : refusal.code;
  return (
    <div
      role="status"
      data-testid={`market-refusal-${refusal.code}`}
      className="rounded-md border border-rule bg-bg-2 px-3 py-2.5"
    >
      <div className="flex items-center gap-1.5">
        <AlertCircle size={12} strokeWidth={2} aria-hidden className="text-caution" />
        <span className="text-[12px] font-medium text-ink">{title}</span>
        {refusal.ticker && (
          <span className="font-mono text-[11px] text-ink-mute">{refusal.ticker}</span>
        )}
      </div>
      {/* The server's own sentence, verbatim — it names the exact gap. */}
      <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{refusal.detail}</p>
    </div>
  );
}

// ── one company document ───────────────────────────────────────────────

export function MarketCompanyDocumentView({
  result,
}: {
  result: Extract<MarketCompanyResult, { ok: true }>;
}) {
  const { t, i18n } = useTranslation();
  const { document: doc } = result;
  // The serving tier writes its trust sentence in both languages; pick
  // the one the UI is actually in rather than translating it here.
  const trustLine =
    (i18n.language || "").toLowerCase().startsWith("ro")
      ? doc.presentation?.trust_ro
      : doc.presentation?.trust_en;
  const env = doc.envelope;
  const figures = env.figures ?? {};
  const names = orderedFigureNames(figures);
  const price = env.price;
  const entityName =
    (env.entity && typeof env.entity.name === "string" && env.entity.name) ||
    (env.entity && typeof env.entity.ticker === "string" && env.entity.ticker) ||
    env.entity_id;
  const refusalCount = Array.isArray(env.refusals) ? env.refusals.length : 0;
  // One currency for the whole block, and ONLY when every money figure
  // agrees. A mixed-currency document gets no shared label — the figures
  // would then each need their own, which is a case this feed refuses to
  // produce today (USD-only in v1) rather than one we render wrongly.
  const moneyCurrencies = new Set(
    names
      .map((n) => figures[n]?.currency)
      .filter((c): c is string => typeof c === "string" && !!c),
  );
  const figuresCurrency =
    moneyCurrencies.size === 1 ? [...moneyCurrencies][0] : null;

  return (
    <div
      className="space-y-3 rounded-md border border-rule bg-surface p-3"
      data-testid={`market-document-${env.entity_id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-ink">{String(entityName)}</span>
        <Chip className="font-mono">{doc.market.market_id.toUpperCase()}</Chip>
        <Chip className="font-mono">{doc.market.currency}</Chip>
      </div>
      {trustLine && (
        <p className="text-[11px] leading-relaxed text-ink-soft">{trustLine}</p>
      )}

      {/* Price — only ever from the document's own price block, which
          carries its own as-of and delay note. No price block means no
          price line; there is no fallback quote to borrow. */}
      {price && (
        <div className="flex flex-wrap items-baseline gap-2 border-t border-rule-soft pt-2">
          <span className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft">
            {t("pcm.doc.price")}
          </span>
          <Amount
            value={price.price_minor / 100}
            currency={price.currency}
            fractionDigits={2}
            className="text-[13px] text-ink"
          />
          <span className="text-[11px] text-ink-mute">
            {t("pcm.doc.asOf", { date: price.as_of })} · {price.delay_note}
          </span>
        </div>
      )}

      {names.length > 0 && (
        /* One shared magnitude across the money figures, so "416,2 B$"
           never sits beside "98.657.000.000,00 $" in the same block. */
        <AmountGroup
          values={names.map((n) => figureMajor(figures[n])).filter((v) => v !== null)}
        >
          <div className="border-t border-rule-soft pt-2">
            {/* The currency is declared ONCE, here. A magnitude-scaled
                figure must never carry an inline symbol: "416,16 BUSD"
                reads as a currency that does not exist — the same trap
                the company grid documents for "BRON". */}
            <div className="mb-1.5 text-[10.5px] uppercase tracking-[0.1em] text-ink-soft">
              {t("pcm.doc.figures")}
              {figuresCurrency ? ` · ${figuresCurrency}` : ""}
            </div>
            <dl className="grid gap-x-8 gap-y-1.5 sm:grid-cols-2">
              {names.map((n) => (
                <FigureRow key={n} name={n} figure={figures[n]} />
              ))}
            </dl>
          </div>
        </AmountGroup>
      )}

      {refusalCount > 0 && (
        <p className="border-t border-rule-soft pt-2 text-[11px] text-ink-mute">
          {refusalCount === 1
            ? t("pcm.doc.refusalsOne")
            : t("pcm.doc.refusalsCount", { count: refusalCount })}
        </p>
      )}

      {/* The serving tier's own source + licence lines, verbatim. The
          source line names the feed, the accession and the period end —
          the filing this document was read out of. */}
      {doc.presentation?.source_line && (
        <p className="border-t border-rule-soft pt-2 font-mono text-[10.5px] leading-relaxed text-ink-mute">
          {doc.presentation.source_line}
        </p>
      )}
      {doc.presentation?.license_line && (
        <p className="text-[10.5px] leading-relaxed text-ink-mute">
          {doc.presentation.license_line}
        </p>
      )}
    </div>
  );
}

function FigureRow({ name, figure }: { name: string; figure: MarketFigure }) {
  const prov = figure.provenance ?? null;
  // The provenance affordance appears ONLY where the payload carries a
  // source. <Amount> refuses an empty provenance object, so this maps
  // what exists and never invents a field to make the hover appear.
  const provenance = prov
    ? {
        source: [prov.source, prov.concept].filter(Boolean).join(" · ") || undefined,
        method: typeof prov.form === "string" ? prov.form : undefined,
        pack: typeof prov.taxonomy === "string" ? prov.taxonomy : undefined,
        snapshot:
          (typeof prov.accession_or_version === "string" && prov.accession_or_version) ||
          (typeof prov.accession === "string" && prov.accession) ||
          undefined,
        computedAt: typeof prov.filed === "string" ? prov.filed : undefined,
      }
    : null;

  const isCount = typeof figure.value === "number" && figure.value_minor == null;
  const major = isCount ? figure.value ?? null : figureMajor(figure);

  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <dt className="min-w-0 truncate text-[11.5px] text-ink-soft">
        {humanFigureName(name)}
      </dt>
      <dd className="shrink-0 text-right">
        {major === null ? (
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <span className="font-mono text-[12px] text-ink-mute">—</span>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-[240px] text-xs">
              {figure.unit ?? "unit"}
            </TooltipContent>
          </Tooltip>
        ) : (
          <Amount
            value={major}
            kind={isCount ? "count" : "money"}
            /* No inline symbol: the block declares the currency once, and
               a scaled figure with a symbol reads as a fake currency. */
            currency={null}
            provenance={provenance}
            className="text-[12px] text-ink"
          />
        )}
      </dd>
    </div>
  );
}

// ── the "All" tab: the registry as a directory ─────────────────────────

export function MarketRegistryGrid({
  markets,
  holdingsKnown,
  onOpen,
}: {
  markets: MarketEntry[];
  holdingsKnown: boolean;
  onOpen: (marketId: string) => void;
}) {
  const { t } = useTranslation();
  const name = useMarketName();
  const holdingsText = useHoldingsText();
  return (
    <div
      data-testid="market-registry-grid"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
    >
      {markets.map((m) => {
        const holdings = holdingsText(m, holdingsKnown);
        return (
          <button
            key={m.market_id}
            type="button"
            onClick={() => onOpen(m.market_id)}
            data-testid={`market-registry-card-${m.market_id}`}
            className="
              flex flex-col gap-2 rounded-md border border-rule bg-surface p-3 text-left
              transition-colors duration-micro hover:border-rule-strong
              focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30
            "
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-medium text-ink">{name(m)}</span>
              <Chip
                tone={
                  m.status === "live"
                    ? "success"
                    : m.status === "fundamentals_only"
                      ? "caution"
                      : "neutral"
                }
                dot
              >
                {t(`pcm.status.${m.status}`)}
              </Chip>
            </div>
            <div className="font-mono text-[10.5px] text-ink-mute">
              {m.exchanges.join(" · ")} · {m.currency}
            </div>
            <div className="text-[11.5px] text-ink-soft">
              {m.fundamentals_source === "none"
                ? t("pcm.data.noSource")
                : m.fundamentals_source}
            </div>
            {holdings && (
              <div className="mt-auto border-t border-rule-soft pt-1.5 text-[11px] text-ink-mute">
                {holdings}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
