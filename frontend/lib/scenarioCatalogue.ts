// THE SCENARIO TEMPLATE CATALOGUE, as the engine serves it
// (forecast-scenarios-live).
//
// The templates are ENGINE pack data — packs/scenarios/templates.yaml, FMCG
// Romania — served by GET /api/forecast/templates/scenarios. The page no
// longer carries a template file, compiles no shock and expands no pattern:
// it sends a template ID to POST /api/forecast/{id}/scenario and the engine
// compiles it over the book (engine.forecast.scenario_templates). This module
// only READS the served catalogue, strictly, and builds the request body.
//
// A shock's display value arrives computed by the engine in exact decimals
// ("-20" percent, "30" days); the page prints that string with a sign and a
// unit and does no arithmetic of its own.

/** The template with no shock: the forecast itself (gate F4). */
export const BASE_TEMPLATE_ID = "base";

/** The Scenarios horizon: the Forecast page's own default (five plan years,
 *  the first one monthly), so the base column is exactly the forecast the
 *  Forecast page opens on. */
export const SCENARIO_HORIZON = { total_years: 5, monthly_months: 12 } as const;

export type DisplayUnit = "percent" | "days" | "percentage_points";

export interface CatalogueShock {
  readonly driverKey: string;
  readonly op: string;
  /** The exact decimal the pack declares, in the driver's own unit. */
  readonly value: string;
  /** A `<prefix>.*` key the engine expands over the pools a book serves. */
  readonly pattern: boolean;
  readonly display: { readonly unit: DisplayUnit; readonly value: string };
}

export interface CatalogueTemplate {
  readonly id: string;
  readonly shocks: readonly CatalogueShock[];
}

export interface ScenarioCatalogue {
  readonly packId: string;
  readonly templates: readonly CatalogueTemplate[];
}

const UNITS: readonly DisplayUnit[] = ["percent", "days", "percentage_points"];
const DECIMAL = /^-?\d+(\.\d+)?$/;

/** The served catalogue, or null when the body is not one: a malformed
 *  catalogue renders no template at all rather than half of one. */
export function readCatalogue(raw: unknown): ScenarioCatalogue | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.pack_id !== "string" || !Array.isArray(rec.templates)) return null;
  const templates: CatalogueTemplate[] = [];
  for (const t of rec.templates) {
    if (!t || typeof t !== "object") return null;
    const tr = t as Record<string, unknown>;
    if (typeof tr.id !== "string" || !Array.isArray(tr.shocks)) return null;
    const shocks: CatalogueShock[] = [];
    for (const s of tr.shocks) {
      if (!s || typeof s !== "object") return null;
      const sr = s as Record<string, unknown>;
      const display = sr.display as Record<string, unknown> | undefined;
      if (
        typeof sr.driver_key !== "string" ||
        typeof sr.op !== "string" ||
        typeof sr.value !== "string" ||
        !DECIMAL.test(sr.value) ||
        !display ||
        !UNITS.includes(display.unit as DisplayUnit) ||
        typeof display.value !== "string" ||
        !DECIMAL.test(display.value)
      ) {
        return null;
      }
      shocks.push({
        driverKey: sr.driver_key,
        op: sr.op,
        value: sr.value,
        pattern: sr.pattern === true,
        display: { unit: display.unit as DisplayUnit, value: display.value },
      });
    }
    templates.push({ id: tr.id, shocks });
  }
  if (!templates.some((t) => t.id === BASE_TEMPLATE_ID)) return null;
  return { packId: rec.pack_id, templates };
}

/** A served display value with its sign as the reader reads it: "−20",
 *  "+30". The digits are the engine's; only the sign glyph is chosen here. */
export function signedDisplay(value: string): string {
  if (value.startsWith("-")) return `−${value.slice(1)}`;
  return /^0+(\.0+)?$/.test(value) ? value : `+${value}`;
}

/** POST /api/forecast/{id}/scenario: the template id, the Scenarios horizon
 *  and the reader's lever overrides. No shock, no number of the page's own. */
export function scenarioRequestBody(
  templateId: string,
  overrides: Record<string, { values: (string | null)[] }>,
): Record<string, unknown> {
  return {
    template: templateId,
    horizon: { ...SCENARIO_HORIZON },
    overrides,
  };
}
