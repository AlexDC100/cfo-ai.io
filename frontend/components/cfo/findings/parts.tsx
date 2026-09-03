// The small pieces every findings surface reuses.
//
// One rule runs through all of them: A FIGURE IS RENDERED BY ITS
// DECLARED UNIT, and money is rendered by exactly one component. Money
// goes through `NarrativeText`, the only path that knows the display
// currency and the rate; everything dimensionless goes through
// `formatDimensionless`, which cannot emit a currency label at all. A
// figure whose unit the engine refused to declare renders as "—" — an
// undeclared unit is a refusal, not a licence to guess.

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  ProvenanceAffordance,
  provenanceOf,
  type AmountProvenance,
} from "@/components/instrument/Provenance";
import { NarrativeText } from "@/lib/narrativeMoney";
import type { Currency } from "@/lib/rates";
import {
  formatDimensionless,
  moneyTemplate,
  resolveMoneyFact,
  type FindingFigure,
  type FindingProvenance,
  type FindingSeverity,
  type FindingUnit,
} from "@/lib/findings";

import "./findingsI18n";

/** The dash used wherever a value is ABSENT. Never a zero. */
export const ABSENT = "—";

/** Placeholder name for a money figure that is not one of the cited
 *  facts (a check row's limit, say). It buys the figure the currency
 *  path, not provenance — `FACT_TO_SOURCE` has no entry for it, so it is
 *  never clickable and never claims a source row it does not have. */
const LOCAL_MONEY_FACT = "_fnd_local_money";

export function asCurrency(code: string | null | undefined): Currency {
  const up = (code ?? "RON").toUpperCase();
  return up === "EUR" || up === "USD" ? (up as Currency) : "RON";
}

// ── severity ────────────────────────────────────────────────────────────

export interface SeverityTone {
  dot: string;
  chip: string;
  rail: string;
  text: string;
}

const TONES: Record<FindingSeverity, SeverityTone> = {
  critical: {
    dot: "bg-alert",
    chip: "bg-alert-tint text-alert border-alert/30",
    rail: "bg-alert",
    text: "text-alert",
  },
  high: {
    dot: "bg-alert",
    chip: "bg-alert-tint text-alert border-alert/25",
    rail: "bg-alert/70",
    text: "text-alert",
  },
  medium: {
    dot: "bg-caution",
    chip: "bg-caution-tint text-caution border-caution/30",
    rail: "bg-caution",
    text: "text-caution",
  },
  low: {
    dot: "bg-info",
    chip: "bg-info-tint text-info border-info/30",
    rail: "bg-info/70",
    text: "text-info",
  },
  info: {
    dot: "bg-ink-mute",
    chip: "bg-bg-2 text-ink-soft border-rule",
    rail: "bg-ink-faint",
    text: "text-ink-soft",
  },
};

export function toneFor(severity: FindingSeverity): SeverityTone {
  return TONES[severity] ?? TONES.info;
}

// ── labels ──────────────────────────────────────────────────────────────

/** The 11px mono caps label that names a contract element. Every element
 *  on a card carries one, so a reader can see which of the seven they
 *  are looking at without being told the rule exists. */
export function ElementLabel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`font-mono text-[10px] uppercase tracking-[0.16em] text-ink-mute ${className}`}
    >
      {children}
    </div>
  );
}

