// F6.0.5 Phase 1 foundation (2026-06-20) — Pre-built scenario templates.
//
// The first-time UX problem: a blank scenario editor is overwhelming.
// Templates solve this by giving the user a starting point — pick a
// template, see meaningful numbers immediately, then customize.
//
// Four templates ship in Phase 1, covering the four most common
// modeling exercises for a Romanian SME CFO:
//   1. Recession — defensive scenario
//   2. Aggressive growth — investment scenario
//   3. Cost optimization — margin-improvement scenario
//   4. Covenant stress test — risk discovery
//
// Each template carries 3-5 adjustments. Targets are top-level concepts
// + drivers so they work on any baseline regardless of which fields are
// populated.

import type { Adjustment } from "./types";

export interface ScenarioTemplate {
  /** Stable key for picking the template programmatically. */
  key: string;
  name: string;
  description: string;
  /** Localized variants — for the future i18n-aware template gallery. */
  nameRo?: string;
  descriptionRo?: string;
  /** Adjustments to seed when the user picks this template. The store
   *  hydrates these with fresh ids + createdAt timestamps on use, so
   *  the canonical adjustments here intentionally use placeholder ids
   *  that the store will replace. */
  adjustments: Array<Omit<Adjustment, "id" | "createdAt">>;
}

export const SCENARIO_TEMPLATES: ScenarioTemplate[] = [
  {
    key: "recession",
    name: "Recession scenario",
    nameRo: "Scenariu de recesiune",
    description:
      "Revenue contracts 20%, OpEx trimmed 5%, customer payments slow by 30 days. Pressure-tests liquidity and covenants under a real downturn.",
    descriptionRo:
      "Cifra de afaceri scade 20%, OpEx redus 5%, clienții plătesc cu 30 de zile întârziere. Testează lichiditatea și covenanții sub o recesiune reală.",
    adjustments: [
      {
        target: { type: "concept", conceptKey: "revenue" },
        operation: { type: "pct_change", value: -0.2 },
        note: "Top-line decline driven by demand contraction",
      },
      {
        target: { type: "concept", conceptKey: "opex" },
        operation: { type: "pct_change", value: -0.05 },
        note: "Modest cost discipline — won't offset revenue hit",
      },
      {
        target: { type: "driver", driverKey: "dso_days" },
        operation: { type: "set_driver", driverValue: 90 },
        note: "Customer payment behaviour weakens to 90-day average",
      },
    ],
  },
  {
    key: "aggressive_growth",
    name: "Aggressive growth",
    nameRo: "Creștere agresivă",
    description:
      "Revenue +25%, CAPEX +50% to fund capacity, OpEx +15% for hiring. Tests whether the balance sheet can absorb the investment cycle.",
    descriptionRo:
      "Cifra de afaceri +25%, CAPEX +50% pentru capacitate, OpEx +15% pentru angajări. Testează dacă bilanțul poate susține ciclul investițional.",
    adjustments: [
      {
        target: { type: "concept", conceptKey: "revenue" },
        operation: { type: "pct_change", value: 0.25 },
      },
      {
        target: { type: "concept", conceptKey: "capex" },
        operation: { type: "pct_change", value: 0.5 },
      },
      {
        target: { type: "concept", conceptKey: "opex" },
        operation: { type: "pct_change", value: 0.15 },
      },
    ],
  },
  {
    key: "cost_optimization",
    name: "Cost optimization",
    nameRo: "Optimizare costuri",
    description:
      "Revenue flat, OpEx −15%, inventory days down to 60. Pure margin-and-working-capital play.",
    descriptionRo:
      "Cifra de afaceri stabilă, OpEx −15%, zile de stoc reduse la 60. Joc pur de marjă și capital de lucru.",
    adjustments: [
      {
        target: { type: "concept", conceptKey: "opex" },
        operation: { type: "pct_change", value: -0.15 },
      },
      {
        target: { type: "driver", driverKey: "dio_days" },
        operation: { type: "set_driver", driverValue: 60 },
      },
    ],
  },
  {
    key: "covenant_stress_test",
    name: "Covenant stress test",
    nameRo: "Test de stres covenanți",
    description:
      "Revenue −30% with no cost offset. The 'how bad does it have to get before covenants break' baseline.",
    descriptionRo:
      "Cifra de afaceri −30% fără ajustări de cost. Baza pentru 'cât de rău trebuie să devină până se sparg covenanții'.",
    adjustments: [
      {
        target: { type: "concept", conceptKey: "revenue" },
        operation: { type: "pct_change", value: -0.3 },
        note: "Worst-case revenue decline; no operational response",
      },
    ],
  },
];

/** Look up a template by key. Returns undefined for unknown keys —
 *  caller's job to handle the empty case (e.g. fall through to a
 *  blank scenario). */
export function getScenarioTemplate(key: string): ScenarioTemplate | undefined {
  return SCENARIO_TEMPLATES.find((t) => t.key === key);
}
