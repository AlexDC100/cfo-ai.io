// PUBLIC COMPANIES — INVENTORY DAYS ON THE FILING'S REPORTED BASIS, under
// their own key (owner spec 2026-09-26 P1, design B4 "namespaced
// exemptions").
//
// A listed company's filing carries one inventory balance and a cost of
// sales — no trial balance, so no split by stock type and no served
// `inventory_days` block. The company dashboard's `dio` row therefore
// refuses for it (lib/inventoryDays: no block, no figure). What the filing
// DOES support is stock ÷ cost of sales × the period's days: a different
// measure, printed under its own key and label ("zile stoc — bază
// raportată: stoc ÷ costul vânzărilor"), never under the name DIO and
// never graded on the company ladder.
//
// Absent-aware: an input the filing does not report, or a period whose day
// count is not established, refuses with its reason (lib/absentAware).

import i18n from "@/i18n";

import { absent, div, mul, num, type Fig } from "./absentAware";
import type { Ratio, Statements } from "./financialReport";

export const PUBLIC_INVENTORY_DAYS_KEY = "inventory_days_reported";

/** The row the public Ratios tab prints in place of the company `dio`. */
export function publicReportedInventoryDays(s: Statements, lang?: string | null): Ratio {
  const t = i18n.getFixedT((lang ?? i18n.language ?? "en").toLowerCase().startsWith("ro") ? "ro" : "en");
  const declared = new Set<string>(s.absentInputs ?? []);
  const inventory: Fig = declared.has("inventory") ? absent("inventory") : num("inventory", s.balanceSheet.inventory);
  const costOfSales: Fig = declared.has("costOfGoodsSold")
    ? absent("costOfGoodsSold")
    : num("costOfGoodsSold", s.incomeStatement.costOfGoodsSold);
  const days = num("periodDays", s.supplementary?.periodDays ?? null);
  const fig = mul(div(inventory, costOfSales, "cost of sales"), days);
  return {
    key: PUBLIC_INVENTORY_DAYS_KEY,
    label: t("publicCompany.inventoryDaysReported.label"),
    formula: t("publicCompany.inventoryDaysReported.formula"),
    value: fig.value,
    unit: "days",
    verdict: fig.value === null ? "unknown" : "ungraded",
    benchmark: t("publicCompany.inventoryDaysReported.benchmark"),
    ...(fig.absence ? { unavailable: fig.absence } : {}),
    commentary:
      fig.value === null ? "" : t("publicCompany.inventoryDaysReported.commentary", { days: fig.value.toFixed(0) }),
  };
}

/** The public Ratios tab's efficiency rows: the company `dio` (which has no
 *  served block to read for a listed company) replaced by the reported-basis
 *  row under its own key. */
export function publicEfficiencyRows(rows: readonly Ratio[], s: Statements, lang?: string | null): Ratio[] {
  return rows.map((r) => (r.key === "dio" ? publicReportedInventoryDays(s, lang) : r));
}