export function Chip({
  children,
  tone = "quiet",
  title,
  className = "",
}: {
  children: ReactNode;
  tone?: "quiet" | "brand" | "alert" | "caution" | "info";
  title?: string;
  className?: string;
}) {
  const tones: Record<string, string> = {
    quiet: "bg-bg-2 text-ink-soft border-rule",
    brand: "bg-brand-tint text-brand-d border-brand-l/40",
    alert: "bg-alert-tint text-alert border-alert/30",
    caution: "bg-caution-tint text-caution border-caution/30",
    info: "bg-info-tint text-info border-info/30",
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-[1px] font-mono text-[10px] uppercase tracking-[0.12em] ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

// ── figures ─────────────────────────────────────────────────────────────

interface FigureValueProps {
  value: number | null | undefined;
  unit: FindingUnit;
  /** Only consulted for a MONEY unit — the fact name whose placeholder
   *  routes this number through the currency path. */
  fact?: string;
  facts?: Record<string, number>;
  factUnits?: Record<string, string>;
  currency: Currency;
  className?: string;
}

/**
 * One number, rendered by its declared unit.
 *
 * MONEY → `NarrativeText` with a one-token template. That is not
 * ceremony: it is the only way the figure participates in the same
 * conversion decision as every other money figure on the card, which is
 * what stops a card from showing RON and EUR inside one claim.
 *
 * DIMENSIONLESS → formatted locally and never converted.
 * UNDECLARED → the absent dash.
 */
export function FigureValue({
  value,
  unit,
  fact,
  facts,
  factUnits,
  currency,
  className = "",
}: FigureValueProps) {
  const { t } = useTranslation();
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return <span className={`text-ink-mute ${className}`}>{ABSENT}</span>;
  }
  if (unit === "money") {
    // A threshold limit, an impact endpoint or an "All checks" row
    // arrives without a fact name. Resolve WHICH cited fact it is when
    // one matches — that also earns the figure its click-to-source — and
    // otherwise bind it to a local one-entry map. Either way the number
    // travels the SAME money path as every other figure in the claim,
    // which is the invariant: never a raw digit beside a raw currency
    // word while its sibling converts (the Critical-461 defect).
    const resolved = fact ?? resolveMoneyFact(value, facts, factUnits);
    const named = resolved ?? LOCAL_MONEY_FACT;
    const boundFacts = resolved ? facts : undefined;
    const native = `${currency} ${new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 0,
    }).format(value)}`;
    return (
      <span className={`tabular-nums ${className}`}>
        <NarrativeText
          text={native}
          template={moneyTemplate(named)}
          facts={boundFacts ?? { [named]: value }}
          factUnits={boundFacts ? factUnits : { [named]: "money" }}
          sourceCurrency={currency}
        />
      </span>
    );
  }
  const text = formatDimensionless(value, unit, { daysWord: t("fnd.units.days") });
  if (text === null) {
    return <span className={`text-ink-mute ${className}`}>{ABSENT}</span>;
  }
  return <span className={`tabular-nums ${className}`}>{text}</span>;
}

/**
 * A finding's own provenance, mapped onto the shared affordance payload.
 *
 * ONE FIELD PER KIND OF CLAIM, and every one of these is checkable:
 *   source      the detector's declared origin
 *   line_refs   the statement lines the finding cites — the account-level
 *               anchor, so it goes in `accounts`, not folded into source
 *   snapshot_id the served envelope this was measured against
 *   period_id   which period; on its own it never earns the affordance
 *
 * Returns null when the finding carries no provenance, and the figure
 * then renders exactly as it did before — plain.
 */
export function findingProvenance(
  p: FindingProvenance | null | undefined,
): AmountProvenance | null {
  if (!p) return null;
  return provenanceOf({
    source: p.source,
    accounts: p.line_refs.join(", "),
    period: p.period_id,
    snapshot: p.snapshot_id ?? undefined,
  });
}

/** A cited figure: its engine-authored label above its value.
 *
 *  The evidence section already paints provenance DOTS and a provenance
 *  LINE for the finding as a whole. What it could not do was attach that
 *  origin to the individual figure a reader is looking at, which is where
 *  the question actually gets asked ("where did THAT number come from?").
 *  The affordance closes that, and only when the payload carries one. */
export function FigureCell({
  figure,
  facts,
  factUnits,
  currency,
  provenance,
}: {
  figure: FindingFigure;
  facts: Record<string, number>;
  factUnits: Record<string, string>;
  currency: Currency;
  /** The finding's own provenance. Omitted → no affordance. */
  provenance?: AmountProvenance | null;
}) {
  return (
    <div className="min-w-0" data-testid={`fnd-figure-${figure.fact}`}>
      {/* The engine authored this label; let it wrap rather than clipping
          it — "related-party balance on 4…" costs the reader the account
          number, which is the part that makes the figure checkable. */}
      <div className="text-[11px] leading-tight text-ink-mute" title={figure.label}>
        {figure.label}
      </div>
      <div className="mt-0.5 text-[14px] font-medium leading-tight text-ink">
        <ProvenanceAffordance provenance={provenance}>
          <FigureValue
            value={figure.value}
            unit={figure.unit}
            fact={figure.fact}
            facts={facts}
            factUnits={factUnits}
            currency={currency}
          />
        </ProvenanceAffordance>
      </div>
    </div>
  );
}
