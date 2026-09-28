// PUBLIC COMPANIES — the filing's inventory days live under their own key
// and label, never as DIO (owner spec 2026-09-26 P1, design B4).
//
// On the repo's own captured AAPL envelope (fixtures/publicCompany): the
// public Ratios tab carries no `dio` row (a listed company has no served
// inventory-days block, and the company row refuses); in its place the
// reported-basis row `inventory_days_reported`, labelled "Zile stoc — bază
// raportată: stoc ÷ costul vânzărilor", ungraded. It refuses what the
// filing does not carry (the day count, an absent input) and, where the
// inputs are present, is exactly inventory ÷ cost of sales × days.

import { afterEach, describe, expect, it } from "vitest";

import i18n from "@/i18n";
import { computeRatios } from "@/lib/financialReport";
import { buildPublicStatements } from "@/lib/publicCompanyAdapters";
import type { PublicCompanyEnvelope } from "@/lib/publicCompanyApi";
import {
  PUBLIC_INVENTORY_DAYS_KEY,
  publicEfficiencyRows,
  publicReportedInventoryDays,
} from "@/lib/publicInventoryDays";

import envelopeJson from "./fixtures/publicCompany/aapl_envelope.json";

const statements = () => buildPublicStatements(envelopeJson as unknown as PublicCompanyEnvelope)!.statements;

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("the public Ratios tab's inventory row", () => {
  it("replaces the company dio with the reported-basis row under its own key", () => {
    const s = statements();
    const r = computeRatios(s);
    expect(r.efficiency.find((x) => x.key === "dio")!.value).toBeNull();
    const rows = publicEfficiencyRows(r.efficiency, s, "en");
    expect(rows.find((x) => x.key === "dio")).toBeUndefined();
    const row = rows.find((x) => x.key === PUBLIC_INVENTORY_DAYS_KEY)!;
    expect(row.label).toBe("Inventory days — reported basis: inventory ÷ cost of sales");
    expect(row.label).not.toMatch(/\bDIO\b/);
    expect(rows.length).toBe(r.efficiency.length);
  });

  it("carries the owner's Romanian label", () => {
    const row = publicReportedInventoryDays(statements(), "ro");
    expect(row.label).toBe("Zile stoc — bază raportată: stoc ÷ costul vânzărilor");
  });

  it("refuses without an established day count, and is inventory ÷ cost of sales × days with one", () => {
    const s = statements();
    const refused = publicReportedInventoryDays(s, "en");
    expect(refused.value).toBeNull();
    expect(refused.unavailable).toBeTruthy();
    const withDays = { ...s, supplementary: { ...s.supplementary, periodDays: 365 } };
    const row = publicReportedInventoryDays(withDays, "en");
    const declared = new Set(s.absentInputs ?? []);
    if (declared.has("inventory") || declared.has("costOfGoodsSold")) {
      expect(row.value).toBeNull();
      expect(JSON.stringify(row.unavailable)).toMatch(/inventory|costOfGoodsSold/);
    } else {
      expect(row.value).toBe((s.balanceSheet.inventory / (s.incomeStatement.costOfGoodsSold as number)) * 365);
      expect(row.verdict).toBe("ungraded");
    }
  });

  it("a planted filing with both inputs prints the reported-basis figure, ungraded", () => {
    const s = statements();
    const planted = {
      ...s,
      absentInputs: (s.absentInputs ?? []).filter((k) => k !== "inventory" && k !== "costOfGoodsSold"),
      balanceSheet: { ...s.balanceSheet, inventory: 100 },
      incomeStatement: { ...s.incomeStatement, costOfGoodsSold: 1000 },
      supplementary: { ...s.supplementary, periodDays: 365 },
    };
    const row = publicReportedInventoryDays(planted, "en");
    expect(row.value).toBeCloseTo(36.5, 10);
    expect(row.verdict).toBe("ungraded");
    expect(row.commentary).toContain("37");
  });
});
