// THE CAPSULE — figures, provenance dots and the two mini-visuals.
//
// Every number on the answer surface is rendered here, and every one of
// them comes from `evidence.factMeta` — the typed values the retrieval
// step returned. There is no path in this file that accepts a string
// from the model.
//
// THE CONVERSION BOUNDARY. A money figure is shown in the reader's
// display currency, and the decision about whether that is even possible
// is delegated to `resolveMoneyDisplay` — the same resolver
// `NarrativeText` uses for prose. That is deliberate: if the prose says
// a figure and the figure list repeats it, the two must agree on
// currency, rate and rounding, and the only way to guarantee that is for
// both to ask the same function. When no rate exists the resolver says
// so, and the figure renders NATIVE with its own currency label and the
// reason in the tooltip — never silently mixed in beside converted
// siblings.
//
// THE PROVENANCE DOT. Rendered only when the fact's metric maps to a
// statement row we can actually navigate to. A dot with nowhere to go is
// trust chrome with nothing behind it, so it simply does not appear —
// the same rule `<Amount>` applies to its own provenance affordance.

import { useTranslation } from "react-i18next";

import { Amount, type AmountProvenance } from "@/components/instrument/Amount";
import { ProvenanceAffordance, hasProvenance } from "@/components/instrument/Provenance";
import { FACT_TO_SOURCE } from "@/lib/linkifyAlertBody";
import { formatMoneyFrom } from "@/lib/money";
import { NarrativeText } from "@/lib/narrativeMoney";
import type { Currency, Rates } from "@/lib/rates";
import type { TraceableSource } from "@/lib/traceableSource";

import "./capsuleAnswerI18n";
import { metricLabel } from "./capsuleAnswerI18n";
import type { CapsuleEvidence, CapsuleFactMeta } from "./capsuleAnswerTypes";
import {
  sparkGeometry,
  type CapsuleComparisonVisual,
  type CapsuleSparklineVisual,
  type CapsuleVisual,
} from "./capsuleAnswerVisuals";

// ── metric → statement row ─────────────────────────────────────────────
//
// `FACT_TO_SOURCE` is the app's map from ENGINE FACT NAME to a statement
// row. The capsule tool layer names its metrics slightly differently
// (`net_result`, not `net_profit`), so this table bridges the two
// vocabularies. It maps to buckets that already exist in
// `traceableSource.ts` — nothing here invents a destination.
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
 *  not a fallback: an unnavigable dot is worse than no dot. */
function sourceForFact(meta: CapsuleFactMeta): TraceableSource | null {
  const base = meta.fact.replace(/__\d+$/, "").replace(/_(a|b|delta)$/, "");
  return (
    METRIC_SOURCE[meta.metric] ??
    FACT_TO_SOURCE[meta.metric] ??
    METRIC_SOURCE[base] ??
    FACT_TO_SOURCE[base] ??
    null
  );
}

/** What a tool-produced fact can honestly say about itself.
 *
 *  A `CapsuleFactMeta` carries a period, a snapshot id and the TOOL that
 *  produced it. It does NOT carry a sheet, a cell or an account code —
 *  the retrieval layer does not thread those through — so this builds no
 *  `source` and no `accounts`. Naming a source it does not have would be
 *  the CapsuleTier0Preview defect again.
 *
 *  It used to write the PERIOD LABEL into `source`, which the card
 *  renders under a "Source" heading. The period now has its own field
 *  and the tool goes to `method`, which is what it is: how the figure
 *  was obtained. `period` alone does not buy the affordance (see
 *  `hasProvenance`), so a fact with no snapshot and no tool renders
 *  plain — correctly. */
function provenanceFor(meta: CapsuleFactMeta): AmountProvenance | null {
  const p: AmountProvenance = {};
  const period = meta.periodLabel || meta.scope || "";
  if (period) p.period = period;
  if (meta.tool) p.method = meta.tool;
  if (meta.snapshotId) p.snapshot = meta.snapshotId;
  // `hasProvenance` refuses a payload with no substance and the figure
  // renders without the affordance — the correct outcome, so no
  // defaulting and no placeholder.
  return hasProvenance(p) ? p : null;
}

// ── the value ──────────────────────────────────────────────────────────

