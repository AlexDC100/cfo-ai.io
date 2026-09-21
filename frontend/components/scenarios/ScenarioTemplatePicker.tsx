// THE TEMPLATE PICKER — each template, and exactly what it changes.
//
// The templates are the ENGINE's (packs/scenarios/templates.yaml, FMCG
// Romania), served by GET /api/forecast/templates/scenarios and read through
// `lib/scenarioCatalogue`. The page sends a template's id to POST
// /api/forecast/{id}/scenario and the engine compiles it over this book. This
// component only shows the reader, before they pick, what each template
// declares: the driver a shock moves and the value it moves it by, in the
// display value the engine served.
//
// ── NO INDUSTRY WORD, AND NO POOL NAME ─────────────────────────────────
//
// An operating-cost shock is declared once over every cost pool the book
// serves (`pool_level.*`). It is shown as ONE line naming how many pools it
// covers — the count of the SERVED base plan's pool drivers — never as the
// pool keys: those are the engine's internal account groupings, and painting
// them would put accounting-plan words into page chrome that must carry no
// industry vocabulary at all (plan_contract_v2 8.6). Labels and questions are
// page chrome in the `scenarios` locale namespace.

import { useTranslation } from "react-i18next";

import {
  BASE_TEMPLATE_ID,
  signedDisplay,
  type CatalogueShock,
  type CatalogueTemplate,
} from "@/lib/scenarioCatalogue";

export interface ScenarioTemplatePickerProps {
  readonly templates: readonly CatalogueTemplate[];
  readonly selectedId: string;
  /** The driver keys the served base plan declares, or null before it is
   *  served — a pool pattern's count is then not known and is not guessed. */
  readonly servedDriverKeys: readonly string[] | null;
  onSelect(id: string): void;
}

function ShockLineText({
  shock,
  servedDriverKeys,
}: {
  shock: CatalogueShock;
  servedDriverKeys: readonly string[] | null;
}) {
  const { t } = useTranslation();
  const base = shock.pattern ? shock.driverKey.slice(0, -2) : shock.driverKey;
  const count =
    shock.pattern && servedDriverKeys
      ? servedDriverKeys.filter((k) => k.startsWith(`${base}.`)).length
      : 0;
  // A plain key may itself carry a dot (one named pool, `pool_level.<pool>`);
  // i18next reads a dot as nesting, so the locale key spells it `__`.
  const label = shock.pattern
    ? count > 0
      ? t(`scenarios.shock.${base}_count`, { count })
      : t(`scenarios.shock.${base}`)
    : t(`scenarios.shock.${base.replace(/\./g, "__")}`, base.replace(/[_.]/g, " "));
  const value = signedDisplay(shock.display.value);
  const valueText = t(`scenarios.unit.${shock.display.unit}`, { value, defaultValue: value });
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
  templates,
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
            "Each template is a named set of shocks the forecast engine applies to your plan. Pick one to see it beside the base plan.",
          )}
        </p>
      </header>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {templates.map((template) => {
          const selected = template.id === selectedId;
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
                  {t(`scenarios.template.${template.id}.name`, template.id.replace(/_/g, " "))}
                </span>
                <span className="mt-0.5 block text-[12px] leading-snug text-ink-soft">
                  {t(`scenarios.template.${template.id}.question`, "")}
                </span>
              </button>
              <div
                data-testid={`scenarios-template-${template.id}-changes`}
                className="mt-auto border-t border-rule-soft px-4 py-2"
              >
                <p className="font-mono text-[9.5px] uppercase tracking-wider text-ink-mute">
                  {t("scenarios.templates.changes", "What this template changes")}
                </p>
                {template.shocks.length === 0 ? (
                  <p className="mt-1 text-[12px] leading-snug text-ink-soft">
                    {t(
                      "scenarios.templates.noShocks",
                      "Nothing: the forecast itself, with only the levers you set below.",
                    )}
                  </p>
                ) : (
                  <ul className="mt-1 space-y-0.5 text-[12px] leading-snug">
                    {template.shocks.map((shock, i) => (
                      <li
                        key={`${shock.driverKey}-${i}`}
                        data-testid={`scenarios-template-${template.id}-shock-${i}`}
                        data-driver-key={shock.driverKey}
                        data-op={shock.op}
                        data-value={shock.value}
                      >
                        <ShockLineText shock={shock} servedDriverKeys={servedDriverKeys} />
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
