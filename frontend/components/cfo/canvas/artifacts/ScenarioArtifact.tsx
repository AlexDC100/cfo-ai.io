// THE ARTIFACTS — 6/8 SCENARIO. Drivers as sliders.
//
// The interesting question on this card is not "does the slider move" —
// it is "who computed the number it landed on". `artifactScenario`
// answers that in three parts, and this component's whole job is to make
// the third part visible:
//
//   1. the model authored no arithmetic (there is no formula field in
//      the spec schema);
//   2. the formulas are transcriptions of the engine's own native-unit
//      derivations, with the engine's own refusals;
//   3. BASELINE PARITY IS ASSERTED. Every lever starts at rest, every
//      output is recomputed at rest, and the result is compared against
//      the ENGINE'S OWN value. Agreement is the licence to project.
//
// When parity fails, the card does NOT quietly show its own numbers. It
// says the transcription does not reproduce the engine at rest and
// withholds the projection, because a curve that starts from a number
// the engine disagrees with is wrong everywhere along its length, and
// the reader has no way to see that from the shape.
//
// `unverifiable` is reported as its own state and never folded into
// "exact": the engine publishing no value for a metric is "nothing was
// checked", which must not look like "checked and clean" (TC-9).

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";

import { Amount } from "@/components/instrument/Amount";

import "./artifactI18n";
import { amountKindFor } from "./ArtifactFigure";
import { artifactLabel } from "./artifactI18n";
import type { ScenarioSpec } from "./artifactSpec";
import {
  AT_REST,
  DRIVERS,
  driverDef,
  evaluateScenario,
  restPositions,
  spanFor,
  type OutputReading,
} from "./artifactScenario";
import { citationFrom, type ResolvedArtifact } from "./artifactResolve";
import type { CapsuleEvidence } from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerTypes";

/** A scenario figure is DERIVED, not served, so it carries `data-fact`
 *  naming the registry output that produced it plus `data-derived`
 *  saying so. Both matter: the DOM law needs to see where a digit came
 *  from, and a reader inspecting the page must be able to tell a
 *  recomputation apart from a gateway fact. */
function ScenarioValue({
  value,
  reading,
  className,
}: {
  value: number | null;
  reading: OutputReading;
  className: string;
}) {
  return (
    <span data-fact={reading.id} data-unit={reading.unit} data-derived="scenario">
      <Amount value={value} kind={amountKindFor(reading.unit)} className={className} />
    </span>
  );
}

function OutputRow({ reading }: { reading: OutputReading }) {
  const { t } = useTranslation();
  return (
    <tr
      data-testid="artifact-scenario-output"
      data-parity={reading.parity}
      className="border-b border-rule-soft last:border-0"
    >
      <th scope="row" className="py-1.5 pr-3 text-left text-[12px] font-normal text-ink-soft">
        {artifactLabel(t, reading.labelKey)}
      </th>
      <td className="py-1.5 pl-3 text-right align-baseline">
        {reading.engineValue === null ? (
          <span className="font-mono text-ink-faint">{t("artifact.missing")}</span>
        ) : (
          <ScenarioValue value={reading.engineValue} reading={reading} className="text-ink-soft" />
        )}
      </td>
      <td className="py-1.5 pl-3 text-right align-baseline">
        {reading.value === null || reading.parity === "drift" ? (
          <span
            data-testid="artifact-scenario-withheld"
            className="font-mono text-[11px] text-caution"
          >
            {t("artifact.scenario.withheld")}
          </span>
        ) : (
          <ScenarioValue value={reading.value} reading={reading} className="text-ink" />
        )}
      </td>
    </tr>
  );
}

export interface ScenarioArtifactProps {
  spec: ScenarioSpec;
  evidence: CapsuleEvidence;
}

