// EVIDENCE — the cited figures, where they came from, and what they were
// measured against.
//
// The baseline's failure here was subtle: the 461 note DID carry two
// correct figures, so a naive audit passed it. What it never carried was
// the ORIGIN of those figures or the basis of the comparison, which is
// why a reader could not check it and a lender could not use it. So this
// component renders three things that used to be one:
//
//   figures    every cited number, by its declared unit, labelled with
//              the engine's own words
//   provenance a dot per origin component — period, snapshot, line refs,
//              source. A FILLED dot is a component the payload actually
//              carries; a HOLLOW ring is one it does not. Absent is drawn
//              differently from present, never omitted, because "no
//              snapshot id" is information about how much to trust this.
//   basis      the comparison basis the detector declared, in its own
//              words, with the kind named.

import { useTranslation } from "react-i18next";

import type { Currency } from "@/lib/rates";
import type { FindingEvidence } from "@/lib/findings";

import { Chip, ElementLabel, FigureCell, findingProvenance } from "./parts";
import "./findingsI18n";

function Dot({ filled, label }: { filled: boolean; label: string }) {
  return (
    <span
      title={label}
      aria-label={label}
      data-filled={filled ? "1" : "0"}
      className={
        filled
          ? "inline-block h-[6px] w-[6px] rounded-full bg-brand"
          : "inline-block h-[6px] w-[6px] rounded-full border border-ink-faint"
      }
    />
  );
}

export function ProvenanceDots({ evidence }: { evidence: FindingEvidence }) {
  const { t } = useTranslation();
  const p = evidence.provenance;
  const parts: Array<{ filled: boolean; label: string }> = [
    {
      filled: Boolean(p?.period_id),
      label: t("fnd.provPeriod", { id: p?.period_id ?? "—" }),
    },
    {
      filled: Boolean(p?.snapshot_id),
      label: t("fnd.provSnapshot", { id: p?.snapshot_id ?? "—" }),
    },
    {
      filled: Boolean(p?.line_refs.length),
      label: t("fnd.provLines", { refs: p?.line_refs.join(", ") || "—" }),
    },
    {
      filled: Boolean(p?.source),
      label: t("fnd.provSource", { source: p?.source ?? "—" }),
    },
  ];
  const full = parts.map((x) => x.label).join(" · ");
  return (
    <span
      className="inline-flex items-center gap-[3px] align-middle"
      title={`${t("fnd.provTitle")}: ${full}`}
      data-testid="fnd-provenance-dots"
    >
      {parts.map((x, i) => (
        <Dot key={i} filled={x.filled} label={x.label} />
      ))}
    </span>
  );
}

export function EvidenceLine({
  evidence,
  facts,
  factUnits,
  currency,
}: {
  evidence: FindingEvidence;
  facts: Record<string, number>;
  factUnits: Record<string, string>;
  currency: Currency;
}) {
  const { t } = useTranslation();
  const p = evidence.provenance;
  const provenanceText = [
    p?.period_id ? t("fnd.provPeriod", { id: p.period_id }) : null,
    p?.snapshot_id ? t("fnd.provSnapshot", { id: p.snapshot_id }) : null,
    p?.line_refs.length ? t("fnd.provLines", { refs: p.line_refs.join(", ") }) : null,
    p?.source ?? null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section data-testid="fnd-evidence">
      <ElementLabel className="flex items-center gap-2">
        <span>{t("fnd.evidence")}</span>
        <ProvenanceDots evidence={evidence} />
      </ElementLabel>

      <div className="mt-2 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-3">
        {evidence.figures.map((f) => (
          <FigureCell
            key={f.fact}
            figure={f}
            facts={facts}
            factUnits={factUnits}
            currency={currency}
            /* The finding's OWN provenance, on the figure it describes.
               Null when the payload carries none, and the figure then
               renders plain — the dots above still say, honestly, which
               components are missing. */
            provenance={findingProvenance(p)}
          />
        ))}
      </div>

      {evidence.comparison_basis ? (
        <p className="mt-3 text-[12.5px] leading-relaxed text-ink-soft">
          <span className="text-ink-mute">{t("fnd.basis")}: </span>
          {evidence.comparison_basis.description}{" "}
          <Chip tone="quiet">{evidence.comparison_basis.kind}</Chip>
        </p>
      ) : null}

      {provenanceText ? (
        <p className="mt-1.5 font-mono text-[10.5px] leading-relaxed text-ink-mute">
          {provenanceText}
        </p>
      ) : null}
    </section>
  );
}