export function FigureValue({
  meta,
  evidence,
  className,
}: {
  meta: CapsuleFactMeta;
  evidence: CapsuleEvidence;
  className?: string;
}) {
  const provenance = provenanceFor(meta);

  if (meta.unit !== "money") {
    // Dimensionless: never converted, never currency-labelled (rule 3 of
    // narrativeMoney's contract). `<Amount>` is the right renderer here —
    // it knows how to print a ratio, a percent and a day count, which
    // the money path deliberately does not.
    const kind = meta.unit === "percent" ? "percent" : meta.unit === "ratio" ? "multiple" : "count";
    return (
      <Amount
        value={meta.value}
        kind={kind}
        provenance={provenance}
        className={className}
      />
    );
  }

  // MONEY GOES THROUGH THE SAME RENDERER AS THE PROSE.
  //
  // This list is a receipt for the sentence above it, so the two must
  // agree to the last separator. They cannot if they are formatted by
  // two different rules — and they are: `money.ts` formats by the
  // CURRENCY's locale (a RON figure is "413.727.560,00 RON" whatever the
  // UI language), while `<Amount>` formats by the ACTIVE UI locale
  // ("413,727,560 RON" in English). One number, one panel, two spellings
  // reads as a disagreement about the number itself.
  //
  // So a money row renders the identical `{{money:FACT}}` placeholder the
  // prose does. Conversion, the missing-rate refusal, the provenance
  // title and the source-row link all come from the one path; the
  // provenance DOT beside it is this surface's own addition.
  //
  // The affordance WRAPS that renderer rather than replacing it, so a
  // money figure and its dimensionless sibling in the same list open the
  // same card. Underline off: the money span inside already draws its
  // own dotted rule when a conversion was refused, and two dotted rules
  // on one number reads as a defect rather than as two disclosures.
  const native = (meta.currency ?? evidence.currency ?? "RON") as Currency;
  return (
    <ProvenanceAffordance provenance={provenance} className={className} underline={false}>
      <NarrativeText
        text={formatMoneyFrom(meta.value, native, native, {} as Rates, { fractionDigits: 2 })}
        template={`{{money:${meta.fact}}}`}
        facts={evidence.facts}
        factUnits={evidence.factUnits}
        sourceCurrency={native}
      />
    </ProvenanceAffordance>
  );
}

// ── the provenance dot ─────────────────────────────────────────────────

export function ProvenanceDot({
  meta,
  onJump,
}: {
  meta: CapsuleFactMeta;
  onJump: (source: TraceableSource) => void;
}) {
  const { t } = useTranslation();
  const source = sourceForFact(meta);
  if (!source) return null;
  const label = t("capsuleAnswer.provenanceJump");
  return (
    <button
      type="button"
      onClick={() => onJump(source)}
      // NO `title`. THIS is the one that grew: a provenance dot rides
      // every figure, so an answered turn carried three native tooltips
      // and a follow-up carried six — the count climbs with the
      // conversation. A defect that gets worse the longer the reader
      // stays is worse than the static one that was reported.
      aria-label={label}
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
  );
}

// ── the figure list ────────────────────────────────────────────────────

export function FigureRow({
  meta,
  evidence,
  onJump,
}: {
  meta: CapsuleFactMeta;
  evidence: CapsuleEvidence;
  onJump: (source: TraceableSource) => void;
}) {
  const { t } = useTranslation();
  const label = metricLabel(t, meta.metric, meta.scope || meta.fact);
  return (
    <li className="flex items-baseline gap-2 py-1" data-testid="capsule-figure-row">
      <span className="min-w-0 flex-1 truncate text-[12px] text-ink-soft">
        {label}
        {meta.periodLabel && (
          <span className="text-ink-soft"> · {meta.periodLabel}</span>
        )}
      </span>
      <FigureValue meta={meta} evidence={evidence} className="text-[12.5px] text-ink" />
      <span className="self-center">
        <ProvenanceDot meta={meta} onJump={onJump} />
      </span>
    </li>
  );
}

export function FigureList({
  facts,
  evidence,
  onJump,
}: {
  facts: readonly string[];
  evidence: CapsuleEvidence;
  onJump: (source: TraceableSource) => void;
}) {
  const rows = facts
    .map((f) => evidence.factMeta[f])
    .filter((m): m is CapsuleFactMeta => Boolean(m));
  if (rows.length === 0) return null;
  return (
    <ul className="mt-2 divide-y divide-rule-soft border-t border-rule-soft" data-testid="capsule-figures">
      {rows.map((meta) => (
        <FigureRow key={meta.fact} meta={meta} evidence={evidence} onJump={onJump} />
      ))}
    </ul>
  );
}

// ── mini-visual: the comparison ────────────────────────────────────────

export function DeltaChip({
  meta,
  evidence,
  direction,
}: {
  meta: CapsuleFactMeta;
  evidence: CapsuleEvidence;
  direction: "up" | "down" | "flat";
}) {
  const { t } = useTranslation();
  const tone =
    direction === "up"
      ? "text-success"
      : direction === "down"
      ? "text-alert"
      : "text-ink-soft";
  const arrow = direction === "up" ? "\u25B2" : direction === "down" ? "\u25BC" : "\u2013";
  return (
    <span
      data-testid="capsule-delta-chip"
      className={`inline-flex items-center gap-1 rounded-sm border border-rule bg-bg-2 px-1.5 py-0.5 ${tone}`}
    >
      <span aria-hidden className="text-[9px] leading-none">{arrow}</span>
      <span className="sr-only">{t(`capsuleAnswer.visual.${direction}`)}</span>
      <FigureValue meta={meta} evidence={evidence} className="text-[11.5px]" />
    </span>
  );
}