export function ScenarioArtifact({ spec, evidence }: ScenarioArtifactProps) {
  const { t } = useTranslation();

  // A driver whose fact the evidence does not carry is NOT offered.
  // A slider on nothing is worse than no slider: it invites a change
  // that cannot be computed and then shows the unchanged number.
  const drivers = useMemo(
    () =>
      spec.drivers
        .map((d) => ({ spec: d, def: driverDef(d.driver) }))
        .filter(
          (d): d is { spec: (typeof spec.drivers)[number]; def: NonNullable<ReturnType<typeof driverDef>> } =>
            d.def !== null && typeof evidence.facts[d.def.fact] === "number",
        ),
    [spec.drivers, evidence.facts],
  );

  const [positions, setPositions] = useState<Record<string, number>>(() =>
    restPositions(DRIVERS.map((d) => d.id)),
  );

  const reading = useMemo(
    () => evaluateScenario(evidence, spec.outputs, positions),
    [evidence, spec.outputs, positions],
  );

  const reset = useCallback(
    () => setPositions(restPositions(DRIVERS.map((d) => d.id))),
    [],
  );

  const anyMoved = drivers.some((d) => (positions[d.def.id] ?? AT_REST) !== AT_REST);

  if (drivers.length === 0) {
    return (
      <p data-testid="artifact-scenario-empty" className="py-4 text-[12px] text-ink-soft">
        {t("artifact.scenario.noDrivers")}
      </p>
    );
  }

  return (
    <div data-testid="artifact-scenario">
      <div className="space-y-2">
        {drivers.map(({ spec: ds, def }) => {
          const span = spanFor(ds.span);
          const pos = positions[def.id] ?? AT_REST;
          const base = evidence.facts[def.fact];
          const meta = evidence.factMeta[def.fact];
          return (
            <div key={def.id} className="flex items-center gap-3">
              <label
                htmlFor={`driver-${def.id}`}
                className="w-[132px] shrink-0 truncate font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-mute"
              >
                {artifactLabel(t, ds.label || def.labelKey)}
              </label>
              <input
                id={`driver-${def.id}`}
                data-testid="artifact-scenario-driver"
                type="range"
                min={span.min}
                max={span.max}
                step={span.step}
                value={pos}
                onChange={(e) =>
                  setPositions((p) => ({ ...p, [def.id]: Number(e.target.value) }))
                }
                className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-rule accent-brand"
              />
              <span
                className="w-[104px] shrink-0 text-right"
                data-fact={def.fact}
                data-unit={meta?.unit ?? ""}
                data-derived="lever"
              >
                <Amount
                  value={typeof base === "number" ? base * pos : null}
                  kind={amountKindFor(meta?.unit ?? "")}
                  currency={meta?.currency ?? null}
                  className="text-[12px] text-ink"
                />
              </span>
            </div>
          );
        })}
      </div>

      <table className="mt-3 w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-rule">
            <th scope="col" className="py-1.5 pr-3 text-left font-mono text-[10px] font-normal uppercase tracking-[0.06em] text-ink-mute">
              {t("artifact.scenario.output")}
            </th>
            <th scope="col" className="py-1.5 pl-3 text-right font-mono text-[10px] font-normal uppercase tracking-[0.06em] text-ink-mute">
              {t("artifact.scenario.engineValue")}
            </th>
            <th scope="col" className="py-1.5 pl-3 text-right font-mono text-[10px] font-normal uppercase tracking-[0.06em] text-ink-mute">
              {anyMoved ? t("artifact.scenario.output") : t("artifact.scenario.atRest")}
            </th>
          </tr>
        </thead>
        <tbody>
          {reading.outputs.map((o) => (
            <OutputRow key={o.id} reading={o} />
          ))}
        </tbody>
      </table>

      <div className="mt-2 flex items-center justify-between gap-3">
        <p
          data-testid="artifact-scenario-parity"
          data-parity-holds={reading.parityHolds ? "true" : "false"}
          data-verified-count={reading.verifiedCount}
          className={`text-[11px] ${reading.parityHolds ? "text-ink-mute" : "text-caution"}`}
        >
          {reading.verifiedCount === 0
            ? t("artifact.scenario.parityUnverifiable")
            : reading.parityHolds
              ? t("artifact.scenario.parityExact")
              : t("artifact.scenario.parityDrift")}
        </p>
        <button
          type="button"
          data-testid="artifact-scenario-reset"
          onClick={reset}
          disabled={!anyMoved}
          className="inline-flex items-center gap-1.5 rounded-sm border border-rule px-2 py-1 font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-soft transition-colors hover:text-ink disabled:opacity-40"
        >
          <RotateCcw size={11} aria-hidden="true" />
          {t("artifact.scenario.reset")}
        </button>
      </div>
    </div>
  );
}

export function scenarioFrom(
  spec: ScenarioSpec,
  evidence: CapsuleEvidence,
  trust: string | null = null,
): ResolvedArtifact {
  return { spec, citation: citationFrom(evidence, trust), unresolved: [] };
}
