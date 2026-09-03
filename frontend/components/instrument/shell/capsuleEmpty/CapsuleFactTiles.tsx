// THE CAPSULE — ZONE 2: WHAT IS TRUE RIGHT NOW.
//
// Up to three of the active period's headline figures, on the resting
// surface, before a word is typed.
//
// ══ WHY A NUMBER BELONGS AT REST ══════════════════════════════════════
//
// The cheapest and most-used answer in this product is a LOOKUP: "what
// is revenue", "how much cash". Tier 0 already answers those in
// microseconds for free — but only after the reader has typed them. The
// surface knew the answer the whole time and made them ask.
//
// So the three it is most confident about sit at rest. Reading a number
// no longer requires typing, and the surface stops being a box that asks
// what you want and starts being one that tells you something.
//
// ══ THE THREE RULES THIS FILE CANNOT BEND ═════════════════════════════
//
// T1  ZERO MODEL SPEND, BY CONSTRUCTION. Every value here comes from the
//     `FactIndex` the host already built for Tier 0 — a synchronous,
//     in-memory structure. This file imports no client, dispatches
//     nothing, and has no effect that could. It renders identically with
//     credits down.
//
// T2  EVERY FIGURE THROUGH THE MONEY PATH. A `FactRef` carries a raw
//     `value` and a DECLARED unit. Money goes to `NarrativeText` with a
//     `{{money:…}}` template — the same renderer the prose and the
//     answer lane's figure list use, so one number never gets two
//     spellings on one screen. A dimensionless fact goes to `<Amount>`
//     with its own kind. There is no branch here that formats a number
//     itself and none that infers a unit from a magnitude.
//
// T3  FEWER, NOT FILLER. `restingFacts` returns what the period carries
//     and no more. Two facts render two tiles; none renders NOTHING —
//     not a skeleton, not a dash, not a zero. ABSENT IS NOT ZERO, and a
//     placeholder tile is the same lie as a fabricated figure with the
//     digits taken out.
//
// ══ NO COUNTING UP ════════════════════════════════════════════════════
//
// The tiles settle once. There is no animation on the VALUE — a number
// that ticks upward on open is a number the reader cannot read for the
// duration of the tick, on a surface whose entire claim is that the
// answer is already there. The only motion on this zone is the panel's
// own morph, which it inherits.

import { useTranslation } from "react-i18next";

import { Amount } from "@/components/instrument/Amount";
import { ProvenanceAffordance } from "@/components/instrument/Provenance";
import { formatMoneyFrom } from "@/lib/money";
import { NarrativeText } from "@/lib/narrativeMoney";
import type { Currency, Rates } from "@/lib/rates";
import {
  amountKindFor,
  amountProvenanceFor,
  type FactRef,
} from "@/lib/capsuleFactIndex";
import { FACT_TO_SOURCE } from "@/lib/linkifyAlertBody";
import type { TraceableSource } from "@/lib/traceableSource";

import "./capsuleEmptyI18n";
import { metricLabel } from "../capsuleAnswer/capsuleAnswerI18n";
import "../capsuleAnswer/capsuleAnswerI18n";

/** Three across at 1440, and three is the cap everywhere — the fourth
 *  tile is where a brief turns back into a dashboard. */
export const MAX_FACT_TILES = 3;

// ── metric → statement row ─────────────────────────────────────────────
//
// The provenance dot only appears when the fact maps to a statement row
// we can actually open. Same rule the answer lane's dot applies, and the
// same reason: a dot with nowhere to go is trust chrome with nothing
// behind it. The table mirrors `CapsuleFigures.METRIC_SOURCE` because the
// capsule tool vocabulary and the app's fact vocabulary name two things
// slightly differently (`net_result` vs `net_profit`), and a tile and a
// figure row must not disagree about where one number lives.
const METRIC_SOURCE: Readonly<Record<string, TraceableSource>> = Object.freeze({
  total_assets: { statement: "bs", bucket: "totalAssets" },
  total_liabilities: { statement: "bs", bucket: "totalLiabilities" },
  equity: { statement: "bs", bucket: "totalEquity" },
  current_assets: { statement: "bs", bucket: "totalCurrentAssets" },
  current_liabilities: { statement: "bs", bucket: "totalCurrentLiabilities" },
  working_capital: { statement: "bs", bucket: "workingCapital" },
  net_result: { statement: "pl", bucket: "netIncomeOperational" },
  revenue: { statement: "pl", bucket: "revenue" },
  expenses: { statement: "pl", bucket: "operatingExpenses" },
  ebitda: { statement: "pl", bucket: "ebitda" },
});

/** Where this fact lives, or null when we cannot say. Null is a refusal,
 *  not a fallback. */
export function sourceForFactKey(factKey: string): TraceableSource | null {
  const base = factKey.replace(/^bs\.row\./, "");
  return METRIC_SOURCE[factKey] ?? FACT_TO_SOURCE[factKey] ?? METRIC_SOURCE[base] ?? null;
}

