// IMPACT — the quantified consequence, and the "recompute without this"
// affordance built on top of it.
//
// `_finding.Impact` already holds BOTH numbers: `baseline` is the metric
// as reported, `adjusted` is the metric with this finding's subject
// removed or restated, and both quotients went through `_ratio_units`.
// So "recompute without this item" is not a calculation this screen
// performs — it is a READ of a number the engine computed and shipped.
// That distinction is the whole point of the standing law: the client
// may reveal a figure, never derive one. There is no arithmetic in this
// file; `delta` is displayed as sent.
//
// A money impact deliberately never prints its delta — see the note in
// `Impact.render`: the difference of two cited facts is not itself a
// cited fact, so it has no placeholder and would render as an
// unconvertible third figure beside two converted ones.

import { useTranslation } from "react-i18next";

import {
  ProvenanceAffordance,
  provenanceOf,
  type AmountProvenance,
} from "@/components/instrument/Provenance";
import type { Currency } from "@/lib/rates";
import { formatSignedDimensionless, type FindingImpact } from "@/lib/findings";

import { ElementLabel, FigureValue } from "./parts";
import "./findingsI18n";

// ── where the two endpoints come from ──────────────────────────────────
//
// Both were computed by the engine on the SAME snapshot the finding was
// measured against, from the facts it cites — so they carry the finding's
// provenance. But an impact is a PROJECTION, not a reading: the adjusted
// figure is the metric with this finding's subject removed, and nobody's
// trial balance contains it. `method` says so in as many words, so the
// card never implies the number was read from a sheet. Without the
// finding's provenance there is nothing to stand behind either endpoint,
// and both render plain — the visible Pro method line already names the
// kind and the metric.

export function impactProvenance(
  impact: Pick<FindingImpact, "kind" | "metric" | "baseline_fact" | "adjusted_fact">,
  finding: AmountProvenance | null | undefined,
  endpoint: "baseline" | "adjusted",
): AmountProvenance | null {
  if (!finding) return null;
  const fact = endpoint === "baseline" ? impact.baseline_fact : impact.adjusted_fact;
  const what =
    endpoint === "baseline"
      ? `${impact.kind} · baseline ${impact.metric}`
      : `${impact.kind} · projection — ${impact.metric} recomputed without this item`;
  return provenanceOf({
    ...finding,
    method: fact ? `${what} · fact ${fact}` : what,
  });
}

export function ImpactRow({
  impact,
  currency,
  facts,
  factUnits,
  recomputed,
  compact = false,
  showMethod = false,
  provenance = null,
}: {
  impact: FindingImpact;
  currency: Currency;
  facts: Record<string, number>;
  factUnits: Record<string, string>;
  /** True while the reader is holding the "without this item" view. */
  recomputed: boolean;
  compact?: boolean;
  /** Pro only: name the metric and the impact kind under the sentence. */
  showMethod?: boolean;
  /** The finding's own provenance (`findingProvenance`). Null → both
   *  endpoints render plain. */
  provenance?: AmountProvenance | null;
}) {
  const { t } = useTranslation();
  const isMoney = impact.unit === "money";
  const delta = isMoney
    ? null
    : formatSignedDimensionless(impact.delta, impact.unit, {
        daysWord: t("fnd.units.days"),
        pointsWord: t("fnd.units.points"),
      });

  const baseline = (
    <ProvenanceAffordance
      provenance={impactProvenance(impact, provenance, "baseline")}
      value={impact.baseline}
    >
      <FigureValue
        value={impact.baseline}
        unit={impact.unit}
        fact={impact.baseline_fact ?? undefined}
        facts={facts}
        factUnits={factUnits}
        currency={currency}
      />
    </ProvenanceAffordance>
  );
  const adjusted = (
    <ProvenanceAffordance
      provenance={impactProvenance(impact, provenance, "adjusted")}
      value={impact.adjusted}
    >
      <FigureValue
        value={impact.adjusted}
        unit={impact.unit}
        fact={impact.adjusted_fact ?? undefined}
        facts={facts}
        factUnits={factUnits}
        currency={currency}
      />
    </ProvenanceAffordance>
  );

  return (
    <section data-testid="fnd-impact" data-recomputed={recomputed ? "1" : "0"}>
      {compact ? null : <ElementLabel>{t("fnd.impact")}</ElementLabel>}
      <p
        className={`${compact ? "" : "mt-1.5"} text-[13px] leading-relaxed text-ink-soft`}
      >
        <span className="text-ink">{impact.metric_label}</span>{" "}
        <span
          className={
            recomputed
              ? "text-ink-mute line-through decoration-ink-faint"
              : "font-medium text-ink"
          }
        >
          {baseline}
        </span>
        <span className="mx-1 text-ink-mute">→</span>
        <span
          className={recomputed ? "font-medium text-brand-d" : "font-medium text-ink"}
        >
          {adjusted}
        </span>
        {delta ? (
          <span className="ml-1.5 whitespace-nowrap text-ink-mute">({delta})</span>
        ) : null}
      </p>
      {/* PRO — the method behind the recomputed figure: which metric was
          restated and how. The engine ships the endpoints, not the
          operands, so this states what it actually knows rather than
          reconstructing an equation it was not given. */}
      {showMethod ? (
        <p className="mt-1 font-mono text-[10px] leading-relaxed text-ink-mute">
          {impact.kind} · {impact.metric} · {impact.unit}
        </p>
      ) : null}
      {recomputed ? (
        <p className="mt-1 text-[11.5px] leading-relaxed text-ink-mute">
          {t("fnd.recomputeOn")} · {t("fnd.recomputeHint")}
        </p>
      ) : null}
    </section>
  );
}