export function ComparisonVisual({
  visual,
  evidence,
  onJump,
}: {
  visual: CapsuleComparisonVisual;
  evidence: CapsuleEvidence;
  onJump: (source: TraceableSource) => void;
}) {
  const { t } = useTranslation();
  const a = evidence.factMeta[visual.factA];
  const b = evidence.factMeta[visual.factB];
  const delta = visual.factDelta ? evidence.factMeta[visual.factDelta] : null;
  if (!a || !b) return null;
  const heading = t("capsuleAnswer.visual.comparison", {
    metric: metricLabel(t, visual.metric, visual.metric),
    from: visual.labelA,
    to: visual.labelB,
  });
  return (
    <div
      className="mt-2 rounded-sm border border-rule-soft bg-bg-2/40 px-3 py-2"
      data-testid="capsule-comparison"
    >
      <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-soft">
        {heading}
      </div>
      <table className="w-full">
        <tbody>
          <tr>
            <td className="py-0.5 text-[12px] text-ink-soft">{visual.labelA}</td>
            <td className="py-0.5 text-right">
              <FigureValue meta={a} evidence={evidence} className="text-[12.5px] text-ink" />
            </td>
            <td className="w-5 py-0.5 text-right">
              <ProvenanceDot meta={a} onJump={onJump} />
            </td>
          </tr>
          <tr>
            <td className="py-0.5 text-[12px] text-ink-soft">{visual.labelB}</td>
            <td className="py-0.5 text-right">
              <FigureValue meta={b} evidence={evidence} className="text-[12.5px] text-ink" />
            </td>
            <td className="w-5 py-0.5 text-right">
              <ProvenanceDot meta={b} onJump={onJump} />
            </td>
          </tr>
          {delta && (
            <tr className="border-t border-rule-soft">
              <td className="pt-1 text-[12px] text-ink-soft">
                {t("capsuleAnswer.visual.change")}
              </td>
              <td className="pt-1 text-right" colSpan={2}>
                <DeltaChip meta={delta} evidence={evidence} direction={visual.direction} />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── mini-visual: the sparkline ─────────────────────────────────────────

export function SparklineVisual({
  visual,
  evidence,
  onJump,
}: {
  visual: CapsuleSparklineVisual;
  evidence: CapsuleEvidence;
  onJump: (source: TraceableSource) => void;
}) {
  const { t } = useTranslation();
  const geo = sparkGeometry(visual.points.map((p) => p.value));
  const last = visual.points[visual.points.length - 1];
  const lastMeta = evidence.factMeta[last?.fact ?? ""];
  const heading = t("capsuleAnswer.visual.trend", {
    metric: metricLabel(t, visual.metric, visual.metric),
  });
  return (
    <div
      className="mt-2 flex items-center gap-3 rounded-sm border border-rule-soft bg-bg-2/40 px-3 py-2"
      data-testid="capsule-sparkline"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[10px] font-medium uppercase tracking-[0.14em] text-ink-soft">
          {heading}
        </div>
        <div className="mt-0.5 flex items-baseline gap-2">
          {lastMeta && (
            <FigureValue meta={lastMeta} evidence={evidence} className="text-[13px] text-ink" />
          )}
          <span className="truncate text-[11px] text-ink-soft">{last?.label}</span>
          {lastMeta && <ProvenanceDot meta={lastMeta} onJump={onJump} />}
        </div>
      </div>
      <svg
        width={72}
        height={20}
        viewBox="0 0 72 20"
        role="img"
        aria-label={heading}
        className="shrink-0 text-brand-d dark:text-brand-l"
      >
        <path
          d={geo.path}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {geo.points.length > 0 && (
          <circle
            cx={geo.points[geo.points.length - 1].x}
            cy={geo.points[geo.points.length - 1].y}
            r={1.75}
            fill="currentColor"
          />
        )}
      </svg>
    </div>
  );
}

export function CapsuleVisuals({
  visuals,
  evidence,
  onJump,
}: {
  visuals: readonly CapsuleVisual[];
  evidence: CapsuleEvidence;
  onJump: (source: TraceableSource) => void;
}) {
  if (visuals.length === 0) return null;
  return (
    <>
      {visuals.map((v) =>
        v.kind === "sparkline" ? (
          <SparklineVisual key={v.id} visual={v} evidence={evidence} onJump={onJump} />
        ) : (
          <ComparisonVisual key={v.id} visual={v} evidence={evidence} onJump={onJump} />
        ),
      )}
    </>
  );
}
