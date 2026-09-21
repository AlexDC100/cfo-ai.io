// THE TEMPLATE PICKER — each template, and exactly what it changes.
//
// plan/2 B13 (minimal cut). A template is a named set of shocks the page
// POSTs to the forecast engine (`lib/scenarioTemplates`). This component
// shows the reader that set, line by line, before they pick it: the driver
// the shock moves, and the value it moves it by, as the template declares it.
//
// ── NO INDUSTRY WORD, AND NO POOL NAME ─────────────────────────────────
//
// An operating-cost shock is declared once over every cost pool the book
// serves (`pool_level.*`). It is shown as ONE line naming how many pools it
// covers, never as the pool keys: those are the engine's internal account
// groupings, and painting them would put accounting-plan words into page
// chrome that must carry no industry vocabulary at all (plan_contract_v2 8.6).
// Labels and questions are page chrome in the `scenarios` locale namespace.

import { useTranslation } from "react-i18next";

import {
  BASE_TEMPLATE_ID,
  SCENARIO_TEMPLATES,
  compileTemplate,
  declaredLines,
  shockValueText,
  type ShockLine,
} from "@/lib/scenarioTemplates";

export interface ScenarioTemplatePickerProps {
  readonly selectedId: string;
  /** The driver keys the served base plan declares, or null before it is
   *  served — a pool pattern's count is then not known and is not guessed. */
  readonly servedDriverKeys: readonly string[] | null;
  onSelect(id: string): void;
}

function ShockLineText({ line }: { line: ShockLine }) {
  const { t } = useTranslation();
  const base = line.pattern ? line.driverKey.slice(0, -2) : line.driverKey;
  const label = line.pattern
    ? line.expandedOver > 0
      ? t(`scenarios.shock.${base}_count`, { count: line.expandedOver })
      : t(`scenarios.shock.${base}`)
    : t(`scenarios.shock.${base}`, base.replace(/_/g, " "));
  const value = shockValueText(line.op, line.value);
  const valueText =
    value === null
      ? line.value
      : t(`scenarios.op.${line.op}`, { value, defaultValue: value });
  return (
    <>
      <span className="text-ink">{label}</span>
      <span className="ml-1 whitespace-nowrap font-medium tabular-nums text-ink">
        {valueText}
      </span>
    </>
  );
}

export function ScenarioTemplatePicker({
  selectedId,
  servedDriverKeys,
  onSelect,
}: ScenarioTemplatePickerProps) {
  const { t } = useTranslation();
  return (
    <section data-testid="scenarios-templates" className="space-y-2">
      <header className="px-1">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-ink-mute">
          {t("scenarios.templates.title", "Templates")}
        </h2>
        <p className="mt-1 text-[12px] leading-snug text-ink-soft">
          {t(
            "scenarios.templates.lead",
            "Each template is a named set of shocks sent to the forecast engine. Pick one to see it beside the base plan.",
          )}
        </p>
      </header>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {SCENARIO_TEMPLATES.map((template) => {
          const selected = template.id === selectedId;
          const lines =
            servedDriverKeys === null
              ? declaredLines(template)
              : compileTemplate(template, servedDriverKeys).lines;
          return (
            <div
              key={template.id}
              data-testid={`scenarios-template-card-${template.id}`}
              data-selected={selected ? "true" : "false"}
              className={`flex min-w-0 flex-col rounded-xl border bg-surface transition-colors ${
                selected ? "border-brand ring-1 ring-brand/40" : "border-rule"
              }`}
            >
              <button
                type="button"
                data-testid={`scenarios-template-${template.id}`}
                aria-pressed={selected}
                onClick={() => onSelect(template.id)}
                className="px-4 pt-3 pb-2 text-left hover:bg-bg-2/40 rounded-t-xl"
              >
                <span className="block text-[13.5px] font-medium text-ink">
                  {t(`scenarios.template.${template.id}.name`)}
                </span>
                <span className="mt-0.5 block text-[12px] leading-snug text-ink-soft">
                  {t(`scenarios.template.${template.id}.question`)}
                </span>
              </button>
              <div
                data-testid={`scenarios-template-${template.id}-changes`}
                className="mt-auto border-t border-rule-soft px-4 py-2"
              >
                <p className="font-mono text-[9.5px] uppercase tracking-wider text-ink-mute">
                  {t("scenarios.templates.changes", "What this template changes")}
                </p>
                {lines.length === 0 ? (
                  <p className="mt-1 text-[12px] leading-snug text-ink-soft">
                    {t(
                      "scenarios.templates.noShocks",
                      "Nothing: the engine's own plan, with only the levers you set below.",
                    )}
                  </p>
                ) : (
                  <ul className="mt-1 space-y-0.5 text-[12px] leading-snug">
                    {lines.map((line, i) => (
                      <li
                        key={`${line.driverKey}-${i}`}
                        data-testid={`scenarios-template-${template.id}-shock-${i}`}
                        data-driver-key={line.driverKey}
                        data-op={line.op}
                        data-value={line.value}
                      >
                        <ShockLineText line={line} />
                      </li>
                    ))}
                  </ul>
                )}
                {template.id !== BASE_TEMPLATE_ID ? (
                  <p className="mt-1.5 text-[11px] leading-snug text-ink-mute">
                    {t(`scenarios.template.${template.id}.note`, "")}{" "}
                    {t(
                      "scenarios.templates.window",
                      "Every shock runs from the first plan month to the end of the plan.",
                    )}
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default ScenarioTemplatePicker;