/** One fact, rendered through whichever path its DECLARED unit names. */
export function FactTileValue({
  fact,
  className,
}: {
  fact: FactRef;
  className?: string;
}) {
  const provenance = amountProvenanceFor(fact);
  if (fact.unit !== "money") {
    return (
      <Amount
        value={fact.value}
        kind={amountKindFor(fact.unit)}
        provenance={provenance ?? undefined}
        className={className}
      />
    );
  }
  // MONEY GETS THE SAME AFFORDANCE, by wrapping rather than re-rendering.
  //
  // Money cannot go through `<Amount>` here — `NarrativeText` is the only
  // path that owns the display-currency decision, and a tile spelling a
  // number differently from the prose beside it reads as a disagreement
  // about the number. So the affordance wraps the money renderer.
  //
  // Until 2026-09-02 this branch returned bare, so a MONEY tile — the
  // common case — carried no affordance while its percent sibling six
  // lines up did. The e2e law "every numeral in a tile sits under
  // [data-provenance]" (capsule-brief N4) had no money tile to fail on
  // because tiles were not rendering at all on the measured host.
  const currency = (fact.currency ?? "RON") as Currency;
  return (
    <ProvenanceAffordance provenance={provenance} className={className}>
      <NarrativeText
        // The NATIVE spelling is the fallback the renderer falls back TO
        // when no rate exists, so it has to already be the right one.
        text={formatMoneyFrom(fact.value, currency, currency, {} as Rates, { fractionDigits: 2 })}
        template={`{{money:${fact.factKey}}}`}
        facts={{ [fact.factKey]: fact.value }}
        factUnits={{ [fact.factKey]: "money" }}
        sourceCurrency={currency}
      />
    </ProvenanceAffordance>
  );
}

export interface CapsuleFactTilesProps {
  facts: readonly FactRef[];
  /** Open the statement row a tile names. Omitted, no dot renders —
   *  which is the correct outcome, not a degraded one. */
  onJump?: (source: TraceableSource) => void;
  /** Put this fact's own question in the composer. A tile is a fact AND
   *  a way to ask about it; picking one never sends. */
  onPick?: (fact: FactRef) => void;
}

/**
 * The tile row. Three across at 1440, stacked at 390.
 *
 * `grid-cols-1 sm:grid-cols-3` rather than a flex wrap: with three
 * equal-width columns a two-fact period gets two half-width tiles
 * instead of one wide one and one narrow one, and the numbers stay on
 * the same left edges between openings.
 */
export function CapsuleFactTiles({ facts, onJump, onPick }: CapsuleFactTilesProps) {
  const { t } = useTranslation();
  const shown = facts.slice(0, MAX_FACT_TILES);
  // T3. No heading, no skeleton, no empty row — the zone is simply not
  // there when the period carries nothing to put in it.
  if (shown.length === 0) return null;

  return (
    <div data-testid="capsule-fact-tiles" className="px-3.5 pb-0.5 pt-2">
      <ul
        className={`grid gap-2 ${
          shown.length === 1 ? "grid-cols-1" : shown.length === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3"
        }`}
      >
        {shown.map((fact) => {
          const source = sourceForFactKey(fact.factKey);
          const label = metricLabel(t, fact.factKey, fact.label);
          return (
            <li key={`${fact.factKey}:${fact.periodId}`}>
              <div
                data-testid="capsule-fact-tile"
                // C3 walks the DOM for an ancestor that names the fact —
                // a dimensionless figure renders as a bare span, so the
                // NAME has to live on a box above it.
                data-fact={fact.factKey}
                data-unit={fact.unit}
                className="
                  flex h-full flex-col justify-between gap-1
                  rounded-[10px] border border-rule bg-bg-2/40 px-2.5 py-2
                "
              >
                <div className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-[10px] font-medium uppercase tracking-[0.12em] text-ink-soft">
                    {label}
                  </span>
                  {/* The dot renders only where it can navigate. */}
                  {source && onJump && (
                    <button
                      type="button"
                      onClick={() => onJump(source)}
                      // NO `title`. This surface bans native tooltips —
                      // see CapsuleTooltipGuard.
                      aria-label={t("capsuleEmpty.tile.provenanceJump", { metric: label })}
                      data-testid="capsule-provenance-dot"
                      data-traceable-source-statement={source.statement}
                      data-traceable-source-bucket={source.bucket}
                      className="
                        inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full
                        text-ink-soft transition-colors duration-micro
                        hover:text-brand-d dark:hover:text-brand-l
                        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                      "
                    >
                      <span className="block h-[5px] w-[5px] rounded-full bg-current" aria-hidden />
                    </button>
                  )}
                </div>
                {onPick ? (
                  <button
                    type="button"
                    data-testid="capsule-fact-tile-ask"
                    onClick={() => onPick(fact)}
                    aria-label={t("capsuleEmpty.tile.ask", { metric: label })}
                    className="
                      -mx-1 rounded-[8px] px-1 py-0.5 text-left
                      transition-colors duration-micro hover:bg-bg-2/70
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                    "
                  >
                    <FactTileValue fact={fact} className="text-[15px] leading-none text-ink" />
                  </button>
                ) : (
                  <FactTileValue fact={fact} className="text-[15px] leading-none text-ink" />
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
