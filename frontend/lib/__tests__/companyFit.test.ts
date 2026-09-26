// company-fit — the rent-only DSCR question is a property company's
// question (design C3). "Rental" is READ: the workspace's industry key, or
// the engine's structural signal DECIDED on real estate. Unknown is not
// rental.
//
// WHAT IT REDS ON, AFTER THE REPAIR (TC-11): a manufacturer (the committed
// Scandia and Agras bodies read as manufacturing) classified rental; an
// undecided signal treated as decided; the industry key ignored.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isRentalCompany } from "../companyFit";

const REPO = resolve(__dirname, "../../..");
const body = (name: string) =>
  JSON.parse(readFileSync(resolve(REPO, `e2e/fixtures/workspace_v2/${name}_fy2025.json`), "utf-8")).period;

describe("isRentalCompany", () => {
  it("the committed manufacturers are not rental — on their own served signal", () => {
    for (const name of ["scandia", "agras"]) {
      const b = body(name);
      expect(b.industry_signal.family).toBe("manufacturing");
      expect(isRentalCompany({ industryKey: b.organization.industry_key, industrySignal: b.industry_signal })).toBe(false);
    }
  });
  it("the workspace's own real-estate key makes it rental", () => {
    expect(isRentalCompany({ industryKey: "real_estate" })).toBe(true);
    expect(isRentalCompany({ industryKey: "real_estate_residential" })).toBe(true);
  });
  it("the engine's signal counts only when DECIDED on real estate", () => {
    expect(isRentalCompany({ industrySignal: { family: "real_estate", verdict: "decided" } })).toBe(true);
    expect(isRentalCompany({ industrySignal: { family: "real_estate", verdict: "undetermined" } })).toBe(false);
    expect(isRentalCompany({ industrySignal: { family: "trade", verdict: "decided" } })).toBe(false);
  });
  it("unknown is not rental", () => {
    expect(isRentalCompany({})).toBe(false);
    expect(isRentalCompany({ industryKey: null, industrySignal: null })).toBe(false);
  });
});
