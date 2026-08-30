// THRESHOLD — the rule, stated.
//
// The measured baseline fired eleven rules and never once told the reader
// what the rule WAS. Four out of five findings therefore read as an
// opinion about a number rather than a test the number failed. This
// component puts the test on the page: the parameter, the comparator, the
// limit, the observed value, and the file the parameter came from.
//
// The bar is drawn only when it can be drawn HONESTLY — both endpoints
// finite, non-negative, and a positive span. Outside that (a limit of
// zero, a negative equity ratio, an absent observation) the sentence
// renders alone. A meter that has to invent a scale to look like a meter
// is a picture of a number that does not exist.

import { useTranslation } from "react-i18next";

import type { Currency } from "@/lib/rates";
import type { FindingThreshold } from "@/lib/findings";

import { ElementLabel, FigureValue, toneFor } from "./parts";
import type { FindingSeverity } from "@/lib/findings";
import "./findingsI18n";

const COMPARATOR_KEY: Record<string, string> = {
  ">": "fnd.cmp.gt",
  ">=": "fnd.cmp.gte",
  "<": "fnd.cmp.lt",
  "<=": "fnd.cmp.lte",
  "!=": "fnd.cmp.ne",
};

export function comparatorWord(comparator: string, t: (k: string) => string): string {
  const key = COMPARATOR_KEY[comparator];
  return key ? t(key) : comparator;
}

/** Where the two ticks sit, or null when no honest scale exists. */
export function meterGeometry(
  limit: number | null,
  observed: number | null,
): { limitPct: number; observedPct: number; breached: boolean } | null {
  if (limit === null || observed === null) return null;
  if (!Number.isFinite(limit) || !Number.isFinite(observed)) return null;
  if (limit < 0 || observed < 0) return null;
  const span = Math.max(limit, observed) * 1.25;
  if (!(span > 0)) return null;
  return {
    limitPct: (limit / span) * 100,
    observedPct: (observed / span) * 100,
    breached: observed > limit,
  };
}

export function ThresholdMeter({
  threshold,
  severity,
  currency,
  facts,
  factUnits,
  showSource = true,
}: {
  threshold: FindingThreshold;
  severity: FindingSeverity;
  currency: Currency;
  facts: Record<string, number>;
  factUnits: Record<string, string>;
  showSource?: boolean;
}) {
  const { t } = useTranslation();
  const tone = toneFor(severity);
  const geo = meterGeometry(threshold.limit, threshold.observed);

  return (
    <section data-testid="fnd-threshold">
      <ElementLabel>{t("fnd.threshold")}</ElementLabel>

      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
        {t("fnd.thresholdLead", {
          rule: threshold.rule_id,
          parameter: threshold.parameter_label,
          comparator: comparatorWord(threshold.comparator, t),
        })}{" "}
        <span className="font-medium text-ink">
          <FigureValue
            value={threshold.limit}
            unit={threshold.unit}
            facts={facts}
            factUnits={factUnits}
            currency={currency}
          />
        </span>
        {". "}
        <span className="text-ink-mute">{t("fnd.observedLead")} </span>
        <span className={`font-medium ${tone.text}`}>
          <FigureValue
            value={threshold.observed}
            unit={threshold.unit}
            facts={facts}
            factUnits={factUnits}
            currency={currency}
          />
        </span>
        .
      </p>

      {geo ? (
        <div className="mt-3" aria-hidden="true">
          <div className="relative h-[6px] rounded-full bg-bg-2">
            {/* 0 → limit: the range the rule allows */}
            <div
              className="absolute top-0 h-[6px] rounded-l-full bg-ink-faint"
              style={{ left: 0, width: `${geo.limitPct}%` }}
            />
            {/* limit → observed: the breach itself */}
            <div
              className={`absolute top-0 h-[6px] ${tone.rail}`}
              style={{
                left: `${Math.min(geo.limitPct, geo.observedPct)}%`,
                width: `${Math.abs(geo.observedPct - geo.limitPct)}%`,
              }}
            />
            <div
              className="absolute -top-[3px] h-[12px] w-[2px] rounded bg-ink-soft"
              style={{ left: `${geo.limitPct}%` }}
            />
            <div
              className={`absolute -top-[4px] h-[14px] w-[3px] rounded ${tone.rail}`}
              style={{ left: `${geo.observedPct}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-mute">
            <span>{t("fnd.limitTick")}</span>
            <span>{t("fnd.observedLead")}</span>
          </div>
        </div>
      ) : null}

      {/* One line, never a three-line wrap of a dotted path. The whole
          pointer stays available on hover — it is provenance, not prose. */}
      {showSource && threshold.source ? (
        <p
          className="mt-2 truncate font-mono text-[10px] leading-relaxed text-ink-mute"
          title={threshold.source}
        >
          {t("fnd.thresholdSource", { source: threshold.source })}
        </p>
      ) : null}
    </section>
  );
}
