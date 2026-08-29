// @vitest-environment jsdom
// Simple-mode context lines — deterministic, absent-in → no-line-out (M4 spirit).
import { describe, expect, it } from "vitest";

import {
  cashRunwayLine,
  debtCoverageLine,
  netDebtLine,
  profitLine,
  revenueYoyLine,
} from "../contextLines";

const en = { locale: "en" };
const ro = { locale: "ro" };

describe("context lines — deterministic templates", () => {
  it("cash runway computes months from the two facts", () => {
    // 17.7M cash, 260M annual costs → ≈ 0.8 months
    expect(cashRunwayLine(17_700_000, 260_000_000, en)).toBe(
      "≈ 0.8 months of your average costs.",
    );
    expect(cashRunwayLine(17_700_000, 260_000_000, ro)).toBe(
      "≈ 0,8 luni din costurile tale medii.",
    );
  });

  it("ABSENT input → NO line, never a guess", () => {
    expect(cashRunwayLine(null, 260_000_000, en)).toBeNull();
    expect(cashRunwayLine(17_700_000, null, en)).toBeNull();
    expect(cashRunwayLine(17_700_000, 0, en)).toBeNull();
    expect(revenueYoyLine(null, en)).toBeNull();
    expect(profitLine(undefined, en)).toBeNull();
    expect(debtCoverageLine(NaN, en)).toBeNull();
  });

  it("revenue YoY renders in words, both directions and flat", () => {
    expect(revenueYoyLine(0.06, en)).toBe("6.0% more than last year.");
    expect(revenueYoyLine(-0.121, ro)).toBe("Cu 12 % mai puțin decât anul trecut.".replace(" %", "%"));
    expect(revenueYoyLine(0.001, en)).toBe("About the same as last year.");
  });

  it("profit line states the sign honestly", () => {
    expect(profitLine(9_400_000, en)).toBe("The business made money this period.");
    expect(profitLine(-1, ro)).toBe("Afacerea a pierdut bani în această perioadă.");
    expect(profitLine(0, en)).toBe("The business broke even.");
  });

  it("debt coverage reads as years of earnings; net cash stated plainly", () => {
    expect(debtCoverageLine(1.52, en)).toBe("Net debt equals ≈ 1.5 years of typical earnings.");
    expect(debtCoverageLine(-0.3, en)).toBe("You hold more cash than debt.");
  });

  it("net debt explainer is static and jargon-free", () => {
    expect(netDebtLine(en)).toBe("What you'd owe after using all cash.");
  });
});
