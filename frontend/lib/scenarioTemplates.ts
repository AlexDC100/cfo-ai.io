// SCENARIO TEMPLATES — named lever sets, sent to the forecast engine as they
// are declared (plan/2 B13, minimal cut; plan_contract_v2 2.4, 8.3).
//
// ── ONE ENGINE ─────────────────────────────────────────────────────────
//
// A template is NOT a calculation. It is a list of shocks in the engine's own
// vocabulary (packs/forecast/levers.yaml#registry: driver_key, op, value) that
// the page POSTs to /api/forecast/{period_id}/recompute. Every figure the page
// then shows is read out of the served response through `lib/forecastFacts`.
// The page's old client cascade held cost of sales flat under a revenue move
// and let cash run negative (defects 0.1 and 0.3); the engine carries cost of
// sales with volume, holds other operating income, floors cash and draws a
// priced funding line. This module decides only WHICH shocks are sent.
//
// ── WHAT THIS MODULE DOES ──────────────────────────────────────────────
//
//   · reads the declared sets from `scenarioTemplates.json` (data, not code:
//     tests/engine/test_scenario_page_templates.py runs the same file through
//     the engine on the four corpus books);
//   · expands a `<prefix>.*` driver key over the driver keys the SERVED
//     response declares (pool_level.* = every operating-cost pool this book
//     serves). A pattern that matches nothing refuses the template by name —
//     applying the rest of it would be a partial template shown under the
//     whole template's name (8.3: never applied as zero impact);
//   · mints the shock ids and sources the contract reserves for templates
//     (`template:<id>:<n>`, source `template:<id>`, 2.4);
//   · renders a shock's declared value for the reader by exact string
//     arithmetic. That is the TEMPLATE'S input, shown as written — never a
//     served figure.

import data from "./scenarioTemplates.json";
import { exactDecimal } from "@/lib/forecastFacts";
import { parseDecimal } from "@/lib/forecastLevers";

/** One declared shock, as the data file writes it. */
export interface TemplateShockSpec {
  readonly driver_key: string;
  readonly op: string;
  readonly value: string;
}

export interface ScenarioTemplate {
  readonly id: string;
  readonly shocks: readonly TemplateShockSpec[];
}

export const SCENARIO_TEMPLATES: readonly ScenarioTemplate[] = (
  data as { templates: ScenarioTemplate[] }
).templates;

/** The template with no shocks: the engine's own plan. */
export const BASE_TEMPLATE_ID = "base";

/** The months of plan year one the page asks the engine for. Contract 2.2:
 *  the Scenarios page sends monthly_months and OMITS total_years, which the
 *  engine fills from packs/forecast/levers.yaml#scenarios.total_years — the
 *  page learns the plan length from the served horizon labels. */
export const SCENARIO_MONTHLY_MONTHS = 12;

/** A shock on the wire (plan_contract_v2 2.1). Every template shock starts in
 *  the first plan month, has no ramp and never ends — stated here once, so
 *  the page's "from the first plan month to the end of the plan" is true by
 *  construction. */
export interface WireShock {
  readonly id: string;
  readonly driver_key: string;
  readonly op: string;
  readonly value: string;
  readonly start_month: 1;
  readonly ramp_months: 0;
  readonly end_month: null;
  readonly source: string;
  readonly group_id: string | null;
}

/** One declared shock as the reader sees it: the declared key (a pattern
 *  stays a pattern — pool names are never painted), and how many served keys
 *  it expanded over. */
export interface ShockLine {
  readonly driverKey: string;
  readonly op: string;
  readonly value: string;
  /** Served keys the declared key stands for; 1 for a plain key. */
  readonly expandedOver: number;
  readonly pattern: boolean;
}

export type CompiledTemplate =
  | {
      readonly ok: true;
      readonly template: ScenarioTemplate;
      readonly shocks: readonly WireShock[];
      readonly lines: readonly ShockLine[];
    }
  | {
      readonly ok: false;
      readonly template: ScenarioTemplate;
      /** The declared pattern that matched no served driver key. */
      readonly unmatched: string;
      readonly lines: readonly ShockLine[];
    };

const isPattern = (key: string) => key.endsWith(".*");
const prefixOf = (key: string) => key.slice(0, -1);

/** The declared lines of a template before any response has been read: a
 *  pattern's served count is not known yet, and says so (0). */
export function declaredLines(template: ScenarioTemplate): ShockLine[] {
  return template.shocks.map((s) => ({
    driverKey: s.driver_key,
    op: s.op,
    value: s.value,
    expandedOver: isPattern(s.driver_key) ? 0 : 1,
    pattern: isPattern(s.driver_key),
  }));
}

/** The template's wire shocks over the driver keys ONE served response
 *  declares, in served order. */
export function compileTemplate(
  template: ScenarioTemplate,
  servedDriverKeys: readonly string[],
): CompiledTemplate {
  const shocks: WireShock[] = [];
  const lines: ShockLine[] = [];
  let n = 0;
  for (const spec of template.shocks) {
    const pattern = isPattern(spec.driver_key);
    const keys = pattern
      ? servedDriverKeys.filter((k) => k.startsWith(prefixOf(spec.driver_key)))
      : [spec.driver_key];
    lines.push({
      driverKey: spec.driver_key,
      op: spec.op,
      value: spec.value,
      expandedOver: keys.length,
      pattern,
    });
    if (keys.length === 0) {
      return { ok: false, template, unmatched: spec.driver_key, lines };
    }
    for (const key of keys) {
      n += 1;
      shocks.push({
        id: `template:${template.id}:${n}`,
        driver_key: key,
        op: spec.op,
        value: spec.value,
        start_month: 1,
        ramp_months: 0,
        end_month: null,
        source: `template:${template.id}`,
        // One lever to the engine's contribution runs: the whole pool group
        // moves together, as the template declares it.
        group_id: pattern
          ? `template:${template.id}:${prefixOf(spec.driver_key).replace(/\.$/, "")}`
          : null,
      });
    }
  }
  return { ok: true, template, shocks, lines };
}

/** The POST body (plan_contract_v2 2.1): horizon without total_years (2.2),
 *  the reader's lever overrides, and the template's shocks. */
export function scenarioRequestBody(
  overrides: Record<string, { values: (string | null)[] }>,
  shocks: readonly WireShock[],
): Record<string, unknown> {
  return {
    horizon: { monthly_months: SCENARIO_MONTHLY_MONTHS },
    overrides,
    shocks: shocks.map((s) => ({ ...s })),
  };
}

/** A declared shock value as the reader reads it: a level change as a signed
 *  percent ("−20"), a days change as signed days ("+15"). Exact string
 *  arithmetic at a micro scale, never `Number(value) * 100` — this is the
 *  template's own input and it is shown exactly as it is sent. `null` when
 *  the value is not a plain decimal (the engine would refuse it too). */
export function shockValueText(op: string, value: string): string | null {
  const micros = parseDecimal(value, 1_000_000);
  if (micros === null) return null;
  const sign = micros < 0 ? "−" : micros > 0 ? "+" : "";
  const abs = Math.abs(micros);
  if (op === "level_pct") return `${sign}${exactDecimal(abs, 10_000)}`;
  return `${sign}${exactDecimal(abs, 1_000_000)}`;
}
