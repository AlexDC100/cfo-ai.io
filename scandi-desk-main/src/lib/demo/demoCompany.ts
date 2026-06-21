// F6.1 (2026-06-21) — Demo company definition.
//
// A believable, FICTIONAL European mid-market food manufacturer used for the
// pre-upload demo experience. Every value is invented; there are NO real
// company names, numbers, or identifiers anywhere (verified by the discretion
// test in __tests__/f61.test.ts). When a user uploads real data the demo is
// replaced — see the SAMPLE_DATASETS injection path in src/data/sampleStatements.ts.

export interface DemoPeriodMeta {
  periodEnd: string;
  label: string;
}

export const DEMO_COMPANY = {
  name: "Meridian Industries SRL",
  industry: "Food & Beverage Manufacturing",
  industryId: "food_manufacturing",
  currency: "EUR",
  description: "Demo data · a fictional mid-market manufacturer",
  // Five years so Trend view + variance + scenarios all have history to work on.
  periods: [
    { periodEnd: "2021-12-31", label: "FY2021" },
    { periodEnd: "2022-12-31", label: "FY2022" },
    { periodEnd: "2023-12-31", label: "FY2023" },
    { periodEnd: "2024-12-31", label: "FY2024" },
    { periodEnd: "2025-12-31", label: "FY2025" },
  ] as DemoPeriodMeta[],
} as const;
